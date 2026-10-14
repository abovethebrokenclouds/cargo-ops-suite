// Hired pilots (plan §7.4, P6 optional) through the real ConnectorSession and storage:
// - hire and assign by command, simulated legs booked on the company clock, month rollover
//   (wages), the ledger balancing to the cent (`/api/ledger` balanced), per-leg money equal
//   to the pure rules computed independently;
// - honesty: no flight frames, no flight/telemetry domains, no logbook flights, no player
//   flight hours or milestones; the pilots domain says `simulated: true`;
// - the assigned aircraft is refused for `mission.load` with a clear reason;
// - persistence across a restart, migration 9 from a schema-8 database (idempotent), and the
//   career export round trip (pilots are optional: a version-5 file without them imports).

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PROTOCOL_VERSION,
  aircraftTypeByKey,
  type Command,
  type CompanyState,
  type FleetState,
  type Frame,
  type JobsState,
  type PilotsState,
  type Result,
} from "../src/protocol";
import {
  GAME_DAY_MS,
  GAME_MONTH_MS,
  fuelCost,
  fuelPrice,
  greatCircleNm,
  landingFee,
  legFuelBurnKg,
  legIncome,
  legLoadShare,
  legTimes,
  round1,
  type EconomyAirport,
} from "../src/economy";
import { loadAirportsData } from "../src/core/economy/airports-data";
import { ConnectorSession } from "../src/core/session";
import { economyApi } from "../src/server/economy-api";
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
  storage: Storage;
  repo: EconomyRepo;
  flights: FlightRepo;
  out: Frame[];
  cmd(name: string, args?: unknown): Result;
  ok<T>(name: string, args?: unknown): T;
  err(name: string, args?: unknown): string;
  company(): CompanyState;
  fleet(): FleetState;
  pilots(): PilotsState;
  jobs(): JobsState;
  ledger(): { balanced: boolean | null; entries: Array<{ category: string; amount: number }> };
  advance(ms: number): void;
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
  const api = economyApi({ session, repo, flights, database: "demo", now: () => clock.now });
  return {
    session,
    storage,
    repo,
    flights,
    out,
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
    pilots: () => dom<PilotsState>("pilots"),
    jobs: () => dom<JobsState>("jobs"),
    ledger() {
      const r = api({
        method: "GET",
        pathname: "/api/ledger",
        query: new URLSearchParams("limit=5000"),
        body: undefined,
      });
      assert.equal(r?.status, 200);
      return (r as { body: ReturnType<Rig["ledger"]> }).body;
    },
    advance(ms: number) {
      session.economy?.advanceGameTime(ms);
    },
    close: () => storage.close(),
  };
}

const cents = (x: number) => Math.round(x * 100);

describe("hired pilots through the connector", () => {
  it("hire, assign, simulated legs and a month rollover: the ledger balances to the cent", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const starter = r.fleet().aircraft[0];
      assert.ok(starter);
      assert.equal(starter.location, "KMEM");
      // Before any pilot: served airports come from the base and the job board.
      const d0 = r.pilots();
      assert.equal(d0.simulated, true);
      assert.deepEqual(d0.pilots, []);
      const boardDests = new Set(r.jobs().available.map((j) => j.destination));
      for (const icao of boardDests) assert.ok(d0.servedAirports.includes(icao), icao);
      const option = d0.options.find((o) => o.aircraftId === starter.id);
      assert.ok(option && option.destinations.length > 0);
      const dest = option.destinations[0];
      assert.ok(dest);

      const hired = r.ok<{ pilot: { id: string; name: string } }>("pilot.hire", {
        rating: "turboprop",
      });
      assert.equal(hired.pilot.id, "HP-1");
      assert.equal(r.company().cash, 242_500);
      r.ok("pilot.assign", {
        pilotId: "HP-1",
        aircraftId: starter.id,
        origin: "KMEM",
        destination: dest.icao,
      });
      assert.equal(r.fleet().aircraft[0]?.status, "hired");
      const p0 = r.pilots().pilots[0];
      assert.equal(p0?.status, "scheduled");
      assert.equal(p0?.assignment?.nextDepartureGameMs, 6 * HOUR);
      assert.equal(p0?.simulated, true);

      // The player cannot load a mission on it: clear reason.
      const job = r.jobs().available.find((j) => j.origin === "KMEM");
      assert.ok(job);
      r.ok("job.accept", { jobId: job.id });
      const load = r.cmd("mission.load", { jobIds: [job.id] });
      assert.equal(load.ok, false);
      if (!load.ok) {
        assert.equal(load.error.code, "aircraft_with_hired_pilot");
        assert.match(load.error.message, /hired pilot .*\(simulated\).*unassign/);
      }
      // Nor sell or repair it.
      assert.equal(r.err("fleet.sell", { aircraftId: starter.id }), "aircraft_busy");

      // One in-game day: legs depart and arrive on the company clock.
      const framesBefore = r.out.length;
      r.advance(GAME_DAY_MS);
      const p1 = r.pilots().pilots[0];
      assert.ok(p1);
      assert.ok(p1.legsFlown >= 2, `legs flown ${p1.legsFlown}`);
      // Every leg's money equals the pure rules computed independently here.
      const type = aircraftTypeByKey("c208b");
      assert.ok(type);
      const lookup = new Map(airports().map((a) => [a.ident, a]));
      const ledger = r.ledger();
      const rows = ledger.entries.filter((e) => e.category === "hired_income");
      assert.equal(rows.length, p1.legsFlown);
      for (const leg of p1.recent) {
        const from = lookup.get(leg.from);
        const to = lookup.get(leg.to);
        assert.ok(from && to);
        const nm = round1(greatCircleNm(from, to));
        const times = legTimes(type, nm);
        const inc = legIncome({
          type,
          distanceNm: nm,
          reputation: 50,
          share: legLoadShare(4242, "HP-1", leg.n),
        });
        assert.equal(leg.income, inc.income);
        assert.equal(leg.income, Math.round(inc.boardPayout * 50) / 100);
        assert.equal(leg.loadKg, inc.loadKg);
        assert.equal(leg.arriveGameMs - leg.departGameMs, times.blockMin * 60_000);
        assert.equal(leg.landingFee, landingFee(to, type));
        assert.equal(
          leg.fuel,
          fuelCost(legFuelBurnKg(type, times.blockMin), fuelPrice(to, airports())),
        );
      }
      assert.equal(ledger.balanced, true);

      // Honesty: no flight frames, no flight domain, no logbook, no player hours.
      const fresh = r.out.slice(framesBefore);
      const names = fresh.flatMap((f) => (f.type === "event" ? [f.name] : []));
      for (const banned of ["flight.started", "flight.ended", "touchdown", "phase.changed"]) {
        assert.ok(!names.includes(banned as never), banned);
      }
      for (const f of fresh) {
        assert.equal(f.source, "replay");
        if (f.type === "delta") {
          for (const k of ["flight", "position", "motion", "phase", "fuel"] as const) {
            assert.equal(f.patch[k], undefined, `${k} changed by a hired leg`);
          }
        }
      }
      assert.deepEqual(r.repo.logbook(), []);
      assert.deepEqual(r.flights.list(), []);
      const milestones = r.company().milestones ?? [];
      assert.ok(milestones.every((m) => !m.reached || m.id === "fleet_three"));
      const events = r.repo.listAircraftEvents().filter((e) => e.aircraftId === starter.id);
      assert.ok(events.some((e) => e.kind === "pilot_leg"));
      assert.ok(!events.some((e) => e.kind === "flight"));

      // Month rollover: the wage for month 2 is billed at the boundary; still balanced.
      r.advance(GAME_MONTH_MS);
      const after = r.ledger();
      const wages = after.entries.filter((e) => e.category === "pilot_wage");
      assert.equal(wages.length, 2);
      assert.ok(wages.every((e) => e.amount === -7_500));
      assert.equal(after.balanced, true);
      const sum = after.entries.reduce((s, e) => s + cents(e.amount), 0);
      assert.equal(sum, cents(r.company().cash) - cents(250_000));
      const pnl = r.pilots().pilots[0]?.pnl ?? [];
      assert.deepEqual(
        pnl.map((m) => [m.month, m.wages]),
        [
          [0, 7_500],
          [1, 7_500],
        ],
      );
      // Σ P&L income = Σ hired_income rows (to the cent).
      assert.equal(
        pnl.reduce((s, m) => s + cents(m.income), 0),
        after.entries
          .filter((e) => e.category === "hired_income")
          .reduce((s, e) => s + cents(e.amount), 0),
      );
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("a restart keeps the pilot, the route and a leg in progress", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const starter = r.fleet().aircraft[0];
      assert.ok(starter);
      const dest = r.pilots().options[0]?.destinations[0];
      assert.ok(dest);
      r.ok("pilot.hire", { rating: "turboprop" });
      r.ok("pilot.assign", { pilotId: "HP-1", aircraftId: starter.id, destination: dest.icao });
      r.advance(7 * HOUR);
      const before = r.pilots().pilots[0];
      assert.equal(before?.status, "flying");
      r.close();
      const again = rig(tmp.dir);
      const p = again.pilots().pilots[0];
      assert.deepEqual(p, before);
      assert.equal(again.fleet().aircraft[0]?.status, "hired");
      again.advance(4 * HOUR);
      assert.ok((again.pilots().pilots[0]?.legsFlown ?? 0) >= 1);
      assert.equal(again.ledger().balanced, true);
      again.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("commands validate with clear codes; unassign and fire release the aircraft", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      const starter = r.fleet().aircraft[0];
      assert.ok(starter);
      assert.equal(r.err("pilot.hire", {}), "bad_args");
      assert.equal(r.err("pilot.hire", { rating: "piston" }), "bad_args");
      assert.equal(r.err("pilot.fire", { pilotId: "HP-9" }), "unknown_pilot");
      r.ok("pilot.hire", { rating: "jet" });
      assert.equal(
        r.err("pilot.assign", { pilotId: "HP-1", aircraftId: starter.id, destination: "KATL" }),
        "rating_mismatch",
      );
      r.ok("pilot.hire", { rating: "turboprop" });
      assert.equal(
        r.err("pilot.assign", { pilotId: "HP-2", aircraftId: starter.id, destination: "ZZZZ" }),
        "airport_not_served",
      );
      assert.equal(
        r.err("pilot.assign", {
          pilotId: "HP-2",
          aircraftId: starter.id,
          origin: "KATL",
          destination: "KMEM",
        }),
        "aircraft_not_at_origin",
      );
      const lease = r.ok<{ id: string }>("fleet.lease", {
        typeKey: "kodiak100",
        kind: "dry",
        airport: "KMEM",
      });
      const dest = r.pilots().options[0]?.destinations[0];
      assert.ok(dest);
      assert.equal(
        r.err("pilot.assign", { pilotId: "HP-2", aircraftId: lease.id, destination: dest.icao }),
        "not_owned",
      );
      // A loaded mission keeps the aircraft with the player.
      const job = r.jobs().available.find((j) => j.origin === "KMEM");
      assert.ok(job);
      r.ok("job.accept", { jobId: job.id });
      r.ok("fleet.select", { aircraftId: starter.id });
      r.ok("mission.load", { jobIds: [job.id] });
      assert.equal(
        r.err("pilot.assign", { pilotId: "HP-2", aircraftId: starter.id, destination: dest.icao }),
        "aircraft_on_mission",
      );
      r.ok("mission.unload");
      r.ok("pilot.assign", { pilotId: "HP-2", aircraftId: starter.id, destination: dest.icao });
      assert.equal(r.err("pilot.unassign", { pilotId: "HP-1" }), "not_assigned");
      r.ok("pilot.unassign", { pilotId: "HP-2" });
      assert.equal(r.fleet().aircraft.find((a) => a.id === starter.id)?.status, "available");
      r.ok("pilot.assign", { pilotId: "HP-2", aircraftId: starter.id, destination: dest.icao });
      r.ok("pilot.fire", { pilotId: "HP-2" });
      assert.equal(r.fleet().aircraft.find((a) => a.id === starter.id)?.status, "available");
      assert.deepEqual(
        r.pilots().pilots.map((p) => [p.id, p.status]),
        [
          ["HP-1", "unassigned"],
          ["HP-2", "fired"],
        ],
      );
      // The aircraft is the player's again: the mission loads.
      r.ok("mission.load", { jobIds: [job.id] });
      assert.equal(r.ledger().balanced, true);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("/api/pilots serves the domain", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir);
      r.ok("pilot.hire", { rating: "turboprop" });
      const api = economyApi({
        session: r.session,
        repo: r.repo,
        flights: r.flights,
        database: "demo",
      });
      const res = api({
        method: "GET",
        pathname: "/api/pilots",
        query: new URLSearchParams(),
        body: undefined,
      });
      assert.equal(res?.status, 200);
      assert.deepEqual((res as { body: PilotsState }).body, r.pilots());
      const post = api({
        method: "POST",
        pathname: "/api/pilots",
        query: new URLSearchParams(),
        body: undefined,
      });
      assert.equal(post?.status, 405);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("hired pilots storage: migration 9, career export", () => {
  it("migrates a schema-8 database to 9 idempotently; the company loads and hires", () => {
    const tmp = tempDir();
    try {
      const { DatabaseSync } = loadSqlite();
      const db = new DatabaseSync(join(tmp.dir, "demo.db"));
      db.exec(
        "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
      );
      for (const m of MIGRATIONS.filter((x) => x.version <= 8)) {
        db.exec(m.sql);
        db.prepare("INSERT INTO schema_migrations VALUES (?, 0)").run(m.version);
      }
      assert.deepEqual(migrate(db), [9]);
      assert.deepEqual(migrate(db), []);
      // Re-running migration 9 by hand is safe (IF NOT EXISTS / OR REPLACE).
      const nine = MIGRATIONS.find((m) => m.version === 9);
      assert.ok(nine);
      db.exec(nine.sql);
      const t = db
        .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = ?")
        .get("hired_pilots") as { n: number };
      assert.equal(t.n, 1);
      db.close();
      // Versions stay unique and contiguous.
      assert.deepEqual(
        MIGRATIONS.map((m) => m.version),
        MIGRATIONS.map((_, i) => i + 1),
      );
      const r = rig(tmp.dir);
      assert.equal(r.storage.schemaVersion(), 9);
      r.ok("pilot.hire", { rating: "turboprop" });
      assert.equal(r.repo.listPilots().length, 1);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("career export round trip keeps the pilots; a version-5 file without pilots imports", () => {
    const a = tempDir();
    const b = tempDir();
    try {
      const r = rig(a.dir);
      const starter = r.fleet().aircraft[0];
      assert.ok(starter);
      const dest = r.pilots().options[0]?.destinations[0];
      assert.ok(dest);
      r.ok("pilot.hire", { rating: "turboprop" });
      r.ok("pilot.assign", { pilotId: "HP-1", aircraftId: starter.id, destination: dest.icao });
      r.ok("pilot.hire", { rating: "jet" });
      r.ok("pilot.fire", { pilotId: "HP-2" });
      r.advance(GAME_DAY_MS + 7 * HOUR);
      const exported = exportCareer(r.repo, "demo", T0);
      assert.equal(exported.version, 5);
      assert.equal(exported.pilots.length, 2);
      assert.equal(exported.company?.pilotCounter, 2);
      const pilots = r.pilots();
      r.close();

      const storage = openStorage(b.dir, "demo");
      const repo = new EconomyRepo(storage);
      const res = importCareer(repo, "demo", JSON.parse(JSON.stringify(exported)));
      assert.equal(res.ok, true);
      if (res.ok) assert.equal(res.counts.pilots, 2);
      assert.deepEqual(exportCareer(repo, "demo", T0), exported);
      storage.close();
      const again = rig(b.dir);
      assert.deepEqual(again.pilots().pilots, pilots.pilots);
      assert.equal(again.fleet().aircraft[0]?.status, "hired");
      again.close();

      // The same file without the optional pilots (as an older connector writes it): the
      // aircraft marked hired has no pilot, so it loads available; nothing else changes.
      const { pilots: _p, ...noPilots } = JSON.parse(JSON.stringify(exported)) as Record<
        string,
        unknown
      >;
      const s2 = openStorage(b.dir, "demo");
      const imported = importCareer(new EconomyRepo(s2), "demo", noPilots);
      assert.equal(imported.ok, true);
      if (imported.ok) assert.equal(imported.counts.pilots, 0);
      s2.close();
      const r2 = rig(b.dir);
      assert.deepEqual(r2.pilots().pilots, []);
      assert.equal(r2.fleet().aircraft[0]?.status, "available");
      assert.equal(r2.ledger().balanced, true);
      r2.close();
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  it("an imported file with two pilots on one aircraft loads with the extra pilot unassigned", () => {
    const a = tempDir();
    const b = tempDir();
    try {
      const r = rig(a.dir);
      const starter = r.fleet().aircraft[0];
      assert.ok(starter);
      const dest = r.pilots().options[0]?.destinations[0];
      assert.ok(dest);
      r.ok("pilot.hire", { rating: "turboprop" });
      r.ok("pilot.hire", { rating: "turboprop" });
      r.ok("pilot.assign", { pilotId: "HP-1", aircraftId: starter.id, destination: dest.icao });
      const exported = JSON.parse(JSON.stringify(exportCareer(r.repo, "demo", T0))) as {
        pilots: Array<{ id: string; assignment: unknown }>;
      };
      r.close();
      // Tamper: HP-2 claims the same aircraft.
      const one = exported.pilots.find((p) => p.id === "HP-1");
      const two = exported.pilots.find((p) => p.id === "HP-2");
      assert.ok(one && two);
      two.assignment = one.assignment;
      const storage = openStorage(b.dir, "demo");
      assert.equal(importCareer(new EconomyRepo(storage), "demo", exported).ok, true);
      storage.close();
      const again = rig(b.dir);
      const pilots = again.pilots().pilots;
      assert.deepEqual(
        pilots.map((p) => [p.id, p.status]),
        [
          ["HP-1", "scheduled"],
          ["HP-2", "unassigned"],
        ],
      );
      assert.equal(pilots[1]?.stopped?.code, "assignment_invalid");
      // The repair is persisted.
      const stored = again.repo.listPilots().find((p) => p.id === "HP-2");
      assert.equal(stored?.assignment, null);
      again.close();
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});
