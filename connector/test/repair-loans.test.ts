// Insurer repair loans through the real ConnectorSession and SQLite storage (docs/ECONOMY.md
// "Insurer repair loans"): the insurance.repairLoan command with clear codes, the month
// rollover auto-debit, three misses (policy cancelled, balance moved to cash, no
// repossession, no default flag), early payoff, cancel/sell interactions, a restart from the
// database and the career export round trip. After every scenario the stored ledger sums to
// cash − starting cash to the cent.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PROTOCOL_VERSION,
  type Command,
  type CompanyState,
  type FleetState,
  type Frame,
  type LoansState,
  type Result,
} from "../src/protocol";
import { GAME_MONTH_MS, type EconomyAirport } from "../src/economy";
import { loadAirportsData } from "../src/core/economy/airports-data";
import { ConnectorSession } from "../src/core/session";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import { exportCareer, importCareer } from "../src/storage/career";
import { openStorage, type Storage } from "../src/storage/db";
import { EconomyRepo } from "../src/storage/economy";
import { FlightRepo } from "../src/storage/flights";
import { tempDir } from "./helpers";

const FIXTURE = join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl");
const T0 = Date.UTC(2026, 9, 14, 12, 0, 0);

let airportsCache: EconomyAirport[] | null = null;
const airports = () => (airportsCache ??= loadAirportsData().airports);

interface Rig {
  session: ConnectorSession;
  storage: Storage;
  repo: EconomyRepo;
  out: Frame[];
  cmd(name: string, args?: unknown): Result;
  ok<T>(name: string, args?: unknown): T;
  err(name: string, args?: unknown): string;
  company(): CompanyState;
  fleet(): FleetState;
  loans(): LoansState;
  events(name: string): Frame[];
  wait(ms: number): void;
  close(): void;
}

function rig(dir: string): Rig {
  const storage = openStorage(dir, "demo");
  const repo = new EconomyRepo(storage);
  const source = new FakeSource({ frames: loadFixture(FIXTURE), manual: true });
  const clock = { now: T0 };
  let n = 0;
  let missionN = 0;
  let flightN = 0;
  const session = new ConnectorSession(source, () => {}, {
    repo: new FlightRepo(storage, "replay"),
    now: () => clock.now,
    newId: () => `flight-${++flightN}`,
    economy: {
      repo,
      airports: airports(),
      seed: 4242,
      replay: true,
      now: () => clock.now,
      newId: () => `M-${++missionN}`,
    },
  });
  const out: Frame[] = [];
  session.store.subscribe((f) => out.push(f));
  session.start();
  const cmd = (name: string, args: unknown = {}): Result =>
    session.command({ type: "command", v: PROTOCOL_VERSION, id: `c${++n}`, name, args } as Command);
  const dom = <T>(name: string) => session.store.getDomain(name as "company") as unknown as T;
  return {
    session,
    storage,
    repo,
    out,
    cmd,
    ok<T>(name: string, args: unknown = {}): T {
      const r = cmd(name, args);
      if (!r.ok) assert.fail(`${name} failed: ${r.error.code} ${r.error.message}`);
      return r.data as T;
    },
    err(name: string, args: unknown = {}): string {
      const r = cmd(name, args);
      assert.equal(r.ok, false, `${name} should fail`);
      return r.ok ? "" : r.error.code;
    },
    company: () => dom<CompanyState>("company"),
    fleet: () => dom<FleetState>("fleet"),
    loans: () => dom<LoansState>("loans"),
    events: (name) => out.filter((f) => f.type === "event" && f.name === name),
    wait(ms: number) {
      session.economy?.tick();
      let left = ms;
      for (let i = 0; i < 3 && left > 0; i++) {
        const step = Math.min(60_000, left);
        clock.now += step;
        left -= step;
        session.economy?.tick();
      }
      if (left > 0) session.economy?.advanceGameTime(left);
    },
    close: () => storage.close(),
  };
}

const cents = (n: number) => Math.round(n * 100);

/** Σ stored ledger = cash − starting cash, to the cent. */
function assertBalanced(r: Rig): void {
  const sum = Math.round(r.repo.ledgerTotals().sum * 100);
  const c = r.company();
  assert.equal(sum, cents(c.cash) - cents(c.startingCash ?? 250_000));
}

/** Stored ledger rows of one loan, oldest first. */
function loanRows(r: Rig, loanId: string): Array<[string, number]> {
  return r.repo
    .listLedger(100_000)
    .filter((e) => e.refId === loanId)
    .reverse()
    .map((e) => [e.category, e.amount]);
}

interface RepairLoanResult {
  loan: { id: string; payment: number; balance: number; kind: string; orderId: string };
  order: { id: string; readyAtGameMs: number };
  bill: number;
  claim: number;
}

/** The starter C208B worn to 19.5 % (overhaul $173,880) and insured. */
function wornInsuredStarter(r: Rig): string {
  const id = r.fleet().aircraft[0]?.id ?? "";
  r.session.economy?.companyBook.updateAircraft(id, { condition: 19.5 });
  r.ok("insurance.buy", { aircraftId: id });
  return id;
}

describe("insurer repair loans through the connector", () => {
  it("finance an overhaul, then the month rollover auto-debits interest and principal", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const id = wornInsuredStarter(r);
      const view = r.fleet().aircraft[0]?.insurance?.repairLoan;
      assert.equal(view?.apr, 4);
      assert.equal(view?.overhaulBill, 173_880);
      assert.equal(view?.open, null);
      const res = r.ok<RepairLoanResult>("insurance.repairLoan", {
        aircraftId: id,
        repair: "overhaul",
        principal: 150_000,
        termMonths: 24,
      });
      assert.equal(res.bill, 173_880);
      assert.equal(res.loan.kind, "repair");
      assert.equal(res.loan.payment, 6_513.74);
      // Published: loans domain (kind, insurer) and the fleet's open loan; the aircraft is in
      // maintenance and carries no lien (not "financed").
      const listed = r.loans().loans.find((l) => l.id === res.loan.id);
      assert.equal(listed?.kind, "repair");
      assert.equal(listed?.lenderName, "Hull insurer");
      assert.equal(listed?.orderId, res.order.id);
      const a = r.fleet().aircraft[0];
      assert.equal(a?.status, "maintenance");
      assert.equal(a?.financed, false);
      assert.equal(a?.insurance?.repairLoan?.open?.balance, 150_000);
      assert.equal(r.company().debt, 150_000);
      assert.deepEqual(loanRows(r, res.loan.id), [["repair_loan_disbursement", 150_000]]);
      // One in-game month later: interest $500.00, principal $6,013.74.
      r.wait(GAME_MONTH_MS);
      assert.deepEqual(loanRows(r, res.loan.id), [
        ["repair_loan_disbursement", 150_000],
        ["interest", -500],
        ["repair_loan_payment", -6_013.74],
      ]);
      assert.equal(r.events("loan.payment").length, 1);
      assert.equal(r.loans().loans.find((l) => l.id === res.loan.id)?.balance, 143_986.26);
      assertBalanced(r);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("three missed payments: policy cancelled, balance to cash, no repossession, no default flag", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const id = wornInsuredStarter(r);
      const res = r.ok<RepairLoanResult>("insurance.repairLoan", {
        aircraftId: id,
        repair: "overhaul",
        principal: 150_000,
        termMonths: 24,
      });
      // Empty the till (an adjustment, tests only) so every debit misses.
      const book = r.session.economy?.companyBook;
      assert.ok(book);
      book.post("adjustment", -book.company.cash, null, null, "test: empty the till");
      const rep0 = book.company.reputation;
      r.wait(3 * GAME_MONTH_MS + 60_000);
      assert.equal(r.events("loan.missed").length, 3);
      assert.equal(r.events("insurance.cancelled").length, 1);
      assert.equal(r.events("aircraft.repossessed").length, 0);
      const rows = loanRows(r, res.loan.id);
      assert.deepEqual(
        rows.filter(([c]) => c === "late_fee"),
        [
          ["late_fee", -325.69],
          ["late_fee", -325.69],
          ["late_fee", -325.69],
        ],
      );
      // The balance after three capitalised months moves to cash in one row.
      assert.deepEqual(rows.at(-1), ["repair_loan_payment", -151_505.01]);
      const loan = r.loans().loans.find((l) => l.id === res.loan.id);
      assert.equal(loan?.status, "called");
      assert.equal(loan?.balance, 0);
      assert.equal(r.loans().defaultUntilGameMs, null);
      const a = r.fleet().aircraft.find((x) => x.id === id);
      assert.ok(a, "the aircraft stays in the fleet");
      assert.equal(a.insurance?.insured, false);
      assert.equal(r.company().reputation, rep0 - 15);
      assert.ok(r.company().cash < 0);
      assertBalanced(r);
      // A restart from the database keeps the called loan and books nothing more for it.
      const before = rows.length;
      r.close();
      const again = rig(tmp.dir);
      assert.equal(again.loans().loans.find((l) => l.id === res.loan.id)?.status, "called");
      again.wait(GAME_MONTH_MS);
      assert.equal(loanRows(again, res.loan.id).length, before);
      assertBalanced(again);
      again.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("refusals with clear codes; payoff, cancel and sale interactions", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const id = r.fleet().aircraft[0]?.id ?? "";
      r.session.economy?.companyBook.updateAircraft(id, { condition: 60 });
      const args = { aircraftId: id, repair: "overhaul", principal: 20_000, termMonths: 12 };
      assert.equal(r.err("insurance.repairLoan", { ...args, repair: "defect" }), "bad_args");
      assert.equal(
        r.err("insurance.repairLoan", { ...args, aircraftId: "AC-9" }),
        "unknown_aircraft",
      );
      assert.equal(r.err("insurance.repairLoan", args), "not_insured");
      r.ok("insurance.buy", { aircraftId: id });
      assert.equal(r.err("insurance.repairLoan", { ...args, termMonths: 36 }), "bad_term");
      assert.equal(r.err("insurance.repairLoan", { ...args, principal: 100 }), "bad_principal");
      const bill = r.fleet().aircraft[0]?.insurance?.repairLoan?.overhaulBill ?? 0;
      assert.equal(bill, 86_400);
      assert.equal(r.err("insurance.repairLoan", { ...args, principal: bill + 1 }), "exceeds_bill");
      const res = r.ok<RepairLoanResult>("insurance.repairLoan", args);
      assert.equal(r.err("insurance.repairLoan", args), "repair_loan_open");
      // Cancelling the policy with an open repair loan is refused.
      assert.equal(r.err("insurance.cancel", { aircraftId: id }), "repair_loan_open");
      // Early payoff through loan.payoff books repair_loan_payment.
      r.ok("loan.payoff", { loanId: res.loan.id });
      assert.deepEqual(loanRows(r, res.loan.id).at(-1), ["repair_loan_payment", -20_000]);
      r.ok("insurance.cancel", { aircraftId: id });
      assertBalanced(r);

      // Sale with an open repair loan: settled from the proceeds.
      r.ok("insurance.buy", { aircraftId: id });
      r.wait(70 * 3_600_000);
      assert.equal(r.fleet().aircraft[0]?.status, "available");
      r.session.economy?.companyBook.updateAircraft(id, { condition: 90 });
      const second = r.ok<RepairLoanResult>("insurance.repairLoan", {
        ...args,
        principal: 10_000,
        termMonths: 6,
      });
      r.wait(30 * 3_600_000);
      const sold = r.ok<{ price: number; loanPaid: number; repairLoanPaid: number }>("fleet.sell", {
        aircraftId: id,
      });
      assert.equal(sold.repairLoanPaid, 10_000);
      assert.equal(r.loans().loans.find((l) => l.id === second.loan.id)?.status, "paid_off");
      assertBalanced(r);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("career export v5 round trip keeps repair loans (optional kind/orderId); debits continue", () => {
    const a = tempDir();
    const b = tempDir();
    try {
      const r = rig(a.dir);
      const id = wornInsuredStarter(r);
      const res = r.ok<RepairLoanResult>("insurance.repairLoan", {
        aircraftId: id,
        repair: "overhaul",
        principal: 150_000,
        termMonths: 24,
      });
      const exported = exportCareer(r.repo, "demo", T0);
      assert.equal(exported.version, 5);
      const loan = exported.loans.find((l) => l.id === res.loan.id);
      assert.equal(loan?.kind, "repair");
      assert.equal(loan?.orderId, res.order.id);
      assert.ok(exported.ledger.some((e) => e.category === "repair_loan_disbursement"));
      r.close();
      const storage = openStorage(b.dir, "demo");
      const repo = new EconomyRepo(storage);
      const imported = importCareer(repo, "demo", JSON.parse(JSON.stringify(exported)));
      assert.equal(imported.ok, true);
      assert.deepEqual(exportCareer(repo, "demo", T0), exported);
      storage.close();
      const again = rig(b.dir);
      assert.equal(again.fleet().aircraft[0]?.insurance?.repairLoan?.open?.loanId, res.loan.id);
      again.wait(GAME_MONTH_MS);
      assert.deepEqual(loanRows(again, res.loan.id).slice(-2), [
        ["interest", -500],
        ["repair_loan_payment", -6_013.74],
      ]);
      assertBalanced(again);
      again.close();
      // A v5 file from before repair loans (no kind on its loans) still imports.
      const c = tempDir();
      try {
        const s3 = openStorage(c.dir, "demo");
        const old = {
          ...exported,
          loans: [],
          ledger: exported.ledger.filter((e) => !e.category.startsWith("repair_loan")),
        };
        const res3 = importCareer(new EconomyRepo(s3), "demo", JSON.parse(JSON.stringify(old)));
        assert.equal(res3.ok, true);
        s3.close();
      } finally {
        c.cleanup();
      }
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});
