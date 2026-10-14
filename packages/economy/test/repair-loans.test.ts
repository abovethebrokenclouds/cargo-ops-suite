// Insurer repair loans (plan §7.4 "repossession-free repair loans", docs/ECONOMY.md
// "Insurer repair loans"): the eligibility rule matrix, the terms, and the company book —
// disbursement, auto-debit on the month boundary, three misses (policy cancelled, balance
// moved to cash, no repossession, no default flag), early payoff, sale, cancellation and
// the write-off netting. Every scenario checks Σ ledger = cash − starting cash to the cent.

import { describe, expect, it } from "vitest";
import { aircraftTypeByKey, type AircraftStatus, type Defect } from "@cargo-ops/protocol";
import {
  CompanyBook,
  GAME_MONTH_MS,
  REPAIR_LOAN,
  airportLookup,
  amortisationSchedule,
  newCompanyCore,
  repairCost,
  repairLoanBill,
  repairLoanCheck,
  repairLoanTerms,
  type BookLedgerEntry,
  type BookNotice,
  type CompanyCore,
  type FlightSettlement,
  type RepairLoanCheckInput,
} from "../src";
import { bundledAirports } from "./airports";

const lookup = airportLookup(bundledAirports());
const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const c208 = aircraftTypeByKey("c208b")!;
const cents = (n: number) => Math.round(n * 100);

// ---------------------------------------------------------------------------------------
// Rule matrix (pure)

const base: RepairLoanCheckInput = {
  ownership: "owned",
  status: "available",
  insured: true,
  openRepairLoan: false,
  bill: 10_000,
  principal: 10_000,
  termMonths: 12,
};

describe("repair loan eligibility: rule matrix", () => {
  const rows: Array<[string, Partial<RepairLoanCheckInput>, string | null]> = [
    ["eligible: insured, owned, available, amount = bill", {}, null],
    ["eligible: amount below the bill", { principal: 2_500 }, null],
    ["eligible: in maintenance (a defect repair queues behind)", { status: "maintenance" }, null],
    ["eligible: shortest term", { termMonths: REPAIR_LOAN.minTermMonths }, null],
    ["eligible: longest term", { termMonths: REPAIR_LOAN.maxTermMonths }, null],
    ["eligible: the minimum amount", { principal: REPAIR_LOAN.minAmount }, null],
    ["dry lease is not owned", { ownership: "dry_lease" }, "not_owned"],
    ["wet lease is not owned", { ownership: "wet_lease" }, "not_owned"],
    ["hired aircraft is locked (#39)", { status: "hired" }, "aircraft_busy"],
    ["in flight", { status: "in_flight" }, "aircraft_busy"],
    ["no active policy", { insured: false }, "not_insured"],
    ["one open repair loan per aircraft", { openRepairLoan: true }, "repair_loan_open"],
    ["nothing to repair", { bill: 0 }, "no_repair_bill"],
    ["term below 6 months", { termMonths: 5 }, "bad_term"],
    ["term above 24 months", { termMonths: 25 }, "bad_term"],
    ["fractional term", { termMonths: 12.5 }, "bad_term"],
    ["below the minimum amount", { principal: 499.99, bill: 499.99 }, "bad_principal"],
    ["more than the bill", { principal: 10_000.01 }, "exceeds_bill"],
    // Precedence: the first failing rule wins, in the order of the table above.
    [
      "leased and uninsured → not_owned first",
      { ownership: "dry_lease", insured: false },
      "not_owned",
    ],
    [
      "hired and uninsured → aircraft_busy first",
      { status: "hired", insured: false },
      "aircraft_busy",
    ],
    [
      "uninsured with an open loan → not_insured first",
      { insured: false, openRepairLoan: true },
      "not_insured",
    ],
    [
      "open loan and a bad term → repair_loan_open first",
      { openRepairLoan: true, termMonths: 99 },
      "repair_loan_open",
    ],
    [
      "bad term and over the bill → bad_term first",
      { termMonths: 2, principal: 99_999 },
      "bad_term",
    ],
  ];
  for (const [name, patch, code] of rows) {
    it(name, () => {
      const r = repairLoanCheck({ ...base, ...patch });
      if (code === null) expect(r).toEqual({ ok: true });
      else expect(r).toMatchObject({ ok: false, code });
    });
  }

  it("every refusal carries a message", () => {
    for (const [, patch, code] of rows) {
      const r = repairLoanCheck({ ...base, ...patch });
      if (code !== null && !r.ok) expect(r.message.length).toBeGreaterThan(10);
    }
  });
});

describe("repair loan terms", () => {
  it("fixed 4 % APR, below every bank's minimum, 6–24 months, no origination fee", () => {
    expect(REPAIR_LOAN.apr).toBe(4);
    expect(REPAIR_LOAN.apr).toBeLessThan(5.5);
    expect([REPAIR_LOAN.minTermMonths, REPAIR_LOAN.maxTermMonths]).toEqual([6, 24]);
  });

  it("bill = cost − incident claim, never negative", () => {
    expect(repairLoanBill(19_440, 13_952)).toBe(5_488);
    expect(repairLoanBill(173_880, 0)).toBe(173_880);
    expect(repairLoanBill(1_000, 2_000)).toBe(0);
  });

  it("$150,000 over 24 months: payment $6,513.74, interest $6,329.70 (integer-cent reference)", () => {
    const t = repairLoanTerms(150_000, 24);
    expect(t).toEqual({ apr: 4, payment: 6_513.74, totalInterest: 6_329.7 });
    // Independent reference: integer cents, r = 4 % / 12.
    let bal = 15_000_000;
    let interest = 0;
    const rows = amortisationSchedule(150_000, 4, 24);
    for (let m = 1; m <= 24; m++) {
      const i = Math.round((bal * 4) / 100 / 12);
      const due = m === 24 ? bal + i : Math.min(651_374, bal + i);
      bal -= due - i;
      interest += i;
      expect(cents(rows[m - 1]!.payment)).toBe(due);
      expect(cents(rows[m - 1]!.interest)).toBe(i);
    }
    expect(bal).toBe(0);
    expect(interest).toBe(632_970);
  });

  it("$5,488 over 12 months: payment $467.30, interest $119.63", () => {
    expect(repairLoanTerms(5_488, 12)).toEqual({ apr: 4, payment: 467.3, totalInterest: 119.63 });
  });
});

// ---------------------------------------------------------------------------------------
// Company book

interface Rig {
  book: CompanyBook;
  ledger: BookLedgerEntry[];
  notices: BookNotice[];
  drain(): void;
  balanced(): void;
}

function rig(cash: number, overrides: Partial<CompanyCore> = {}): Rig {
  const company: CompanyCore = {
    name: "Test Air",
    base: "KMEM",
    seed: 4242,
    cash,
    reputation: 50,
    ...newCompanyCore(cash),
    ...overrides,
  };
  const book = new CompanyBook({ company, airports: lookup, now: () => NOW });
  const ledger: BookLedgerEntry[] = [];
  const notices: BookNotice[] = [];
  const r: Rig = {
    book,
    ledger,
    notices,
    drain() {
      const d = book.drain();
      ledger.push(...d.ledger);
      notices.push(...d.notices);
    },
    balanced() {
      r.drain();
      const sum = ledger.reduce((s, e) => s + cents(e.amount), 0);
      expect(sum).toBe(cents(book.company.cash) - cents(book.company.startingCash));
      // The running balance of the last row is the cash.
      if (ledger.length) expect(ledger.at(-1)!.balance).toBe(book.company.cash);
    },
  };
  return r;
}

/** Starter C208B at 19.5 % (overhaul $173,880), insured. */
function wornInsured(cash: number) {
  const r = rig(cash);
  const a = r.book.ensureStarter()!;
  r.book.updateAircraft(a.id, { condition: 19.5 });
  expect(repairCost(c208, 19.5)).toBe(173_880);
  const ins = r.book.buyInsurance(a.id);
  if (!ins.ok) throw new Error(ins.message);
  r.drain();
  return { ...r, id: a.id };
}

const gearDefect: Defect = {
  id: "AC-1-D9",
  system: "gear",
  severity: "major",
  title: "Bent gear leg",
  repairCost: 19_440,
  downtimeHours: 24,
  hidden: false,
  cause: "hard_landing",
};

function rows(entries: readonly BookLedgerEntry[]) {
  return entries.map((e) => [e.category, e.amount]);
}

describe("repair loans in the company book", () => {
  it("finances an overhaul: disbursement, repair, no fee; auto-debits on the month boundary", () => {
    const r = wornInsured(100_000);
    const cashBefore = r.book.company.cash;
    const res = r.book.repairLoan({
      aircraftId: r.id,
      repair: "overhaul",
      principal: 150_000,
      termMonths: 24,
    });
    if (!res.ok) throw new Error(res.message);
    expect(res.data.bill).toBe(173_880);
    expect(res.data.claim).toBe(0);
    expect(res.data.loan).toMatchObject({
      kind: "repair",
      lenderId: "insurer",
      apr: 4,
      payment: 6_513.74,
      balance: 150_000,
      collateral: { type: "aircraft", id: r.id },
      orderId: res.data.order.id,
      status: "active",
    });
    r.drain();
    expect(rows(r.ledger.slice(-2))).toEqual([
      ["repair_loan_disbursement", 150_000],
      ["repair", -173_880],
    ]);
    expect(r.book.company.cash).toBe(cashBefore + 150_000 - 173_880);
    // No lien: the aircraft stays unencumbered for a bank (its loanId is the bank's).
    expect(r.book.aircraft(r.id)?.loanId).toBeNull();
    // Debt and the fleet view include it.
    expect(r.book.debt()).toBe(150_000);
    const ins = r.book.insuranceState(r.book.aircraft(r.id)!);
    expect(ins.repairLoan?.open).toMatchObject({ loanId: res.data.loan.id, balance: 150_000 });
    // Month 1: interest $500.00, principal $6,013.74 → $143,986.26.
    r.book.advance(GAME_MONTH_MS);
    r.drain();
    const loanRows = r.ledger.filter((e) => e.refId === res.data.loan.id);
    expect(rows(loanRows.slice(-2))).toEqual([
      ["interest", -500],
      ["repair_loan_payment", -6_013.74],
    ]);
    expect(r.book.loans.get(res.data.loan.id)?.balance).toBe(143_986.26);
    expect(r.notices.map((n) => n.name)).toContain("loan.payment");
    r.balanced();
  });

  it("runs to term: 24 debits equal the reference table and the loan is paid off", () => {
    const r = wornInsured(2_000_000);
    const res = r.book.repairLoan({
      aircraftId: r.id,
      repair: "overhaul",
      principal: 150_000,
      termMonths: 24,
    });
    if (!res.ok) throw new Error(res.message);
    r.book.advance(24 * GAME_MONTH_MS + 1);
    r.drain();
    const id = res.data.loan.id;
    const interest = r.ledger.filter((e) => e.refId === id && e.category === "interest");
    const principal = r.ledger.filter(
      (e) => e.refId === id && e.category === "repair_loan_payment",
    );
    const ref = amortisationSchedule(150_000, 4, 24);
    expect(interest.map((e) => -e.amount)).toEqual(ref.map((x) => x.interest));
    expect(principal.map((e) => -e.amount)).toEqual(ref.map((x) => x.principal));
    expect(principal.reduce((s, e) => s + cents(-e.amount), 0)).toBe(15_000_000);
    expect(r.book.loans.get(id)).toMatchObject({ status: "paid_off", balance: 0 });
    r.balanced();
  });

  it("three misses: late fees, −15 reputation, policy cancelled, balance to cash; no repossession, no default flag", () => {
    const r = wornInsured(40_000);
    const res = r.book.repairLoan({
      aircraftId: r.id,
      repair: "overhaul",
      principal: 150_000,
      termMonths: 24,
    });
    if (!res.ok) throw new Error(res.message);
    const id = res.data.loan.id;
    // Drain the cash so every payment misses (an adjustment, tests only).
    r.book.post("adjustment", -r.book.company.cash, null, null, "test: empty the till");
    r.drain();
    const rep0 = r.book.company.reputation;
    r.book.advance(2 * GAME_MONTH_MS);
    r.drain();
    expect(r.book.loans.get(id)).toMatchObject({
      status: "active",
      missedCount: 2,
      balance: 151_001.67,
    });
    expect(r.book.aircraft(r.id)?.insurance).not.toBeNull();
    r.book.advance(GAME_MONTH_MS);
    r.drain();
    const fees = r.ledger.filter((e) => e.refId === id && e.category === "late_fee");
    expect(fees.map((e) => e.amount)).toEqual([-325.69, -325.69, -325.69]);
    expect(r.book.company.reputation).toBe(rep0 - 15);
    const loan = r.book.loans.get(id)!;
    expect(loan).toMatchObject({ status: "called", balance: 0, missedCount: 3 });
    // The capitalised balance after the third miss moves to cash.
    const call = r.ledger.filter((e) => e.refId === id && e.category === "repair_loan_payment");
    expect(call.map((e) => e.amount)).toEqual([-151_505.01]);
    expect(r.book.company.cash).toBeLessThan(0);
    // Repossession-free: the aircraft stays in the fleet, the default flag is never set.
    const a = r.book.aircraft(r.id);
    expect(a?.status).not.toBe("repossessed");
    expect(a?.insurance).toBeNull();
    expect(r.book.company.defaultUntilGameMs).toBeNull();
    expect(r.book.defaulted()).toBe(false);
    expect(r.notices.map((n) => n.name)).toEqual(
      expect.arrayContaining(["loan.missed", "insurance.cancelled"]),
    );
    expect(r.notices.map((n) => n.name)).not.toContain("aircraft.repossessed");
    expect(r.book.debt()).toBe(0);
    // No further debits after the call.
    const before = r.ledger.length;
    r.book.advance(GAME_MONTH_MS);
    r.drain();
    expect(r.ledger.slice(before).filter((e) => e.refId === id)).toEqual([]);
    r.balanced();
  });

  it("a successful payment resets the miss count", () => {
    const r = wornInsured(40_000);
    const res = r.book.repairLoan({
      aircraftId: r.id,
      repair: "overhaul",
      principal: 150_000,
      termMonths: 24,
    });
    if (!res.ok) throw new Error(res.message);
    r.book.post("adjustment", -r.book.company.cash, null, null, "test: empty the till");
    r.book.advance(2 * GAME_MONTH_MS);
    expect(r.book.loans.get(res.data.loan.id)?.missedCount).toBe(2);
    r.book.post("adjustment", 50_000, null, null, "test: refill");
    r.book.advance(GAME_MONTH_MS);
    expect(r.book.loans.get(res.data.loan.id)).toMatchObject({ status: "active", missedCount: 0 });
    r.balanced();
  });

  it("finances a defect repair net of the incident claim; the amount is capped at that bill", () => {
    const r = rig(1_000_000);
    const a = r.book.ensureStarter()!;
    r.book.buyInsurance(a.id);
    r.book.updateAircraft(a.id, { defects: [gearDefect] });
    r.drain();
    const view = r.book.insuranceState(r.book.aircraft(a.id)!);
    expect(view.repairLoan?.allDefectsBill).toBe(5_488);
    expect(
      r.book.repairLoan({
        aircraftId: a.id,
        repair: "defect",
        defectId: gearDefect.id,
        principal: 5_488.01,
        termMonths: 12,
      }),
    ).toMatchObject({ ok: false, code: "exceeds_bill" });
    const res = r.book.repairLoan({
      aircraftId: a.id,
      repair: "defect",
      defectId: gearDefect.id,
      principal: 5_488,
      termMonths: 12,
    });
    if (!res.ok) throw new Error(res.message);
    expect(res.data).toMatchObject({ bill: 5_488, claim: 13_952 });
    expect(res.data.loan.payment).toBe(467.3);
    r.drain();
    expect(rows(r.ledger.slice(-3))).toEqual([
      ["repair_loan_disbursement", 5_488],
      ["repair", -19_440],
      ["insurance_claim", 13_952],
    ]);
    r.balanced();
  });

  it("refusals in the book: uninsured, hired, a second loan, unknown aircraft, cash short", () => {
    const r = wornInsured(100_000);
    expect(
      r.book.repairLoan({
        aircraftId: "AC-9",
        repair: "overhaul",
        principal: 1_000,
        termMonths: 12,
      }),
    ).toMatchObject({ ok: false, code: "unknown_aircraft" });
    // Cash must cover the cost minus the loan.
    const poor = wornInsured(100_000);
    poor.book.post("adjustment", 1_000 - poor.book.company.cash, null, null, "test: $1,000 left");
    expect(
      poor.book.repairLoan({
        aircraftId: poor.id,
        repair: "overhaul",
        principal: 100_000,
        termMonths: 12,
      }),
    ).toMatchObject({ ok: false, code: "insufficient_cash" });
    // Hired (#39): locked.
    r.book.updateAircraft(r.id, { status: "hired" as AircraftStatus });
    expect(
      r.book.repairLoan({ aircraftId: r.id, repair: "all", principal: 1_000, termMonths: 12 }),
    ).toMatchObject({ ok: false, code: "aircraft_busy" });
    r.book.updateAircraft(r.id, { status: "available" });
    const ok = r.book.repairLoan({
      aircraftId: r.id,
      repair: "overhaul",
      principal: 100_000,
      termMonths: 12,
    });
    expect(ok.ok).toBe(true);
    // One open repair loan per aircraft (a defect added after the overhaul was ordered).
    r.book.updateAircraft(r.id, { defects: [gearDefect] });
    expect(
      r.book.repairLoan({
        aircraftId: r.id,
        repair: "defect",
        defectId: gearDefect.id,
        principal: 1_000,
        termMonths: 12,
      }),
    ).toMatchObject({ ok: false, code: "repair_loan_open" });
    // Uninsured aircraft.
    const u = rig(1_000_000);
    const s = u.book.ensureStarter()!;
    u.book.updateAircraft(s.id, { condition: 50 });
    expect(
      u.book.repairLoan({ aircraftId: s.id, repair: "overhaul", principal: 1_000, termMonths: 12 }),
    ).toMatchObject({ ok: false, code: "not_insured" });
    // Leased aircraft cannot be insured, so they are refused as not owned.
    const l = u.book.lease({ typeKey: "c208b", kind: "dry" });
    if (!l.ok) throw new Error(l.message);
    u.book.updateAircraft(l.data.id, { condition: 50 });
    expect(
      u.book.repairLoan({
        aircraftId: l.data.id,
        repair: "overhaul",
        principal: 1_000,
        termMonths: 12,
      }),
    ).toMatchObject({ ok: false, code: "not_owned" });
    r.balanced();
  });

  it("early payoff (loan.payoff) books repair_loan_payment and frees the policy for cancelling", () => {
    const r = wornInsured(200_000);
    const res = r.book.repairLoan({
      aircraftId: r.id,
      repair: "overhaul",
      principal: 100_000,
      termMonths: 12,
    });
    if (!res.ok) throw new Error(res.message);
    expect(r.book.cancelInsurance(r.id)).toMatchObject({ ok: false, code: "repair_loan_open" });
    const p = r.book.payoff(res.data.loan.id);
    expect(p).toEqual({ ok: true, data: { amount: 100_000 } });
    r.drain();
    expect(rows(r.ledger.slice(-1))).toEqual([["repair_loan_payment", -100_000]]);
    expect(r.book.loans.get(res.data.loan.id)?.status).toBe("paid_off");
    expect(r.book.cancelInsurance(r.id).ok).toBe(true);
    r.balanced();
  });

  it("selling settles the repair loan from the proceeds, or refuses when underwater", () => {
    const r = wornInsured(200_000);
    const res = r.book.repairLoan({
      aircraftId: r.id,
      repair: "overhaul",
      principal: 100_000,
      termMonths: 12,
    });
    if (!res.ok) throw new Error(res.message);
    // Let the overhaul finish so the aircraft is available.
    r.book.advance(6 * 24 * 3_600_000);
    r.drain();
    expect(r.book.aircraft(r.id)?.status).toBe("available");
    const balance = r.book.loans.get(res.data.loan.id)!.balance;
    const sold = r.book.sell(r.id);
    if (!sold.ok) throw new Error(sold.message);
    expect(sold.data.repairLoanPaid).toBe(balance);
    r.drain();
    const pay = r.ledger.filter(
      (e) => e.refId === res.data.loan.id && e.category === "repair_loan_payment",
    );
    expect(pay.at(-1)?.amount).toBe(-balance);
    expect(r.book.loans.get(res.data.loan.id)?.status).toBe("paid_off");
    r.balanced();

    // Underwater: the sale covers the bank loan alone but not bank + repair loan → refused,
    // nothing booked.
    const u = wornInsured(200_000);
    const rl = u.book.repairLoan({
      aircraftId: u.id,
      repair: "overhaul",
      principal: 150_000,
      termMonths: 24,
    });
    if (!rl.ok) throw new Error(rl.message);
    u.book.advance(6 * 24 * 3_600_000);
    u.book.updateAircraft(u.id, { condition: 5 });
    const value = u.book.aircraftValue(u.book.aircraft(u.id)!);
    const bank = u.book.takeLoan({
      lenderId: "jetwash",
      principal: Math.floor(value * 0.85),
      termMonths: 36,
      collateral: { type: "aircraft", id: u.id },
    });
    if (!bank.ok) throw new Error(bank.message);
    const salePrice = Math.round(value * 0.9 * 100) / 100;
    expect(bank.data.balance).toBeLessThan(salePrice);
    expect(bank.data.balance + 150_000).toBeGreaterThan(salePrice);
    u.drain();
    const n = u.ledger.length;
    expect(u.book.sell(u.id)).toMatchObject({ ok: false, code: "underwater" });
    u.drain();
    expect(u.ledger.length).toBe(n);
    u.balanced();
  });

  it("a write-off claim nets off the open repair loan first, then the bank loan", () => {
    const r = rig(1_000_000);
    const a = r.book.ensureStarter()!;
    r.book.updateAircraft(a.id, { condition: 70 });
    r.book.buyInsurance(a.id);
    const bank = r.book.takeLoan({
      lenderId: "jetwash",
      principal: 1_000_000,
      termMonths: 36,
      collateral: { type: "aircraft", id: a.id },
    });
    if (!bank.ok) throw new Error(bank.message);
    const rl = r.book.repairLoan({
      aircraftId: a.id,
      repair: "overhaul",
      principal: 50_000,
      termMonths: 12,
    });
    if (!rl.ok) throw new Error(rl.message);
    // Finish the overhaul, then age it back down so the crash writes it off.
    r.book.advance(60 * 3_600_000);
    r.book.updateAircraft(a.id, { condition: 70 });
    const valueBefore = r.book.aircraftValue(r.book.aircraft(a.id)!);
    r.drain();
    const n = r.ledger.length;
    const crash: FlightSettlement = {
      fuelKg: 0,
      fuelAirport: null,
      landingAirport: null,
      blockMin: 30,
      airborneMin: 25,
      peakG: null,
      overspeedEvents: 0,
      crashed: true,
      landings: 0,
      refType: "mission",
      refId: "M-1",
      memo: "Mission M-1",
    };
    const s = r.book.settleFlight(a.id, crash);
    if (!s.ok) throw new Error(s.message);
    expect(s.data.writtenOff).toBe(true);
    r.drain();
    const after = r.ledger.slice(n);
    const claim = Math.round(valueBefore * 0.8 * 100) / 100;
    expect(rows(after.filter((e) => e.category !== "landing_fee"))).toEqual([
      ["insurance_claim", claim],
      ["repair_loan_payment", -50_000],
      ["loan_payment", -1_000_000],
    ]);
    expect(r.book.loans.get(rl.data.loan.id)?.status).toBe("paid_off");
    expect(r.book.loans.get(bank.data.id)?.status).toBe("paid_off");
    r.balanced();
  });

  it("a bank repossession calls an open repair loan on the same aircraft", () => {
    const r = wornInsured(200_000);
    const bank = r.book.takeLoan({
      lenderId: "jetwash",
      principal: 500_000,
      termMonths: 36,
      collateral: { type: "aircraft", id: r.id },
    });
    if (!bank.ok) throw new Error(bank.message);
    const rl = r.book.repairLoan({
      aircraftId: r.id,
      repair: "overhaul",
      principal: 150_000,
      termMonths: 24,
    });
    if (!rl.ok) throw new Error(rl.message);
    r.book.post("adjustment", -r.book.company.cash, null, null, "test: empty the till");
    r.book.advance(3 * GAME_MONTH_MS);
    r.drain();
    expect(r.book.loans.get(bank.data.id)?.status).toBe("defaulted");
    const repair = r.book.loans.get(rl.data.loan.id)!;
    expect(repair.status).toBe("called");
    expect(repair.balance).toBe(0);
    expect(r.notices.map((n) => n.name)).toContain("aircraft.repossessed");
    r.balanced();
  });

  it("loansDomain lists repair loans with kind and the insurer's name", () => {
    const r = wornInsured(200_000);
    const res = r.book.repairLoan({
      aircraftId: r.id,
      repair: "overhaul",
      principal: 100_000,
      termMonths: 12,
    });
    if (!res.ok) throw new Error(res.message);
    const d = r.book.loansDomain();
    expect(d.loans[0]).toMatchObject({
      id: res.data.loan.id,
      kind: "repair",
      lenderName: REPAIR_LOAN.lenderName,
      orderId: res.data.order.id,
    });
    expect(d.monthlyDebtService).toBe(res.data.loan.payment);
  });
});
