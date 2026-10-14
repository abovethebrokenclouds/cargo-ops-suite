// P5 part 2 through the real ConnectorSession and storage. Plan acceptance: "FBO income
// accrues from a replayed arrival; all new tables migrate from an existing database".
// - buy an FBO at KATL (financed), replay the KMEM→KATL fixture mission: the own arrival
//   books fuel at the farm's cost and waives the landing fee (fbo_transactions, source own),
//   then modelled traffic accrues over simulated in-game days (fbo_income, source modelled);
// - AI arrivals from a scripted fake (source sim_ai);
// - migration 6 from a P5-part-1 (schema 5) database, idempotent;
// - career export v4 round trip and v3 import; /api/fbos and /api/demand; insurance and
//   FBO command errors.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PROTOCOL_VERSION,
  type Command,
  type CompanyState,
  type DemandState,
  type FbosState,
  type FleetState,
  type Frame,
  type Mission,
  type Result,
} from "../src/protocol";
import {
  GAME_DAY_MS,
  airportSize,
  emptyLevels,
  fuelPrice,
  fuelPricing,
  trafficHour,
  type EconomyAirport,
} from "../src/economy";
import { loadAirportsData } from "../src/core/economy/airports-data";
import { ConnectorSession } from "../src/core/session";
import { economyApi } from "../src/server/economy-api";
import { FakeAiTraffic } from "../src/sim/ai-traffic";
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
  flights: FlightRepo;
  out: Frame[];
  clock: { now: number };
  cmd(name: string, args?: unknown): Result;
  ok<T>(name: string, args?: unknown): T;
  err(name: string, args?: unknown): string;
  company(): CompanyState;
  fleet(): FleetState;
  fbos(): FbosState;
  demand(): DemandState;
  mission(): Mission | null;
  events(name: string): Frame[];
  wait(ms: number): void;
  close(): void;
}

function rig(dir: string): Rig {
  const storage = openStorage(dir, "demo");
  const repo = new EconomyRepo(storage);
  const flights = new FlightRepo(storage, "replay");
  const source = new FakeSource({ frames: loadFixture(FIXTURE), manual: true });
  const clock = { now: T0 };
  let n = 0;
  let missionN = 0;
  let flightN = 0;
  const session = new ConnectorSession(source, () => {}, {
    repo: flights,
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
    flights,
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
      return r.ok ? "" : r.error.code;
    },
    company: () => dom<CompanyState>("company"),
    fleet: () => dom<FleetState>("fleet"),
    fbos: () => dom<FbosState>("fbos"),
    demand: () => dom<DemandState>("demand"),
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

const sumCents = (repo: EconomyRepo) => Math.round(repo.ledgerTotals().sum * 100);

/** Buy the KATL FBO (Jetwash, $600,000), then fly the replayed KMEM→KATL mission. */
function katlScenario(r: Rig): { fboId: string; mission: Mission } {
  const bought = r.ok<{ fbo: { id: string; price: number }; loan: { id: string } }>("fbo.buy", {
    icao: "KATL",
    financing: { lenderId: "jetwash", termMonths: 60, principal: 600_000 },
  });
  assert.equal(bought.fbo.price, 774_000);
  r.source.playRange(0, 2);
  r.ok("jobs.refresh", { airport: "KMEM", destination: "KATL" });
  const job = r.session.economy?.jobsDomain().available.find((j) => j.destination === "KATL");
  assert.ok(job);
  r.ok("job.accept", { jobId: job.id });
  r.ok("mission.load", { jobIds: [job.id] });
  r.source.playAll();
  const mission = r.mission();
  assert.ok(mission);
  return { fboId: bought.fbo.id, mission };
}

describe("P5 part 2 FBOs through the connector", () => {
  it("acceptance: FBO income accrues from a replayed arrival and from modelled traffic", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      assert.equal(r.company().cash, 250_000);
      const { fboId, mission } = katlScenario(r);
      assert.equal(mission.status, "delivered");
      // The P3 payout is unchanged (no demand on day 0, no terminal at KMEM).
      assert.equal(mission.payout?.total, 7_124);
      // Own arrival at the KATL FBO: 623.1 lb = 282.63 kg at the farm's cost $1.800 (not $1.915) and
      // the $300 landing fee waived.
      const fuel = mission.payout?.costs?.find((c) => c.key === "fuel");
      const fee = mission.payout?.costs?.find((c) => c.key === "landing_fee");
      assert.equal(fuel?.amount, 508.74);
      assert.equal(fee?.amount, 0);
      assert.equal(mission.payout?.net, 7_124 - 508.74);
      const own = r.repo.listFboTransactions({ fboId }).filter((t) => t.source === "own");
      assert.deepEqual(
        own.map((t) => [t.kind, t.amount]),
        [
          ["fuel_at_cost", 32.5],
          ["landing_fee_waived", 300],
        ],
      );
      const katl = r.fbos().fbos[0];
      assert.equal(katl?.today.own, 332.5);
      assert.ok(
        r
          .events("fbo.income")
          .some((f) => f.type === "event" && (f.data as { source?: string }).source === "own"),
      );
      // Cash: 250,000 − 774,000 + 600,000 − 6,000 (fee) + 7,124 − 508.74.
      assert.equal(r.company().cash, 76_615.26);
      assert.equal(sumCents(r.repo), Math.round((r.company().cash - 250_000) * 100));

      // Modelled traffic over simulated in-game time: day 0 recomputed independently.
      const acquired = katl?.acquiredGameMs ?? 0;
      const a = airports().find((x) => x.ident === "KATL");
      assert.ok(a);
      const fp = fuelPricing(fuelPrice(a, airports()).usdPerKg, 1, 1);
      let day0 = 0;
      let kg = 0;
      for (let h = Math.ceil(acquired / HOUR); h < 24; h++) {
        const t = trafficHour(
          {
            companySeed: 4242,
            icao: "KATL",
            airportType: "large",
            s: airportSize(a).s,
            levels: { ...emptyLevels(), ramp: 1, fuel: 1 },
            fuel: fp,
            handlingFeeUsd: 80,
            fuelSoldTodayKg: kg,
          },
          h,
        );
        day0 += t.total;
        kg += t.fuelKg;
      }
      const left = GAME_DAY_MS - (r.company().clock?.gameMs ?? 0);
      r.wait(left + 2 * GAME_DAY_MS);
      const income = r.repo.listLedger(1_000, { category: "fbo_income" }).reverse();
      assert.equal(income.length, 3);
      assert.equal(Math.round((income[0]?.amount ?? 0) * 100), Math.round(day0 * 100));
      const modelled = r.repo.listFboTransactions({ fboId }).filter((t) => t.source === "modelled");
      assert.ok(modelled.length >= 3);
      assert.equal(
        Math.round(modelled.reduce((s, t) => s + t.amount, 0) * 100),
        Math.round(income.reduce((s, e) => s + e.amount, 0) * 100),
      );
      const state = r.fbos().fbos[0];
      assert.equal(state?.daily.length, 3);
      assert.ok((state?.daily[1]?.movements ?? 0) > 10);
      assert.ok((state?.pnl[0]?.income ?? 0) > 3_000);
      assert.equal(sumCents(r.repo), Math.round((r.company().cash - 250_000) * 100));
      // Milestones from the scenario: first delivery and first FBO, with dates.
      const reached = r
        .company()
        .milestones?.filter((m) => m.reached)
        .map((m) => m.id);
      assert.deepEqual(reached?.sort(), ["first_delivery", "first_fbo"]);
      assert.ok(r.events("milestone.reached").length >= 2);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("AI arrivals from the simulator (scripted fake) are a labelled sim_ai bonus", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      // No FBO yet: nothing is credited.
      r.session.economy?.onAiTraffic(
        [{ objectId: 7, lat: 33.6367, lon: -84.4281, onGround: true, gsKt: 5 }],
        T0,
      );
      r.ok("fbo.buy", {
        icao: "KATL",
        financing: { lenderId: "jetwash", termMonths: 60, principal: 600_000 },
      });
      const cash = r.company().cash;
      const fake = new FakeAiTraffic(
        [
          // DAL123 on final 3 km out, then rolling out, then slow on the taxiway.
          {
            at: T0 + 30_000,
            samples: [
              {
                objectId: 11,
                lat: 33.62,
                lon: -84.45,
                onGround: false,
                gsKt: 140,
                atcId: "DAL123",
              },
              { objectId: 12, lat: 33.64, lon: -84.43, onGround: true, gsKt: 0, atcId: "GATE1" },
            ],
          },
          {
            at: T0 + 60_000,
            samples: [
              { objectId: 11, lat: 33.635, lon: -84.44, onGround: true, gsKt: 60, atcId: "DAL123" },
              { objectId: 12, lat: 33.64, lon: -84.43, onGround: true, gsKt: 0, atcId: "GATE1" },
            ],
          },
          {
            at: T0 + 90_000,
            samples: [
              { objectId: 11, lat: 33.64, lon: -84.435, onGround: true, gsKt: 12, atcId: "DAL123" },
              { objectId: 12, lat: 33.64, lon: -84.43, onGround: true, gsKt: 0, atcId: "GATE1" },
            ],
          },
          {
            at: T0 + 120_000,
            samples: [
              { objectId: 11, lat: 33.64, lon: -84.435, onGround: true, gsKt: 0, atcId: "DAL123" },
            ],
          },
        ],
        (samples, at) => r.session.economy?.onAiTraffic(samples, at),
      );
      fake.playAll();
      const ai = r.repo.listFboTransactions().filter((t) => t.source === "sim_ai");
      assert.equal(ai.length, 1); // DAL123 once; the parked GATE1 never
      // Ramp $15 + handling $80 × e(1) + 400 kg × ($1.915 − $1.800) × e(1) = $141.
      assert.equal(ai[0]?.amount, 141);
      assert.equal(r.company().cash, Math.round((cash + 141) * 100) / 100);
      assert.equal(r.fbos().fbos[0]?.aiArrivals, 1);
      assert.equal(r.fbos().fbos[0]?.today.simAi, 141);
      const entry = r.repo.listLedger(1, { category: "fbo_income" })[0];
      assert.match(entry?.memo ?? "", /AI arrival observed in the simulator \(bonus/);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("FBO, module, pricing and insurance commands validate with clear codes", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const starter = r.fleet().aircraft[0]?.id ?? "";
      assert.equal(r.err("fbo.buy", {}), "bad_args");
      assert.equal(r.err("fbo.buy", { icao: "ZZZZ" }), "unknown_airport");
      assert.equal(r.err("fbo.buy", { icao: "KATL" }), "insufficient_cash");
      const built = r.ok<{ fbo: { id: string; status: string } }>("fbo.build", { icao: "KLIT" });
      assert.equal(built.fbo.status, "building");
      assert.equal(r.err("fbo.buy", { icao: "KLIT" }), "fbo_exists");
      assert.equal(
        r.err("fbo.module.buy", { fboId: built.fbo.id, module: "hangar" }),
        "fbo_building",
      );
      assert.equal(r.err("fbo.module.buy", { fboId: "FBO-9", module: "hangar" }), "unknown_fbo");
      assert.equal(r.err("fbo.sell", { fboId: built.fbo.id }), "fbo_building");
      assert.equal(r.err("fbo.pricing", { fboId: built.fbo.id, fuelPriceRatio: 2 }), "bad_args");
      r.ok("fbo.pricing", { fboId: built.fbo.id, fuelPriceRatio: 1.05, handlingFeeUsd: 95 });
      r.wait(5 * GAME_DAY_MS + HOUR);
      assert.equal(r.fbos().fbos[0]?.status, "active");
      assert.ok(r.events("fbo.built").length >= 1);
      r.ok("fbo.module.buy", { fboId: built.fbo.id, module: "maintenance" });
      assert.equal(r.fbos().fbos[0]?.queue[0]?.module, "maintenance");
      assert.equal(r.fbos().fbos[0]?.pricing.handlingFeeUsd, 95);
      // Insurance.
      assert.equal(r.err("insurance.buy", { aircraftId: "AC-9" }), "unknown_aircraft");
      const premium = r.ok<{ premium: number }>("insurance.buy", { aircraftId: starter }).premium;
      assert.ok(premium > 7_000 && premium < 8_200);
      assert.equal(r.fleet().aircraft[0]?.insurance?.insured, true);
      assert.equal(r.err("insurance.buy", { aircraftId: starter }), "already_insured");
      r.ok("insurance.cancel", { aircraftId: starter });
      assert.equal(r.fleet().aircraft[0]?.insurance?.insured, false);
      const policy = r.storage.db.prepare("SELECT COUNT(*) AS n FROM insurance_policies").get() as {
        n: number;
      };
      assert.equal(policy.n, 0);
      assert.equal(sumCents(r.repo), Math.round((r.company().cash - 250_000) * 100));
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("demand events reach the demand domain; /api/fbos, /api/fbos/quote and /api/demand", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      r.wait(4 * GAME_DAY_MS);
      // Seed 4242, KMEM base: the first event is a storm at KIND from day 3 (one day).
      const ev = r.events("demand.event")[0];
      assert.ok(ev && ev.type === "event");
      assert.equal((ev.data as { event: { id: string } }).event.id, "EV-3-KIND");
      const api = economyApi({
        session: r.session,
        repo: r.repo,
        flights: r.flights,
        database: "demo",
        now: () => T0,
      });
      const get = (pathname: string, q = "") =>
        api({ method: "GET", pathname, query: new URLSearchParams(q), body: undefined });
      const demand = get("/api/demand");
      assert.equal(demand?.status, 200);
      assert.deepEqual((demand as { body: DemandState }).body, r.demand());
      const quote = get("/api/fbos/quote", "icao=katl");
      assert.equal(quote?.status, 200);
      assert.equal((quote as { body: { buyPrice: number } }).body.buyPrice, 774_000);
      assert.equal(get("/api/fbos/quote", "icao=")?.status, 400);
      assert.equal(get("/api/fbos/quote", "icao=ZZZZ")?.status, 404);
      const fbos = get("/api/fbos");
      assert.equal(fbos?.status, 200);
      assert.deepEqual(
        (fbos as { body: { fbos: unknown[]; transactions: unknown[] } }).body.fbos,
        [],
      );
      assert.equal(get("/api/fbos", "fbo=bad id")?.status, 400);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("P5 part 2 storage: migration 6 from schema 5, career v4", () => {
  it("migrates a P5-part-1 database (v5) to 6 idempotently; the company loads and buys an FBO", () => {
    const tmp = tempDir();
    try {
      const { DatabaseSync } = loadSqlite();
      const db = new DatabaseSync(join(tmp.dir, "demo.db"));
      db.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      for (const m of MIGRATIONS.filter((x) => x.version <= 5)) {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, 0)").run(m.version);
      }
      const p5Company = {
        name: "Cargo Ops Logistics",
        base: "KMEM",
        cash: 900_000,
        reputation: 55,
        seed: 4242,
        boardCounter: 1,
        boards: [],
        aircraftTypeOverride: null,
        startingCash: 250_000,
        gameMs: 40 * GAME_DAY_MS + 5 * HOUR,
        monthBilled: 1,
        defaultUntilGameMs: null,
        fleetCounter: 1,
        loanCounter: 0,
        selectedAircraftId: null,
        pnl: [],
        ledgerCount: 1,
        marketGeneration: 1,
        marketRefreshedGameMs: 0,
        orderCounter: 0,
      };
      db.prepare("INSERT INTO company VALUES ('company', ?, 0)").run(JSON.stringify(p5Company));
      const p5Aircraft = {
        id: "AC-1",
        registration: "N123AB",
        typeKey: "c208b",
        ownership: "owned",
        status: "available",
        location: "KATL",
        hours: 40,
        cycles: 20,
        condition: 95,
        purchasePrice: 0,
        acquiredAt: T0,
        acquiredGameMs: 0,
        readyAtGameMs: null,
        loanId: null,
        ageYears: 0,
        defects: [],
        orders: [],
        ferryPermit: null,
        defectCounter: 0,
      };
      db.prepare(
        "INSERT INTO fleet (id, registration, type_key, ownership, status, location, condition, loan_id, acquired_at, json) VALUES ('AC-1', 'N123AB', 'c208b', 'owned', 'available', 'KATL', 95, NULL, ?, ?)",
      ).run(T0, JSON.stringify(p5Aircraft));
      db.prepare(
        "INSERT INTO ledger (at, category, amount, ref_type, ref_id, memo, balance, game_at) VALUES (?, 'adjustment', 650000, NULL, NULL, 'p5', 900000, 0)",
      ).run(T0);
      assert.deepEqual(migrate(db), [6, 7]);
      assert.deepEqual(migrate(db), []);
      // Idempotent SQL: re-running migration 6 by hand changes nothing and does not fail.
      const six = MIGRATIONS.find((m) => m.version === 6);
      assert.ok(six);
      db.exec(six.sql);
      for (const table of [
        "fbos",
        "fbo_modules",
        "fbo_transactions",
        "demand_events",
        "demand_index",
        "insurance_policies",
        "milestones",
      ]) {
        const row = db
          .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
          .get(table) as { n: number };
        assert.equal(row.n, 1, table);
      }
      const phase = db.prepare("SELECT json FROM settings WHERE key = 'economy.phase'").get() as {
        json: string;
      };
      // "6": re-running migration 6 by hand above rewrote the marker (migration 7 had set 7).
      assert.equal(phase.json, "6");
      db.close();

      const r = rig(tmp.dir);
      assert.equal(r.storage.schemaVersion(), 7);
      assert.equal(r.company().cash, 900_000);
      assert.equal(r.fleet().aircraft[0]?.insurance?.insured, false);
      assert.equal(r.company().milestones?.length, 8);
      // A day boundary later the (retroactive-free) demand clock starts from day 40.
      r.ok("fbo.buy", { icao: "KATL" });
      r.wait(GAME_DAY_MS);
      assert.equal(r.repo.listLedger(10, { category: "fbo_income" }).length, 1);
      const modules = r.storage.db
        .prepare("SELECT kind, level FROM fbo_modules ORDER BY kind")
        .all() as Array<{
        kind: string;
        level: number;
      }>;
      assert.deepEqual(
        modules.map((m) => [m.kind, m.level]),
        [
          ["cargo", 0],
          ["fuel", 1],
          ["hangar", 0],
          ["maintenance", 0],
          ["ramp", 1],
        ],
      );
      const milestones = r.storage.db.prepare("SELECT id FROM milestones").all() as Array<{
        id: string;
      }>;
      assert.deepEqual(
        milestones.map((m) => m.id),
        ["first_fbo"],
      );
      assert.equal(sumCents(r.repo), Math.round((r.company().cash - 250_000) * 100));
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("career export v4 round trip keeps FBOs, transactions, events and milestones; v3 imports", () => {
    const a = tempDir();
    const b = tempDir();
    try {
      const r = rig(a.dir);
      katlScenario(r);
      r.wait(4 * GAME_DAY_MS);
      const exported = exportCareer(r.repo, "demo", T0);
      assert.equal(exported.version, 5);
      assert.equal(exported.fbos.length, 1);
      assert.ok(exported.fboTransactions.length > 4);
      assert.ok(exported.demandEvents.length >= 1);
      assert.ok((exported.company?.milestones.length ?? 0) >= 2);
      const fbos = r.fbos();
      r.close();
      const storage = openStorage(b.dir, "demo");
      const repo = new EconomyRepo(storage);
      const res = importCareer(repo, "demo", JSON.parse(JSON.stringify(exported)));
      assert.equal(res.ok, true);
      if (res.ok) assert.equal(res.counts.fbos, 1);
      assert.deepEqual(exportCareer(repo, "demo", T0), exported);
      storage.close();
      const again = rig(b.dir);
      assert.deepEqual(again.fbos(), fbos);
      again.close();
      // A v3 (P5 part 1) export: no FBO keys, company and fleet without P5-part-2 fields.
      const company = exported.company;
      assert.ok(company);
      const {
        fboCounter: _f,
        dayProcessed: _d,
        activity: _a,
        flightHours: _h,
        deliveries: _del,
        landingStreak: _l,
        restorations: _r,
        milestones: _m,
        ...p5company
      } = company;
      const v3 = {
        ...exported,
        version: 3,
        company: p5company,
        fbos: undefined,
        fboTransactions: undefined,
        demandEvents: undefined,
        fleet: exported.fleet.map(({ insurance: _i, incidents: _inc, ...p5 }) => p5),
      };
      const s3 = openStorage(b.dir, "demo");
      const imported = importCareer(new EconomyRepo(s3), "demo", v3);
      assert.equal(imported.ok, true);
      s3.close();
      const r3 = rig(b.dir);
      assert.deepEqual(r3.fbos().fbos, []);
      assert.equal(r3.fleet().aircraft[0]?.insurance?.insured, false);
      r3.close();
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});
