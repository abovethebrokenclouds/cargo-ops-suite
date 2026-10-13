// P4 through the real ConnectorSession and storage: the starter aircraft, fleet and
// loan commands with clear error codes, the company clock driving loan auto-debits,
// missed payments and repossession, repairs that take in-game time, mission dispatch
// rules (aircraft at the origin, airworthiness, ambiguous TITLE), overspeed wear,
// migration of a P3 database and the P3 (version 1) career import.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PROTOCOL_VERSION,
  type Command,
  type CompanyState,
  type FixtureFrame,
  type FleetState,
  type Frame,
  type JobsState,
  type LedgerState,
  type LoansState,
  type Mission,
  type Result,
} from "../src/protocol";
import { GAME_MONTH_MS, flightWear, monthlyPayment, type EconomyAirport } from "../src/economy";
import { loadAirportsData } from "../src/core/economy/airports-data";
import { ConnectorSession } from "../src/core/session";
import { startConnector } from "../src/cli/app";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import { importCareer } from "../src/storage/career";
import { migrate, openStorage, type Storage } from "../src/storage/db";
import { EconomyRepo } from "../src/storage/economy";
import { FlightRepo } from "../src/storage/flights";
import { MIGRATIONS } from "../src/storage/migrations";
import { loadSqlite } from "../src/storage/db";
import { tempDir } from "./helpers";

const FIXTURE = join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl");
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);

let airportsCache: EconomyAirport[] | null = null;
const airports = () => (airportsCache ??= loadAirportsData().airports);

interface Rig {
  session: ConnectorSession;
  source: FakeSource;
  storage: Storage;
  repo: EconomyRepo;
  out: Frame[];
  clock: { now: number };
  cmd(name: string, args?: unknown): Result;
  ok<T>(name: string, args?: unknown): T;
  err(name: string, args?: unknown): string;
  company(): CompanyState;
  fleet(): FleetState;
  loans(): LoansState;
  ledger(): LedgerState;
  mission(): Mission | null;
  events(name: string): Frame[];
  /** Advance the wall clock by `ms` in ≤ 60 s ticks (the company clock follows). */
  wait(ms: number): void;
  close(): void;
}

function rig(dir: string, frames: FixtureFrame[] = loadFixture(FIXTURE)): Rig {
  const storage = openStorage(dir, "demo");
  const repo = new EconomyRepo(storage);
  const source = new FakeSource({ frames, manual: true });
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
    source,
    storage,
    repo,
    out,
    clock,
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
    ledger: () => dom<LedgerState>("ledger"),
    mission: () => (session.store.getDomain("mission") ?? null) as Mission | null,
    events: (name) => out.filter((f) => f.type === "event" && f.name === name),
    wait(ms: number) {
      // A few real ticks (wall Δ ≤ 60 s each), then the rest of the in-game time at once.
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

const sumCents = (repo: EconomyRepo) => Math.round(repo.ledgerTotals().sum * 100);

describe("P4 company, fleet and loans through the connector", () => {
  it("a new company owns one C208B at the base; domains are published", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const fleet = r.fleet();
      assert.equal(fleet.aircraft.length, 1);
      assert.deepEqual(
        {
          type: fleet.aircraft[0]?.typeKey,
          ownership: fleet.aircraft[0]?.ownership,
          location: fleet.aircraft[0]?.location,
          condition: fleet.aircraft[0]?.condition,
          financed: fleet.aircraft[0]?.financed,
        },
        { type: "c208b", ownership: "owned", location: "KMEM", condition: 100, financed: false },
      );
      assert.equal(fleet.selection, "single");
      const company = r.company();
      assert.equal(company.cash, 250_000);
      assert.equal(company.tierName, "Established");
      assert.equal(company.creditScore, 400);
      assert.equal(company.debt, 0);
      assert.equal(company.netWorth, 250_000 + 2_700_000);
      assert.deepEqual(company.clock, { gameMs: 0, month: 1, day: 1 });
      assert.equal(r.loans().offers.filter((o) => o.eligible).length, 1);
      assert.equal(r.ledger().entries, 0);
      // The TITLE (Grand Caravan) matches the owned C208B.
      r.source.playRange(0, 2);
      assert.equal(r.fleet().selection, "title");
      assert.equal(r.fleet().selectedId, fleet.aircraft[0]?.id);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("fleet and loan commands validate with clear error codes", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const starter = r.fleet().aircraft[0]?.id ?? "";
      assert.equal(r.err("fleet.buy", {}), "bad_args");
      assert.equal(r.err("fleet.buy", { typeKey: "concorde" }), "unknown_type");
      assert.equal(r.err("fleet.buy", { typeKey: "b738bcf" }), "reputation_gate");
      assert.equal(r.err("fleet.buy", { typeKey: "c208b" }), "insufficient_cash");
      assert.equal(r.err("fleet.buy", { typeKey: "c208b", airport: "ZZZZ" }), "unknown_airport");
      assert.equal(r.err("fleet.lease", { typeKey: "b748f", kind: "wet" }), "reputation_gate");
      assert.equal(r.err("fleet.sell", { aircraftId: "AC-99" }), "unknown_aircraft");
      assert.equal(r.err("fleet.return", { aircraftId: starter }), "not_leased");
      assert.equal(r.err("fleet.repair", { aircraftId: starter }), "no_wear");
      assert.equal(r.err("fleet.select", { aircraftId: "AC-99" }), "unknown_aircraft");
      assert.equal(
        r.err("loan.take", {
          lenderId: "altocirrus",
          principal: 100_000,
          termMonths: 36,
          collateral: { type: "aircraft", id: starter },
        }),
        "credit_score_too_low",
      );
      assert.equal(
        r.err("loan.take", {
          lenderId: "jetwash",
          principal: 2_600_000,
          termMonths: 36,
          collateral: { type: "aircraft", id: starter },
        }),
        "ltv_exceeded",
      );
      assert.equal(
        r.err("loan.take", {
          lenderId: "jetwash",
          principal: 100_000,
          termMonths: 36,
          collateral: { type: "fbo", id: "KMEM" },
        }),
        "unsupported_collateral",
      );
      assert.equal(r.err("loan.payoff", { loanId: "LN-9" }), "unknown_loan");
      const quotes = r.ok<{ quotes: Array<{ lenderId: string; ok: boolean; payment: number }> }>(
        "loan.quote",
        { principal: 400_000, termMonths: 36, collateral: { type: "aircraft", id: starter } },
      ).quotes;
      assert.deepEqual(
        quotes.map((q) => [q.lenderId, q.ok]),
        [
          ["altocirrus", false],
          ["vectorline", false],
          ["jetwash", true],
        ],
      );
      assert.equal(quotes[2]?.payment, monthlyPayment(400_000, 16.91, 36));
      // Nothing above changed cash.
      assert.equal(r.company().cash, 250_000);
      assert.equal(r.repo.ledgerTotals().count, 0);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("buy with financing, lease, select; loan auto-debits on the company clock; ledger balances", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const starter = r.fleet().aircraft[0]?.id ?? "";
      // Borrow against the starter, then buy a Kodiak with a second Jetwash loan.
      const loan = r.ok<{ id: string; payment: number; apr: number }>("loan.take", {
        lenderId: "jetwash",
        principal: 500_000,
        termMonths: 24,
        collateral: { type: "aircraft", id: starter },
      });
      assert.equal(loan.apr, 16.91);
      assert.equal(r.company().cash, 250_000 + 500_000 - 5_000);
      assert.equal(r.fleet().aircraft[0]?.financed, true);
      const leased = r.ok<{ id: string }>("fleet.lease", { typeKey: "pc6", kind: "wet" });
      assert.equal(r.company().cash, 745_000 - 5_750);
      assert.equal(r.err("fleet.sell", { aircraftId: leased.id }), "not_owned");
      r.ok("fleet.select", { aircraftId: leased.id });
      assert.equal(r.fleet().selection, "manual");
      assert.equal(r.session.economy?.jobsDomain().aircraft.typeKey, "pc6");
      r.ok("fleet.select", { aircraftId: null });

      // One in-game month later: loan payment + the lease's monthly fee.
      r.wait(GAME_MONTH_MS);
      const paid = r.events("loan.payment");
      assert.equal(paid.length, 1);
      const data = (paid[0] as { data: { amount: number; interest: number } }).data;
      assert.equal(data.amount, loan.payment);
      assert.equal(data.interest, Math.round(500_000 * (16.91 / 1200) * 100) / 100);
      assert.equal(r.company().clock?.month, 2);
      const lease = r.repo.listLedger(50, { category: "lease" });
      assert.equal(lease.length, 2);
      // Σ ledger = cash − starting cash; running balance on the newest row = cash.
      assert.equal(sumCents(r.repo), Math.round((r.company().cash - 250_000) * 100));
      assert.equal(r.repo.listLedger(1)[0]?.balance, r.company().cash);
      // Early payoff: no penalty, collateral released.
      const balance = r.loans().loans[0]?.balance ?? 0;
      const before = r.company().cash;
      r.ok("loan.payoff", { loanId: loan.id });
      assert.equal(r.company().cash, Math.round((before - balance) * 100) / 100);
      assert.equal(r.fleet().aircraft[0]?.financed, false);
      assert.equal(r.loans().loans[0]?.status, "paid_off");
      assert.equal(r.company().debt, 0);
      // Returning the lease (no wear) and persistence across a restart.
      r.ok("fleet.return", { aircraftId: leased.id });
      assert.equal(r.fleet().aircraft.length, 1);
      const cash = r.company().cash;
      r.close();
      const again = rig(tmp.dir);
      assert.equal(again.company().cash, cash);
      assert.equal(again.fleet().aircraft.length, 1);
      assert.equal(again.loans().loans[0]?.status, "paid_off");
      assert.equal(sumCents(again.repo), Math.round((cash - 250_000) * 100));
      again.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("missed payments: late fee and −5 reputation each, repossession after three", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const starter = r.fleet().aircraft[0]?.id ?? "";
      r.ok("loan.take", {
        lenderId: "jetwash",
        principal: 1_000_000,
        termMonths: 60,
        collateral: { type: "aircraft", id: starter },
      });
      // Spend the money: a wet-leased 737 (tier 3 lease needs tier 2 → allowed) month fee is
      // small, so buy time with leases until cash is below the payment.
      r.ok("fleet.lease", { typeKey: "b738bcf", kind: "wet" });
      r.ok("fleet.lease", { typeKey: "b738bcf", kind: "wet" });
      r.ok("fleet.lease", { typeKey: "b738bcf", kind: "wet" });
      r.ok("fleet.lease", { typeKey: "b738bcf", kind: "wet" });
      r.ok("fleet.lease", { typeKey: "b738bcf", kind: "wet" });
      r.ok("fleet.lease", { typeKey: "b738bcf", kind: "wet" });
      r.ok("fleet.lease", { typeKey: "b738bcf", kind: "wet" });
      r.ok("fleet.lease", { typeKey: "b738bcf", kind: "wet" });
      r.ok("fleet.lease", { typeKey: "b738bcf", kind: "wet" });
      r.ok("fleet.lease", { typeKey: "b738bcf", kind: "wet" });
      assert.ok(r.company().cash < 300_000);
      r.wait(3 * GAME_MONTH_MS);
      assert.equal(r.events("loan.missed").length >= 1, true);
      r.wait(3 * GAME_MONTH_MS);
      assert.equal(r.events("aircraft.repossessed").length, 1);
      assert.equal(r.loans().loans.at(-1)?.status, "defaulted");
      assert.ok(r.fleet().aircraft.every((a) => a.id !== starter));
      assert.ok((r.loans().defaultUntilGameMs ?? 0) > r.company().clock!.gameMs);
      const missed = r.events("loan.missed").length;
      assert.equal(r.company().reputation, 50 - 5 * missed);
      const lateFees = r.repo.listLedger(100, { category: "late_fee" });
      assert.equal(lateFees.length, missed);
      assert.equal(sumCents(r.repo), Math.round((r.company().cash - 250_000) * 100));
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("dispatch: the selected aircraft must be at the origin, airworthy and unambiguous", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      r.source.playRange(0, 2);
      r.ok("jobs.refresh", { airport: "KMEM", destination: "KATL" });
      const job = (r.session.store.getDomain("jobs") as JobsState).available.find(
        (j) => j.destination === "KATL",
      );
      assert.ok(job);
      r.ok("job.accept", { jobId: job.id });
      const starter = r.fleet().aircraft[0]?.id ?? "";
      // A second C208B at KMEM makes the TITLE ambiguous.
      const second = r.ok<{ id: string }>("fleet.lease", { typeKey: "c208b", kind: "dry" });
      assert.equal(r.fleet().ambiguous, true);
      assert.equal(r.err("mission.load", { jobIds: [job.id] }), "aircraft_ambiguous");
      // Unairworthy below 20 %.
      r.session.economy?.companyBook.updateAircraft(starter, { condition: 19.5 });
      r.ok("fleet.select", { aircraftId: starter });
      assert.equal(r.err("mission.load", { jobIds: [job.id] }), "aircraft_unairworthy");
      // In maintenance: blocked until the repair completes in in-game time.
      const repair = r.ok<{ cost: number; hours: number }>("fleet.repair", { aircraftId: starter });
      assert.equal(repair.cost, Math.round(0.08 * 2_700_000 * 80.5) / 100);
      assert.equal(repair.hours, 2 + 1.5 * 80.5);
      assert.equal(r.err("mission.load", { jobIds: [job.id] }), "aircraft_in_maintenance");
      r.wait(repair.hours * 3_600_000 + 60_000);
      assert.equal(r.events("repair.completed").length, 1);
      assert.equal(r.fleet().aircraft.find((a) => a.id === starter)?.condition, 100);
      // Not at the origin: the leased one moved to KBNA… simulate by selecting a lease at KBNA.
      r.ok("fleet.return", { aircraftId: second.id });
      const away = r.ok<{ id: string }>("fleet.lease", {
        typeKey: "c208b",
        kind: "dry",
        airport: "KBNA",
      });
      r.ok("fleet.select", { aircraftId: away.id });
      assert.equal(r.err("mission.load", { jobIds: [job.id] }), "aircraft_not_at_origin");
      r.ok("fleet.select", { aircraftId: starter });
      const m = r.ok<Mission>("mission.load", { jobIds: [job.id] });
      assert.equal(m.aircraftId, starter);
      // While loaded, the aircraft cannot be sold, repaired or swapped.
      assert.equal(r.err("fleet.sell", { aircraftId: starter }), "aircraft_on_mission");
      assert.equal(r.err("fleet.select", { aircraftId: away.id }), "mission_active");
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("an overspeed during the mission adds 5 points of wear", () => {
    const tmp = tempDir();
    try {
      const frames = loadFixture(FIXTURE).map((f, i) => {
        if (f.msg.type !== "delta" || i < 140 || i > 150) return f;
        const patch = structuredClone(f.msg.patch) as Record<string, unknown>;
        const motion = patch["motion"] as { iasKt: number } | undefined;
        if (motion) motion.iasKt = 190; // C208B Vmo 175 kt
        return { ...f, msg: { ...f.msg, patch } } as FixtureFrame;
      });
      const r = rig(tmp.dir, frames);
      r.ok("jobs.refresh", { airport: "KMEM", destination: "KATL" });
      const job = (r.session.store.getDomain("jobs") as JobsState).available.find(
        (j) => j.destination === "KATL",
      );
      assert.ok(job);
      r.ok("job.accept", { jobId: job.id });
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playAll();
      const m = r.mission();
      assert.equal(m?.status, "delivered");
      const log = r.repo.logbook()[0];
      const base = flightWear({
        airborneMin: log?.airborneMin ?? 0,
        peakG: log?.landing?.peakG ?? null,
        overspeedEvents: 0,
        crashed: false,
      }).total;
      assert.equal(m?.wear, Math.round((base + 5) * 100) / 100);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("P4 storage: migration and P3 career import", () => {
  it("migrates a P3 database (v3) idempotently and keeps its ledger balanced", () => {
    const tmp = tempDir();
    try {
      const { DatabaseSync } = loadSqlite();
      const path = join(tmp.dir, "demo.db");
      const db = new DatabaseSync(path);
      db.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      for (const m of MIGRATIONS.filter((x) => x.version <= 3)) {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, 0)").run(m.version);
      }
      const p3Company = {
        name: "Cargo Ops Logistics",
        base: "KMEM",
        cash: 257_124,
        reputation: 52,
        seed: 4242,
        boardCounter: 2,
        boards: [],
        aircraftTypeOverride: null,
      };
      db.prepare("INSERT INTO company VALUES ('company', ?, 0)").run(JSON.stringify(p3Company));
      db.prepare(
        "INSERT INTO ledger (at, category, amount, ref_type, ref_id, memo) VALUES (?, 'job_payout', 7124, 'job', 'J-1', 'p3')",
      ).run(T0);
      assert.deepEqual(migrate(db), [4]);
      assert.deepEqual(migrate(db), []);
      const row = db.prepare("SELECT category, balance, game_at FROM ledger").get() as {
        category: string;
        balance: number;
        game_at: number;
      };
      assert.deepEqual({ ...row }, { category: "mission_payout", balance: 257_124, game_at: 0 });
      db.close();

      const r = rig(tmp.dir);
      assert.equal(r.company().cash, 257_124);
      assert.equal(r.company().startingCash, 250_000);
      assert.equal(r.fleet().aircraft.length, 1); // starter granted to the P3 company
      assert.equal(r.ledger().entries, 1);
      assert.deepEqual(r.ledger().months[0], { month: 0, revenue: 7124, expense: 0, net: 7124 });
      assert.equal(r.storage.schemaVersion(), 4);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("imports a P3 (version 1) career export with sensible defaults", () => {
    const tmp = tempDir();
    try {
      const storage = openStorage(tmp.dir, "demo");
      const repo = new EconomyRepo(storage);
      const v1 = {
        format: "cargo-ops-career",
        version: 1,
        exportedAt: new Date(T0).toISOString(),
        database: "demo",
        company: {
          name: "Old Co",
          base: "KATL",
          cash: 251_000,
          reputation: 55,
          seed: 9,
          boardCounter: 1,
          boards: [],
          aircraftTypeOverride: null,
        },
        jobs: [],
        missions: [],
        ledger: [
          { at: T0, category: "job_payout", amount: 1_000, refType: "job", refId: "J", memo: null },
        ],
        flights: [],
      };
      const res = importCareer(repo, "demo", v1);
      assert.equal(res.ok, true);
      if (res.ok) assert.equal(res.version, 1);
      assert.equal(repo.listLedger(1)[0]?.category, "mission_payout");
      assert.equal(repo.listLedger(1)[0]?.balance, 251_000);
      assert.equal(repo.getCompany()?.startingCash, 250_000);
      storage.close();
      const r = rig(tmp.dir);
      assert.equal(r.company().name, "Old Co");
      assert.equal(r.fleet().aircraft[0]?.location, "KATL"); // starter at the imported base
      assert.equal(sumCents(r.repo), Math.round((r.company().cash - 250_000) * 100));
      r.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("P4 API", () => {
  it("/api/ledger, /api/fleet and /api/loans need the bearer token and report a balanced ledger", async () => {
    const tmp = tempDir();
    const source = new FakeSource({ frames: loadFixture(FIXTURE), manual: true });
    const c = await startConnector({
      sim: "fake",
      dataDir: tmp.dir,
      port: 0,
      quiet: true,
      source,
      economySeed: 4242,
      clockIntervalMs: 0,
    });
    try {
      for (const path of ["/api/ledger", "/api/fleet", "/api/loans"]) {
        assert.equal((await fetch(`${c.server.url}${path}`)).status, 401);
      }
      const auth = { headers: { Authorization: `Bearer ${c.token}` } };
      const starter = (c.session.store.getDomain("fleet") as FleetState).aircraft[0]?.id ?? "";
      const r = c.session.command({
        type: "command",
        v: PROTOCOL_VERSION,
        id: "x",
        name: "loan.take",
        args: {
          lenderId: "jetwash",
          principal: 100_000,
          termMonths: 12,
          collateral: { type: "aircraft", id: starter },
        },
      });
      assert.equal(r.ok, true);
      const ledger = (await (await fetch(`${c.server.url}/api/ledger`, auth)).json()) as {
        entries: Array<{ category: string; amount: number }>;
        balanced: boolean;
        cash: number;
      };
      assert.equal(ledger.balanced, true);
      assert.deepEqual(
        ledger.entries.map((e) => [e.category, e.amount]),
        [
          ["loan_fee", -1_000],
          ["loan_disbursement", 100_000],
        ],
      );
      assert.equal(ledger.cash, 349_000);
      const filtered = (await (
        await fetch(`${c.server.url}/api/ledger?category=loan_fee`, auth)
      ).json()) as { entries: unknown[] };
      assert.equal(filtered.entries.length, 1);
      assert.equal((await fetch(`${c.server.url}/api/ledger?category=DROP`, auth)).status, 400);
      const fleet = (await (await fetch(`${c.server.url}/api/fleet`, auth)).json()) as {
        aircraft: Array<{ financed: boolean }>;
        catalogue: Array<{ key: string; priceUsd: number; purchaseMinTier: number }>;
      };
      assert.equal(fleet.aircraft[0]?.financed, true);
      assert.equal(fleet.catalogue.find((t) => t.key === "b748f")?.purchaseMinTier, 4);
      const loans = (await (await fetch(`${c.server.url}/api/loans`, auth)).json()) as {
        loans: Array<{ status: string }>;
        lenders: unknown[];
      };
      assert.equal(loans.loans[0]?.status, "active");
      assert.equal(loans.lenders.length, 3);
    } finally {
      await c.stop();
      tmp.cleanup();
    }
  });
});
