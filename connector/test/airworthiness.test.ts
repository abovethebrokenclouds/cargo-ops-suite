// P5 through the real ConnectorSession and storage: the used market, buying uninspected →
// a hidden grounding defect refuses the first dispatch (mission.load and flight.start) with
// every reason → repair on in-game time → dispatch OK (plan acceptance: "a used aircraft
// with a grounding defect cannot be dispatched until repaired"); ferry permits and a ferry
// flight; defects after a hard landing and fuel exhaustion; migration of a P4 database;
// the career export v3; /api/market.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PROTOCOL_VERSION,
  type Command,
  type CompanyState,
  type FixtureFrame,
  type FleetAircraft,
  type FleetState,
  type Frame,
  type JobsState,
  type MarketState,
  type Mission,
  type Result,
} from "../src/protocol";
import {
  uninspectedHasHiddenGrounding,
  type EconomyAirport,
  type MaintenanceCapability,
} from "../src/economy";
import { loadAirportsData } from "../src/core/economy/airports-data";
import { ConnectorSession } from "../src/core/session";
import { startConnector } from "../src/cli/app";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import { exportCareer, importCareer } from "../src/storage/career";
import { loadSqlite, migrate, openStorage, type Storage } from "../src/storage/db";
import { EconomyRepo } from "../src/storage/economy";
import { FlightRepo } from "../src/storage/flights";
import { MIGRATIONS } from "../src/storage/migrations";
import { tempDir } from "./helpers";

const FIXTURE = join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl");
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const HOUR = 3_600_000;

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
  err(
    name: string,
    args?: unknown,
  ): { code: string; message: string; reasons?: Array<{ code: string }> | undefined };
  company(): CompanyState;
  fleet(): FleetState;
  aircraft(id: string): FleetAircraft | undefined;
  market(): MarketState;
  mission(): Mission | null;
  events(name: string): Frame[];
  wait(ms: number): void;
  close(): void;
}

function rig(
  dir: string,
  options: { frames?: FixtureFrame[]; maintenance?: MaintenanceCapability } = {},
): Rig {
  const storage = openStorage(dir, "demo");
  const repo = new EconomyRepo(storage);
  const source = new FakeSource({ frames: options.frames ?? loadFixture(FIXTURE), manual: true });
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
      ...(options.maintenance ? { maintenance: options.maintenance } : {}),
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
    err(name: string, args: unknown = {}) {
      const r = cmd(name, args);
      assert.equal(r.ok, false, `${name} should fail`);
      return r.ok ? { code: "", message: "" } : r.error;
    },
    company: () => dom<CompanyState>("company"),
    fleet: () => dom<FleetState>("fleet"),
    aircraft: (id) => dom<FleetState>("fleet").aircraft.find((a) => a.id === id),
    market: () => dom<MarketState>("market"),
    mission: () => (session.store.getDomain("mission") ?? null) as Mission | null,
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

/** Patch every frame's domains (e.g. payload weight, fuel, G). */
function mapFrames(
  frames: FixtureFrame[],
  fn: (patch: Record<string, Record<string, unknown> | undefined>, i: number) => void,
): FixtureFrame[] {
  return frames.map((f, i) => {
    if (f.msg.type !== "delta" && f.msg.type !== "snapshot") return f;
    const msg = structuredClone(f.msg) as unknown as Record<string, unknown>;
    const body = (msg["type"] === "delta" ? msg["patch"] : msg["state"]) as Record<
      string,
      Record<string, unknown> | undefined
    >;
    fn(body, i);
    return { ...f, msg } as unknown as FixtureFrame;
  });
}

const sumCents = (repo: EconomyRepo) => Math.round(repo.ledgerTotals().sum * 100);

describe("P5 used aircraft and airworthiness through the connector", () => {
  it("acceptance: a used aircraft with a grounding defect cannot be dispatched until repaired", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      // Seed 4242, market generation 1: UL-1-7 is a 4-year-old C208B at KYNG with no
      // disclosed defects whose uninspected purchase rolls a hidden grounding defect.
      const market = r.market();
      assert.equal(market.generation, 1);
      assert.equal(market.listings.length, 12);
      const listing = market.listings.find((l) => l.id === "UL-1-7");
      assert.ok(listing);
      assert.deepEqual(listing.knownDefects, []);
      const record = r.session.economy?.companyBook
        .listingRecords()
        .find((l) => l.id === listing.id);
      assert.ok(record && uninspectedHasHiddenGrounding(4242, record));
      // Hidden defects never reach a frame.
      assert.equal(JSON.stringify(r.out).includes('"hidden":true'), false);

      // Cash: a loan on the starter, then the purchase financed by Jetwash.
      const starter = r.fleet().aircraft[0]?.id ?? "";
      r.ok("loan.take", {
        lenderId: "jetwash",
        principal: 300_000,
        termMonths: 24,
        collateral: { type: "aircraft", id: starter },
      });
      assert.equal(r.err("market.buy", {}).code, "bad_args");
      assert.equal(r.err("market.buy", { listingId: "UL-9-9" }).code, "unknown_listing");
      const bought = r.ok<{ aircraft: { id: string }; inspected: boolean }>("market.buy", {
        listingId: listing.id,
        financing: { lenderId: "jetwash", termMonths: 36, principal: 1_900_000 },
      });
      assert.equal(bought.inspected, false);
      const id = bought.aircraft.id;
      const before = r.aircraft(id);
      assert.equal(before?.location, "KYNG");
      assert.equal(before?.airworthiness?.status, "airworthy"); // nothing known yet
      assert.equal(before?.financed, true);
      assert.equal(
        r.market().listings.some((l) => l.id === listing.id),
        false,
      );

      // First dispatch: a board at KYNG, a job, mission.load → refused with the reason.
      r.ok("fleet.select", { aircraftId: id });
      r.ok("jobs.refresh", { airport: "KYNG" });
      const job = (r.session.store.getDomain("jobs") as JobsState).available.find(
        (j) => j.origin === "KYNG",
      );
      assert.ok(job);
      r.ok("job.accept", { jobId: job.id });
      const refused = r.err("mission.load", { jobIds: [job.id] });
      assert.equal(refused.code, "aircraft_unairworthy");
      assert.match(refused.message, /Grounding defect/);
      assert.deepEqual(
        (refused.reasons as Array<{ code: string }>).map((x) => x.code),
        ["grounding_defect"],
      );
      assert.equal(r.events("defect.found").length, 1);
      assert.equal(r.events("aircraft.grounded").length, 1);
      const grounded = r.aircraft(id);
      assert.equal(grounded?.airworthy, false);
      assert.equal(grounded?.airworthiness?.status, "grounded");
      const found = grounded?.systems?.flatMap((s) => s.defects) ?? [];
      assert.equal(found.length, 1);
      assert.equal(found[0]?.severity, "grounding");
      assert.equal(found[0]?.cause, "purchase");
      // Still refused on a second try (the gate, no new reveal).
      assert.equal(r.err("mission.load", { jobIds: [job.id] }).code, "aircraft_unairworthy");
      assert.equal(r.events("defect.found").length, 1);

      // Repair (field rates at KYNG, a medium airport) → maintenance with an ETA.
      const order = r.ok<{ order: { cost: number; hours: number; shop: string } }>(
        "fleet.repairAll",
        { aircraftId: id },
      ).order;
      assert.equal(order.shop, "field");
      assert.equal(order.cost, Math.round(found[0]!.repairCost * 1.35 * 100) / 100);
      assert.equal(order.hours, Math.round(found[0]!.downtimeHours * 1.5 * 100) / 100);
      assert.equal(r.fleet().maintenance?.length, 1);
      assert.equal(r.err("mission.load", { jobIds: [job.id] }).code, "aircraft_in_maintenance");
      r.wait(order.hours * HOUR + 60_000);
      assert.equal(r.events("repair.completed").length, 1);
      assert.equal(r.aircraft(id)?.airworthiness?.status, "airworthy");
      // Dispatch OK.
      const m = r.ok<Mission>("mission.load", { jobIds: [job.id] });
      assert.equal(m.aircraftId, id);
      assert.equal(sumCents(r.repo), Math.round((r.company().cash - 250_000) * 100));
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("inspection fee and reveal; flight.start refused for an unairworthy aircraft; defer", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const l = r.market().listings.find((x) => x.id === "UL-1-8");
      assert.ok(l);
      const known = l.knownDefects.length;
      const insp = r.ok<{ fee: number }>("market.inspect", { listingId: l.id });
      assert.equal(insp.fee, Math.round(l.askingPrice * 0.005 * 100) / 100);
      assert.equal(r.err("market.inspect", { listingId: l.id }).code, "already_inspected");
      assert.equal(r.company().cash, 250_000 - insp.fee);
      r.wait(24 * HOUR + 60_000);
      const done = r.market().listings.find((x) => x.id === l.id);
      assert.equal(done?.inspection.status, "done");
      assert.equal(done?.knownDefects.length, known + (done?.inspection.found ?? 0));
      assert.equal(r.events("inspection.completed").length, 1);

      // The starter with a grounding and a minor defect, parked at KMEM where the sim is.
      const starter = r.fleet().aircraft[0]?.id ?? "";
      const book = r.session.economy?.companyBook;
      assert.ok(book);
      book.updateAircraft(starter, {
        defects: [
          {
            id: `${starter}-D1`,
            system: "gear",
            severity: "grounding",
            title: "Cracked gear leg fitting",
            repairCost: 60_750,
            downtimeHours: 60,
            hidden: false,
            cause: "hard_landing",
          },
          {
            id: `${starter}-D2`,
            system: "avionics",
            severity: "minor",
            title: "Intermittent COM2",
            repairCost: 5_400,
            downtimeHours: 6.4,
            hidden: false,
            cause: "wear",
          },
        ],
        defectCounter: 2,
      });
      r.source.playRange(0, 2);
      const start = r.err("flight.start");
      assert.equal(start.code, "aircraft_unairworthy");
      assert.deepEqual(
        (start.reasons as Array<{ code: string }>).map((x) => x.code),
        ["grounding_defect", "minor_not_deferred"],
      );
      assert.equal(
        r.err("fleet.defer", { aircraftId: starter, defectId: `${starter}-D1` }).code,
        "not_deferrable",
      );
      r.ok("fleet.defer", { aircraftId: starter, defectId: `${starter}-D2` });
      const reasons = r.aircraft(starter)?.airworthiness?.reasons.map((x) => x.code);
      assert.deepEqual(reasons, ["grounding_defect"]);
      const deferred = r.aircraft(starter)?.systems?.find((s) => s.key === "avionics")?.defects[0];
      assert.equal(deferred?.deferralHoursLeft, 30);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("ferry permit: one revenue-free flight to the maintenance airport with a payload cap", () => {
    const tmp = tempDir();
    try {
      // Only KATL is maintenance-capable here (the FBO lane's interface), so KMEM → KATL.
      const capability: MaintenanceCapability = { isMaintenanceCapable: (icao) => icao === "KATL" };
      const heavy = rig(tmp.dir, { maintenance: capability });
      const starter = heavy.fleet().aircraft[0]?.id ?? "";
      // 100 flight hours since the last annual: due.
      heavy.session.economy?.companyBook.updateAircraft(starter, { hours: 100 });
      heavy.session.economy?.publish();
      assert.equal(heavy.aircraft(starter)?.airworthiness?.status, "annual_due");
      assert.equal(heavy.aircraft(starter)?.airworthiness?.ferryEligible, true);
      const permit = heavy.ok<{ destination: string; payloadCapKg: number; fee: number }>(
        "fleet.ferryPermit",
        { aircraftId: starter },
      );
      assert.deepEqual(
        { d: permit.destination, cap: permit.payloadCapKg, fee: permit.fee },
        { d: "KATL", cap: 136, fee: 400 },
      );
      assert.equal(heavy.aircraft(starter)?.airworthiness?.status, "ferry_only");
      // No revenue: missions refuse the aircraft.
      heavy.ok("jobs.refresh", { airport: "KMEM", destination: "KATL" });
      const job = (heavy.session.store.getDomain("jobs") as JobsState).available[0];
      assert.ok(job);
      heavy.ok("job.accept", { jobId: job.id });
      assert.equal(heavy.err("mission.load", { jobIds: [job.id] }).code, "ferry_only");
      // The fixture carries 2,000 lb of payload: over the cap, the explicit start is refused.
      heavy.source.playRange(0, 2);
      assert.equal(heavy.err("flight.start").code, "ferry_payload_cap");
      heavy.close();

      // Same company, light payload (250 lb): the replayed flight is the ferry.
      const light = mapFrames(loadFixture(FIXTURE), (b) => {
        if (b["weights"]) b["weights"]["payloadLb"] = 250;
      });
      const r = rig(tmp.dir, { frames: light, maintenance: capability });
      const cash = r.company().cash;
      r.source.playAll();
      const a = r.aircraft(starter);
      assert.equal(a?.location, "KATL");
      assert.equal(a?.ferryPermit, undefined);
      assert.equal(a?.cycles, 1);
      const ferryRows = r.repo.listLedger(50).filter((e) => e.refType === "ferry");
      assert.deepEqual(ferryRows.map((e) => e.category).sort(), ["fuel", "landing_fee"]);
      assert.equal(r.repo.listLedger(50, { category: "mission_payout" }).length, 0);
      const costs = ferryRows.reduce((s, e) => s + e.amount, 0);
      assert.equal(Math.round(r.company().cash * 100), Math.round((cash + costs) * 100));
      // The annual is still due: do it at KATL (maintenance rates, $10,800, 16 h).
      assert.equal(a?.airworthiness?.status, "annual_due");
      const annual = r.ok<{ order: { cost: number; hours: number; shop: string } }>(
        "fleet.annual",
        { aircraftId: starter },
      ).order;
      assert.deepEqual(annual, { ...annual, cost: 10_800, hours: 16, shop: "maintenance" });
      r.wait(16 * HOUR + 60_000);
      assert.equal(r.aircraft(starter)?.airworthiness?.status, "airworthy");
      assert.equal(r.events("inspection.completed").length, 1);
      assert.equal(sumCents(r.repo), Math.round((r.company().cash - 250_000) * 100));
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("a hard landing (2.5 G) and dry tanks roll defects after the mission", () => {
    const tmp = tempDir();
    try {
      const frames = mapFrames(loadFixture(FIXTURE), (b, i) => {
        if (i >= 300 && b["fuel"]) b["fuel"]["totalLb"] = 0.5;
        if (i >= 325 && i <= 326 && b["motion"]) b["motion"]["gForce"] = 2.5;
      });
      const r = rig(tmp.dir, { frames });
      r.ok("jobs.refresh", { airport: "KMEM", destination: "KATL" });
      const job = (r.session.store.getDomain("jobs") as JobsState).available.find(
        (j) => j.destination === "KATL",
      );
      assert.ok(job);
      r.ok("job.accept", { jobId: job.id });
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playAll();
      assert.equal(r.mission()?.status, "delivered");
      const starter = r.fleet().aircraft[0];
      const defects = starter?.systems?.flatMap((s) => s.defects) ?? [];
      const causes = defects.map((d) => `${d.system}:${d.severity}:${d.cause}`).sort();
      assert.ok(causes.includes("engines:major:fuel_exhaustion"), causes.join(","));
      assert.ok(causes.includes("fuel:minor:fuel_exhaustion"), causes.join(","));
      assert.ok(
        defects.some((d) => d.cause === "hard_landing" && d.severity === "grounding"),
        causes.join(","),
      );
      assert.equal(r.events("defect.found").length, defects.length);
      assert.equal(r.events("aircraft.grounded").length, 1);
      assert.equal(starter?.airworthiness?.status, "grounded");
      r.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("P5 storage: migration from P4, career v3, /api/market", () => {
  it("migrates a P4 database (v4) to 5 idempotently; P4 aircraft get systems and a market", () => {
    const tmp = tempDir();
    try {
      const { DatabaseSync } = loadSqlite();
      const db = new DatabaseSync(join(tmp.dir, "demo.db"));
      db.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      for (const m of MIGRATIONS.filter((x) => x.version <= 4)) {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, 0)").run(m.version);
      }
      const p4Company = {
        name: "Cargo Ops Logistics",
        base: "KMEM",
        cash: 240_000,
        reputation: 55,
        seed: 4242,
        boardCounter: 1,
        boards: [],
        aircraftTypeOverride: null,
        startingCash: 250_000,
        gameMs: 5 * HOUR,
        monthBilled: 0,
        defaultUntilGameMs: null,
        fleetCounter: 1,
        loanCounter: 0,
        selectedAircraftId: null,
        pnl: [],
        ledgerCount: 1,
      };
      db.prepare("INSERT INTO company VALUES ('company', ?, 0)").run(JSON.stringify(p4Company));
      const p4Aircraft = {
        id: "AC-1",
        registration: "N123AB",
        typeKey: "c208b",
        ownership: "owned",
        status: "maintenance",
        location: "KATL",
        hours: 42.5,
        cycles: 20,
        condition: 87.5,
        purchasePrice: 0,
        acquiredAt: T0,
        acquiredGameMs: 0,
        readyAtGameMs: 9 * HOUR,
        loanId: null,
      };
      db.prepare(
        "INSERT INTO fleet (id, registration, type_key, ownership, status, location, condition, loan_id, acquired_at, json) VALUES ('AC-1', 'N123AB', 'c208b', 'owned', 'maintenance', 'KATL', 87.5, NULL, ?, ?)",
      ).run(T0, JSON.stringify(p4Aircraft));
      db.prepare(
        "INSERT INTO ledger (at, category, amount, ref_type, ref_id, memo, balance, game_at) VALUES (?, 'repair', -10000, 'aircraft', 'AC-1', 'p4', 240000, 0)",
      ).run(T0);
      assert.deepEqual(migrate(db), [5, 6]);
      assert.deepEqual(migrate(db), []);
      const phase = db.prepare("SELECT json FROM settings WHERE key = 'economy.phase'").get() as {
        json: string;
      };
      assert.equal(phase.json, "6");
      db.close();

      const r = rig(tmp.dir);
      assert.equal(r.storage.schemaVersion(), 6);
      const a = r.aircraft("AC-1");
      assert.equal(a?.condition, 87.5);
      assert.ok(a?.systems?.every((s) => s.condition === 87.5 && s.defects.length === 0));
      assert.equal(a?.annual?.lastHours, 42.5);
      assert.equal(a?.annual?.lastGameMs, 5 * HOUR);
      assert.equal(a?.maintenance?.length, 1); // the P4 repair became an overhaul order
      assert.equal(r.market().generation, 1);
      const rows = r.storage.db.prepare("SELECT COUNT(*) AS n FROM market_listings").get() as {
        n: number;
      };
      assert.equal(rows.n, 12);
      r.wait(4 * HOUR + 60_000);
      assert.equal(r.aircraft("AC-1")?.condition, 100);
      assert.equal(r.aircraft("AC-1")?.status, "available");
      assert.equal(sumCents(r.repo), Math.round((r.company().cash - 250_000) * 100));
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("career export v3 round trip keeps the market and P5 fleet fields; v2 imports", () => {
    const a = tempDir();
    const b = tempDir();
    try {
      const r = rig(a.dir);
      r.ok("market.inspect", { listingId: "UL-1-3" });
      const exported = exportCareer(r.repo, "demo", T0);
      assert.equal(exported.version, 4);
      assert.equal(exported.market.length, 12);
      assert.ok(exported.fleet[0]?.systems);
      const market = r.market();
      r.close();
      const storage = openStorage(b.dir, "demo");
      const repo = new EconomyRepo(storage);
      const res = importCareer(repo, "demo", JSON.parse(JSON.stringify(exported)));
      assert.equal(res.ok, true);
      if (res.ok) assert.equal(res.counts.market, 12);
      assert.deepEqual(exportCareer(repo, "demo", T0), exported);
      storage.close();
      const again = rig(b.dir);
      assert.deepEqual(again.market(), market);
      again.close();
      // A v2 (P4) export: fleet rows without P5 fields, no market.
      const v2 = {
        ...exported,
        version: 2,
        market: undefined,
        fleet: exported.fleet.map(
          ({ systems: _s, defects: _d, annual: _a, orders: _o, ferryPermit: _f, ...p4 }) => p4,
        ),
      };
      const s2 = openStorage(b.dir, "demo");
      const imported = importCareer(new EconomyRepo(s2), "demo", v2);
      assert.equal(imported.ok, true);
      s2.close();
      const r2 = rig(b.dir);
      assert.equal(r2.fleet().aircraft[0]?.systems?.length, 10);
      assert.equal(r2.market().generation, 2); // the company record still counts generations
      r2.close();
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it("/api/market needs the token and never shows hidden defects", async () => {
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
      assert.equal((await fetch(`${c.server.url}/api/market`)).status, 401);
      const res = await fetch(`${c.server.url}/api/market`, {
        headers: { Authorization: `Bearer ${c.token}` },
      });
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.equal(text.includes('"hidden":true'), false);
      const body = JSON.parse(text) as MarketState;
      assert.equal(body.listings.length, 12);
      assert.equal(body.generation, 1);
    } finally {
      await c.stop();
      tmp.cleanup();
    }
  });
});
