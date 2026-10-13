// P4 economy: ledger, costs, wear, repair, reputation gates, credit, loans (amortisation
// to the cent, auto-debit, missed payments, repossession, early payoff), fleet selection
// and the company clock. Worked examples match docs/ECONOMY.md ("P4").

import { describe, expect, it } from "vitest";
import { aircraftTypeByKey, type AircraftType } from "@cargo-ops/protocol";
import {
  CompanyBook,
  GAME_DAY_MS,
  GAME_MONTH_MS,
  GameClockTicker,
  LENDERS,
  OverspeedDetector,
  airportLookup,
  amortisationSchedule,
  buildDemoCompany,
  canBuy,
  canLease,
  companyClock,
  creditScore,
  flightWear,
  fuelPrice,
  generateJobs,
  jobKindAllowed,
  landingFee,
  marketValue,
  monthlyPayment,
  newCompanyCore,
  offerApr,
  positiveMonths,
  quoteLoan,
  registrationFor,
  repairCost,
  repairHours,
  salePrice,
  selectAircraft,
  tierTable,
  type BookNotice,
  type CompanyCore,
} from "../src/index";
import { bundledAirports } from "./airports";

const lookup = airportLookup(bundledAirports());
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

function type(key: string): AircraftType {
  const t = aircraftTypeByKey(key);
  if (!t) throw new Error(key);
  return t;
}

function newBook(overrides: Partial<CompanyCore> = {}): CompanyBook {
  const company: CompanyCore = {
    name: "Test Air",
    base: "KMEM",
    seed: 4242,
    cash: 250_000,
    reputation: 50,
    ...newCompanyCore(250_000),
    ...overrides,
  };
  return new CompanyBook({ company, airports: lookup, now: () => NOW });
}

const cents = (n: number) => Math.round(n * 100);

/** Σ ledger amounts == cash − starting cash, to the cent. */
function expectBalanced(book: CompanyBook, entries: Array<{ amount: number; balance: number }>) {
  const sum = entries.reduce((s, e) => s + cents(e.amount), 0);
  expect(sum).toBe(cents(book.company.cash) - cents(book.company.startingCash));
  // Running balance: every entry's balance = previous balance + amount.
  let running = cents(book.company.startingCash);
  for (const e of entries) {
    running += cents(e.amount);
    expect(cents(e.balance)).toBe(running);
  }
}

describe("ledger", () => {
  it("every cash change is a ledger entry and the ledger balances", () => {
    const book = newBook({ cash: 5_000_000, startingCash: 5_000_000 });
    const all: Array<{ amount: number; balance: number }> = [];
    const collect = () => all.push(...book.drain().ledger);
    const starter = book.ensureStarter();
    expect(starter?.typeKey).toBe("c208b");
    collect();
    expect(all).toHaveLength(0); // the starter aircraft is not a cash change
    book.post("mission_payout", 7_123.98, "job", "J-1", "test");
    const bought = book.buy({
      typeKey: "kodiak100",
      financing: { lenderId: "jetwash", termMonths: 24, principal: 1_000_000 },
    });
    expect(bought.ok).toBe(true);
    const lease = book.lease({ typeKey: "dhc6", kind: "wet" });
    expect(lease.ok).toBe(true);
    if (!starter || !lease.ok) return;
    book.settleFlight(starter.id, {
      fuelKg: 284.08,
      fuelAirport: lookup.get("KATL"),
      landingAirport: lookup.get("KATL"),
      blockMin: 119,
      airborneMin: 100,
      peakG: 1.18,
      overspeedEvents: 0,
      crashed: false,
      landings: 1,
      refType: "mission",
      refId: "M-1",
      memo: "M-1",
    });
    book.settleFlight(lease.data.id, {
      fuelKg: 300,
      fuelAirport: lookup.get("KBNA"),
      landingAirport: lookup.get("KBNA"),
      blockMin: 90,
      airborneMin: 70,
      peakG: 1.3,
      overspeedEvents: 0,
      crashed: false,
      landings: 1,
      refType: "mission",
      refId: "M-2",
      memo: "M-2",
    });
    expect(book.repair(starter.id).ok).toBe(true);
    book.advance(3 * GAME_MONTH_MS);
    if (bought.ok && bought.data.loan) expect(book.payoff(bought.data.loan.id).ok).toBe(true);
    expect(book.returnLease(lease.data.id).ok).toBe(true);
    if (bought.ok) expect(book.sell(bought.data.aircraft.id).ok).toBe(true);
    collect();
    const categories = new Set(all.map((e) => (e as { category?: string }).category));
    for (const c of [
      "mission_payout",
      "purchase",
      "loan_disbursement",
      "loan_fee",
      "lease",
      "fuel",
      "landing_fee",
      "repair",
      "interest",
      "loan_payment",
      "sale",
    ]) {
      expect(categories.has(c)).toBe(true);
    }
    expectBalanced(book, all);
    expect(book.company.ledgerCount).toBe(all.length);
  });
});

describe("costs", () => {
  it("fuel price is deterministic per airport and within base ± 20 %", () => {
    const katl = lookup.get("KATL");
    const kmem = lookup.get("KMEM");
    if (!katl || !kmem) throw new Error("airports");
    // Worked example (docs/ECONOMY.md): KATL large −5 %, 116.2 nm to KBHM? → +2.32 %, noise +0.88 %.
    expect(fuelPrice(katl, lookup.list)).toEqual({
      usdPerKg: 1.915,
      size: -0.05,
      remoteness: 0.0232,
      noise: 0.0088,
      nearestLargeNm: 116.2,
    });
    expect(fuelPrice(kmem, lookup.list).usdPerKg).toBe(1.948);
    expect(fuelPrice(katl, lookup.list)).toEqual(fuelPrice(katl, [...lookup.list].reverse()));
    for (const a of lookup.list) {
      const p = fuelPrice(a, lookup.list).usdPerKg;
      expect(p).toBeGreaterThanOrEqual(1.95 * 0.8 - 0.001);
      expect(p).toBeLessThanOrEqual(1.95 * 1.2 + 0.001);
    }
  });

  it("landing fees by airport size and category", () => {
    expect(landingFee({ type: "large" }, type("c208b"))).toBe(300);
    expect(landingFee({ type: "medium" }, type("c208b"))).toBe(120);
    expect(landingFee({ type: "small" }, type("dhc6"))).toBe(60);
    expect(landingFee({ type: "large" }, type("b738bcf"))).toBe(2_400);
    expect(landingFee({ type: "large" }, type("b748f"))).toBe(6_000);
  });

  it("the replayed KMEM → KATL leg: 626.3 lb burned at KATL = $544.02, landing $300", () => {
    const book = newBook();
    const a = book.ensureStarter();
    if (!a) throw new Error("starter");
    const r = book.settleFlight(a.id, {
      fuelKg: 626.3 * 0.45359237,
      fuelAirport: lookup.get("KATL"),
      landingAirport: lookup.get("KATL"),
      blockMin: 119,
      airborneMin: 100,
      peakG: 1.18,
      overspeedEvents: 0,
      crashed: false,
      landings: 1,
      refType: "mission",
      refId: "M-1",
      memo: "M-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.costs.map((c) => [c.key, c.amount])).toEqual([
      ["fuel", 544.02],
      ["landing_fee", 300],
    ]);
    expect(book.aircraft(a.id)?.location).toBe("KATL");
    expect(book.company.cash).toBe(250_000 - 544.02 - 300);
  });
});

describe("wear and repair", () => {
  it("wear = 0.5/h + 2 × (G − 1.4)/0.3 + 5 per overspeed (+ 50 crash)", () => {
    expect(
      flightWear({ airborneMin: 100, peakG: 1.18, overspeedEvents: 0, crashed: false }),
    ).toEqual({ hours: 0.83, g: 0, overspeed: 0, crash: 0, total: 0.83 });
    expect(
      flightWear({ airborneMin: 150, peakG: 1.85, overspeedEvents: 1, crashed: false }),
    ).toEqual({ hours: 1.25, g: 3, overspeed: 5, crash: 0, total: 9.25 });
    expect(
      flightWear({ airborneMin: 30, peakG: null, overspeedEvents: 0, crashed: true }).total,
    ).toBe(50.25);
  });

  it("overspeed: IAS above Vmo for 3 s counts once until IAS drops below Vmo − 5 kt", () => {
    const d = new OverspeedDetector(175);
    let t = 0;
    for (const ias of [170, 176, 178, 180, 181, 179, 176, 172, 168, 176, 177, 178, 179]) {
      d.update(ias, t);
      t += 1_000;
    }
    expect(d.count).toBe(2);
  });

  it("repair cost ∝ price × wear; time 2 h + 1.5 h per point", () => {
    expect(repairCost(type("c208b"), 97.5)).toBe(5_400);
    expect(repairHours(97.5)).toBe(5.75);
    expect(repairHours(100)).toBe(0);
    expect(repairCost(type("b748f"), 50)).toBe(7_200_000);
  });

  it("repair takes in-game time, then restores 100 % and emits repair.completed", () => {
    const book = newBook();
    const a = book.ensureStarter();
    if (!a) throw new Error("starter");
    book.updateAircraft(a.id, { condition: 15 });
    expect(
      book.fleetDomain(selectAircraft(book.activeFleet(), null, null, null)).aircraft[0]?.airworthy,
    ).toBe(false);
    const r = book.repair(a.id);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data).toEqual({ cost: 183_600, hours: 129.5, readyAtGameMs: 129.5 * 3_600_000 });
    expect(book.repair(a.id).ok).toBe(false); // already in maintenance
    book.drain();
    book.advance(129 * 3_600_000);
    expect(book.aircraft(a.id)?.status).toBe("maintenance");
    book.advance(3_600_000);
    expect(book.aircraft(a.id)?.status).toBe("available");
    expect(book.aircraft(a.id)?.condition).toBe(100);
    expect(names(book.drain().notices)).toEqual(["repair.completed"]);
  });

  it("market value and sale price", () => {
    expect(marketValue(type("c208b"), 0, 100)).toBe(2_700_000);
    expect(marketValue(type("c208b"), 120, 97.5)).toBe(2_673_318.6);
    expect(salePrice(type("c208b"), 0, 100)).toBe(2_430_000);
  });
});

describe("reputation tiers and gates", () => {
  it("tier table", () => {
    const t = tierTable();
    expect(t.map((r) => r.name)).toEqual([
      "Startup",
      "Regional",
      "Established",
      "Trusted",
      "Premier",
      "Elite",
    ]);
    expect(t[0]?.aircraftClasses).toEqual(["single-piston", "single-turboprop"]);
    expect(t[2]?.jobKinds).toContain("hazmat");
    expect(t[1]?.jobKinds).not.toContain("hazmat");
  });

  it("aircraft classes, leases one tier lower, job kinds", () => {
    expect(canBuy(type("atr72f"), 39)).toBe(false);
    expect(canBuy(type("atr72f"), 40)).toBe(true);
    expect(canLease(type("atr72f"), 20)).toBe(true);
    expect(canBuy(type("b748f"), 79)).toBe(false);
    expect(canLease(type("b748f"), 60)).toBe(true);
    expect(jobKindAllowed("hazmat", 39)).toBe(false);
    expect(jobKindAllowed("medical", 20)).toBe(true);
    const book = newBook({ reputation: 10 });
    const r = book.buy({ typeKey: "dhc6" });
    expect(r.ok ? null : r.code).toBe("reputation_gate");
  });

  it("the generator never offers a kind above the tier", () => {
    const kmem = lookup.get("KMEM");
    if (!kmem) throw new Error("KMEM");
    const low = generateJobs({
      origin: kmem,
      airports: lookup.list,
      aircraft: type("c208b"),
      seed: 77,
      nowMs: NOW,
      reputation: 5,
      count: 200,
    });
    expect(low.some((j) => j.kind === "medical" || j.kind === "hazmat")).toBe(false);
    const high = generateJobs({
      origin: kmem,
      airports: lookup.list,
      aircraft: type("c208b"),
      seed: 77,
      nowMs: NOW,
      reputation: 50,
      count: 200,
    });
    expect(high.some((j) => j.kind === "hazmat")).toBe(true);
  });
});

describe("credit score and offers", () => {
  it("3 × reputation + 25 × positive months + 250 × (1 − debt ratio), halved after a default", () => {
    expect(
      creditScore({
        reputation: 50,
        positiveMonths: 0,
        debt: 0,
        assets: 2_950_000,
        defaulted: false,
      }).score,
    ).toBe(400);
    const s = creditScore({
      reputation: 70,
      positiveMonths: 6,
      debt: 1_000_000,
      assets: 4_000_000,
      defaulted: false,
    });
    expect(s).toEqual({
      score: 210 + 150 + 188,
      reputation: 210,
      cashFlow: 150,
      debt: 188,
      debtRatio: 0.25,
      halved: false,
    });
    expect(
      creditScore({
        reputation: 70,
        positiveMonths: 6,
        debt: 1_000_000,
        assets: 4_000_000,
        defaulted: true,
      }).score,
    ).toBe(274);
    expect(
      positiveMonths(
        [
          { month: 0, revenue: 10, expense: 5, net: 5 },
          { month: 1, revenue: 1, expense: 5, net: -4 },
          { month: 2, revenue: 9, expense: 5, net: 4 },
          { month: 3, revenue: 9, expense: 1, net: 8 },
        ],
        3,
      ),
    ).toBe(2);
  });

  it("APR by score per lender; quotes refuse with clear codes", () => {
    const [alto, vector, jet] = LENDERS;
    if (!alto || !vector || !jet) throw new Error("lenders");
    expect([offerApr(alto, 400), offerApr(vector, 400), offerApr(jet, 400)]).toEqual([
      8, 12, 16.91,
    ]);
    expect([offerApr(alto, 700), offerApr(vector, 700), offerApr(jet, 700)]).toEqual([
      7, 9.5, 13.64,
    ]);
    const base = { score: 400, reputation: 50, defaulted: false, termMonths: 36 };
    expect(
      quoteLoan({ ...base, lender: alto, principal: 100_000, collateralValue: 1_000_000 }).code,
    ).toBe("credit_score_too_low");
    expect(
      quoteLoan({ ...base, lender: jet, principal: 900_000, collateralValue: 1_000_000 }).code,
    ).toBe("ltv_exceeded");
    expect(
      quoteLoan({ ...base, lender: jet, termMonths: 72, principal: 100_000, collateralValue: 1e6 })
        .code,
    ).toBe("bad_term");
    const ok = quoteLoan({ ...base, lender: jet, principal: 400_000, collateralValue: 2_700_000 });
    expect(ok.ok).toBe(true);
    expect(ok.originationFee).toBe(4_000);
  });
});

/** Independent amortisation table in integer cents. */
function referenceTable(principal: number, apr: number, n: number) {
  const r = apr / 100 / 12;
  const payment = Math.round(((principal * r) / (1 - (1 + r) ** -n)) * 100);
  let balance = Math.round(principal * 100);
  const rows: Array<{ interest: number; principal: number; payment: number; balance: number }> = [];
  for (let m = 1; m <= n; m++) {
    const interest = Math.round(balance * r);
    const pay = m === n ? balance + interest : payment;
    balance -= pay - interest;
    rows.push({ interest, principal: pay - interest, payment: pay, balance });
  }
  return { payment, rows };
}

describe("loans", () => {
  it("standard amortisation to the cent: $100,000 at 12 % over 12 months", () => {
    expect(monthlyPayment(100_000, 12, 12)).toBe(8_884.88);
    const table = amortisationSchedule(100_000, 12, 12);
    const ref = referenceTable(100_000, 12, 12);
    expect(
      table.map((r) => [cents(r.payment), cents(r.interest), cents(r.principal), cents(r.balance)]),
    ).toEqual(ref.rows.map((r) => [r.payment, r.interest, r.principal, r.balance]));
    expect(table[0]).toEqual({
      month: 1,
      payment: 8_884.88,
      interest: 1_000,
      principal: 7_884.88,
      balance: 92_115.12,
    });
    expect(table[11]).toEqual({
      month: 12,
      payment: 8_884.85,
      interest: 87.97,
      principal: 8_796.88,
      balance: 0,
    });
    expect(monthlyPayment(12_000, 0, 12)).toBe(1_000);
  });

  it("auto-debits on each in-game month and amortises exactly over the term", () => {
    const book = newBook({ cash: 2_000_000, startingCash: 2_000_000 });
    const a = book.ensureStarter();
    if (!a) throw new Error("starter");
    const taken = book.takeLoan({
      lenderId: "jetwash",
      principal: 250_000,
      termMonths: 24,
      collateral: { type: "aircraft", id: a.id },
    });
    expect(taken.ok).toBe(true);
    if (!taken.ok) return;
    const loan = taken.data;
    expect(loan.apr).toBe(16.91); // score 400
    const ref = referenceTable(250_000, loan.apr, 24);
    expect(cents(loan.payment)).toBe(ref.payment);
    const ledger = [...book.drain().ledger];
    const notices: BookNotice[] = [];
    for (let m = 1; m <= 24; m++) {
      book.advance(GAME_MONTH_MS - 1);
      expect(book.loans.get(loan.id)?.paymentsMade).toBe(m - 1);
      book.advance(1);
      const d = book.drain();
      ledger.push(...d.ledger);
      notices.push(...d.notices);
      const row = ref.rows[m - 1];
      const paid = d.notices.find((n) => n.name === "loan.payment");
      expect(paid?.data).toEqual({
        loanId: loan.id,
        amount: (row?.payment ?? 0) / 100,
        interest: (row?.interest ?? 0) / 100,
        principal: (row?.principal ?? 0) / 100,
        balance: (row?.balance ?? 0) / 100,
      });
    }
    const final = book.loans.get(loan.id);
    expect(final?.status).toBe("paid_off");
    expect(final?.balance).toBe(0);
    expect(book.aircraft(a.id)?.loanId).toBeNull();
    const interest = ledger
      .filter((e) => e.category === "interest")
      .reduce((s, e) => s + cents(e.amount), 0);
    expect(-interest).toBe(ref.rows.reduce((s, r) => s + r.interest, 0));
    expectBalanced(book, ledger);
  });

  it("missed payments: late fee, −5 reputation each; the third repossesses and halves the score", () => {
    const book = newBook({ cash: 300_000, startingCash: 300_000 });
    const a = book.ensureStarter();
    if (!a) throw new Error("starter");
    book.select(a.id);
    const taken = book.takeLoan({
      lenderId: "jetwash",
      principal: 500_000,
      termMonths: 36,
      collateral: { type: "aircraft", id: a.id },
    });
    if (!taken.ok) throw new Error(taken.message);
    const loan = taken.data;
    // Spend all cash so the auto-debit fails.
    book.post("adjustment", -book.company.cash, null, null, "test: empty the account");
    const scoreBefore = book.credit().score;
    const ledger = [...book.drain().ledger];
    const r = referenceTable(500_000, loan.apr, 36);
    const fee = Math.max(100, Math.round(r.payment * 0.05) / 100);

    book.advance(GAME_MONTH_MS);
    let d = book.drain();
    ledger.push(...d.ledger);
    expect(names(d.notices)).toEqual(["loan.missed"]);
    expect(d.ledger.map((e) => [e.category, e.amount])).toEqual([["late_fee", -fee]]);
    expect(book.company.reputation).toBe(45);
    const interest1 = Math.round(500_000 * 100 * (loan.apr / 1200)) / 100;
    expect(book.loans.get(loan.id)?.balance).toBe(Math.round((500_000 + interest1) * 100) / 100);
    expect(book.loans.get(loan.id)?.missedCount).toBe(1);

    book.advance(GAME_MONTH_MS);
    d = book.drain();
    ledger.push(...d.ledger);
    expect(names(d.notices)).toEqual(["loan.missed"]);
    book.advance(GAME_MONTH_MS);
    d = book.drain();
    ledger.push(...d.ledger);
    expect(names(d.notices)).toEqual(["loan.missed", "aircraft.repossessed"]);
    expect(book.company.reputation).toBe(35);
    expect(book.loans.get(loan.id)?.status).toBe("defaulted");
    expect(book.fleet.get(a.id)?.status).toBe("repossessed");
    expect(book.activeFleet()).toHaveLength(0);
    expect(book.company.selectedAircraftId).toBeNull();
    expect(book.defaulted()).toBe(true);
    expect(book.company.defaultUntilGameMs).toBe(3 * GAME_MONTH_MS + 12 * GAME_MONTH_MS);
    const raw = creditScore({
      reputation: 35,
      positiveMonths: 0,
      debt: 0,
      assets: 0,
      defaulted: false,
    }).score;
    expect(book.credit().score).toBe(Math.floor(raw / 2));
    expect(book.credit().score).toBeLessThan(scoreBefore);
    // Only the aggressive lender still lends, and only with collateral.
    const offers = book.loansDomain().offers;
    expect(offers.filter((o) => o.eligible).map((o) => o.lenderId)).toEqual([]);
    expectBalanced(book, ledger);
    // The flag lapses after 12 in-game months.
    book.advance(12 * GAME_MONTH_MS);
    expect(book.defaulted()).toBe(false);
  });

  it("a payment after a miss resets the consecutive count", () => {
    const book = newBook({ cash: 300_000, startingCash: 300_000 });
    const a = book.ensureStarter();
    if (!a) throw new Error("starter");
    const t = book.takeLoan({
      lenderId: "jetwash",
      principal: 100_000,
      termMonths: 12,
      collateral: { type: "aircraft", id: a.id },
    });
    if (!t.ok) throw new Error(t.message);
    const cash = book.company.cash;
    book.post("adjustment", -cash, null, null, "empty");
    book.advance(GAME_MONTH_MS);
    expect(book.loans.get(t.data.id)?.missedCount).toBe(1);
    book.post("adjustment", cash, null, null, "refill");
    book.advance(GAME_MONTH_MS);
    expect(book.loans.get(t.data.id)?.missedCount).toBe(0);
    expect(book.loans.get(t.data.id)?.paymentsMade).toBe(1);
  });

  it("early payoff clears the balance without penalty and frees the collateral", () => {
    const book = newBook({ cash: 1_000_000, startingCash: 1_000_000 });
    const a = book.ensureStarter();
    if (!a) throw new Error("starter");
    const t = book.takeLoan({
      lenderId: "jetwash",
      principal: 200_000,
      termMonths: 24,
      collateral: { type: "aircraft", id: a.id },
    });
    if (!t.ok) throw new Error(t.message);
    book.advance(GAME_MONTH_MS);
    const balance = book.loans.get(t.data.id)?.balance ?? 0;
    const ref = referenceTable(200_000, t.data.apr, 24);
    expect(cents(balance)).toBe(ref.rows[0]?.balance);
    book.drain();
    const p = book.payoff(t.data.id);
    expect(p.ok && p.data.amount).toBe(balance);
    const d = book.drain();
    expect(d.ledger.map((e) => [e.category, e.amount])).toEqual([["loan_payment", -balance]]);
    expect(book.loans.get(t.data.id)?.status).toBe("paid_off");
    expect(book.aircraft(a.id)?.loanId).toBeNull();
    expect(book.payoff(t.data.id).ok).toBe(false);
    // Another loan can now use the aircraft as collateral.
    expect(
      book.takeLoan({
        lenderId: "jetwash",
        principal: 10_000,
        termMonths: 12,
        collateral: { type: "aircraft", id: a.id },
      }).ok,
    ).toBe(true);
    expect(
      book.takeLoan({
        lenderId: "jetwash",
        principal: 10_000,
        termMonths: 12,
        collateral: { type: "aircraft", id: a.id },
      }),
    ).toMatchObject({ ok: false, code: "collateral_encumbered" });
  });

  it("financed purchase: cash = price − principal + 1 % fee; refused without enough cash", () => {
    const poor = newBook();
    const refused = poor.buy({
      typeKey: "kodiak100",
      financing: { lenderId: "jetwash", termMonths: 60, principal: 2_210_000 },
    });
    expect(refused.ok ? null : refused.code).toBe("insufficient_cash"); // needs $412,100
    expect(poor.drain().ledger).toHaveLength(0);
    const book = newBook({ cash: 500_000, startingCash: 500_000 });
    const r = book.buy({
      typeKey: "kodiak100",
      financing: { lenderId: "jetwash", termMonths: 60, principal: 2_210_000 },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(book.company.cash).toBe(500_000 - 2_600_000 + 2_210_000 - 22_100);
    expect(book.aircraft(r.data.aircraft.id)?.loanId).toBe(r.data.loan?.id);
    // The new debt pulls the score (400) under every minimum: a second loan is refused.
    expect(
      book.buy({
        typeKey: "kodiak100",
        financing: { lenderId: "jetwash", termMonths: 60, principal: 2_300_000 },
      }),
    ).toMatchObject({ ok: false, code: "credit_score_too_low" });
    // Selling pays the loan off from the proceeds (90 % of value).
    const sale = book.sell(r.data.aircraft.id);
    expect(sale).toEqual({ ok: true, data: { price: 2_340_000, loanPaid: 2_210_000 } });
    expect(book.company.cash).toBe(87_900 + 2_340_000 - 2_210_000);
    expect(book.loans.get(r.data.loan?.id ?? "")?.status).toBe("paid_off");
  });
});

describe("fleet selection (TITLE auto-match)", () => {
  const fleet = [
    { id: "AC-1", typeKey: "c208b", location: "KMEM" },
    { id: "AC-2", typeKey: "kodiak100", location: "KMEM" },
    { id: "AC-3", typeKey: "c208b", location: "KATL" },
  ];
  it("one owned aircraft of the TITLE's type is selected automatically", () => {
    expect(selectAircraft(fleet, "Daher Kodiak 100 Series II", null, null)).toMatchObject({
      id: "AC-2",
      source: "title",
      ambiguous: false,
    });
  });
  it("several of that type: the one at the current airport, else ambiguous", () => {
    expect(selectAircraft(fleet, "Cessna 208B Grand Caravan EX", null, "KATL").id).toBe("AC-3");
    expect(selectAircraft(fleet, "Cessna 208B Grand Caravan EX", null, "KBNA")).toMatchObject({
      id: null,
      ambiguous: true,
      candidates: ["AC-1", "AC-3"],
    });
  });
  it("manual selection wins; unknown titles fall back to a single-aircraft fleet", () => {
    expect(selectAircraft(fleet, "Cessna 208B Grand Caravan EX", "AC-1", "KBNA").source).toBe(
      "manual",
    );
    expect(selectAircraft(fleet, "Boeing 747-8F", null, null)).toMatchObject({
      id: null,
      ambiguous: false,
    });
    expect(selectAircraft([fleet[0]!], "Some Glider", null, null)).toMatchObject({
      id: "AC-1",
      source: "single",
    });
  });
  it("catalogue prices and lease rates are set for every type", () => {
    for (const key of ["pc6", "c208b", "dhc6", "atr72f", "b748f"]) {
      const t = type(key);
      expect(t.priceUsd).toBeGreaterThan(0);
      expect(t.dryLeaseUsdPerEngineHour).toBeGreaterThan(0);
      expect(t.wetLeaseUsdPerBlockHour).toBeGreaterThan(t.dryLeaseUsdPerEngineHour);
      expect(t.vmoKt).toBeGreaterThan(t.approachKt);
    }
  });
  it("registrations are deterministic and unique", () => {
    expect(registrationFor(4242, 1, new Set())).toBe(registrationFor(4242, 1, new Set()));
    const first = registrationFor(4242, 1, new Set());
    expect(registrationFor(4242, 1, new Set([first]))).not.toBe(first);
    expect(first).toMatch(/^N\d{3}[A-Z]{2}$/);
  });
});

describe("company clock", () => {
  it("game Δ = max(wall Δ capped at 60 s, simulator Δ)", () => {
    const t = new GameClockTicker();
    expect(t.tick(1_000)).toBe(0);
    expect(t.tick(2_000)).toBe(1_000);
    t.addSim(4_000); // 4× sim rate
    expect(t.tick(3_000)).toBe(4_000);
    expect(t.tick(3_000 + 3_600_000)).toBe(60_000); // PC asleep for an hour
    t.addSim(500);
    expect(t.tick(3_600_000 + 4_000)).toBe(1_000);
  });
  it("30-day months", () => {
    expect(companyClock(0)).toEqual({ gameMs: 0, month: 1, day: 1 });
    expect(companyClock(GAME_MONTH_MS + 2 * GAME_DAY_MS + 5)).toEqual({
      gameMs: GAME_MONTH_MS + 2 * GAME_DAY_MS + 5,
      month: 2,
      day: 3,
    });
  });
  it("leases bill monthly on the company clock", () => {
    const book = newBook();
    const l = book.lease({ typeKey: "c208b", kind: "dry" });
    expect(l.ok).toBe(true);
    expect(book.company.cash).toBe(250_000 - 6_750);
    book.advance(2 * GAME_MONTH_MS + 1);
    expect(book.company.cash).toBe(250_000 - 3 * 6_750);
  });
});

describe("demo company", () => {
  it("is deterministic and balanced", () => {
    const a = buildDemoCompany(lookup);
    const b = buildDemoCompany(lookup);
    expect(a.book.company).toEqual(b.book.company);
    expect(a.book.fleetDomain(a.selection)).toEqual(b.book.fleetDomain(b.selection));
    // P5: the demo also buys an inspected used aircraft, financed (second loan).
    expect(a.book.activeFleet().map((x) => x.ownership)).toEqual(["owned", "dry_lease", "owned"]);
    expect(a.book.loansDomain().loans).toHaveLength(2);
    // Revenue covers the flying costs; P5 adds an inspection and a field repair of the used
    // aircraft, which the demo books too.
    const months = a.book.ledgerDomain().months;
    expect(months.reduce((s, m) => s + m.revenue, 0)).toBeGreaterThan(50_000);
    const recent = a.book.ledgerDomain().recent;
    expect(recent[0]?.balance).toBe(a.book.company.cash);
  });
});

/** Notice names without the P5-part-2 day-roll notices (demand events run on the same clock). */
function names(notices: readonly BookNotice[]): string[] {
  return notices.map((n) => n.name).filter((n) => n !== "demand.event");
}
