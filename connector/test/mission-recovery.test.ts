// Mission recovery through the real ConnectorSession and storage (docs/ECONOMY.md "Mission
// lifecycle and verification"): a mission aborted while its flight is still running releases
// the aircraft and pays the flight's real costs when that flight ends (no payout), and a
// connector restart in the middle of a flight never leaves the mission or the aircraft stuck.
// Leg 1 replays the synthetic KMEM → KATL fixture; leg 2 KATL → KRDU is the same SYNTHETIC
// fixture re-projected onto that route (connector/test/transit-leg.ts). Neither is simulator
// telemetry.

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
  type Job,
  type JobsState,
  type Mission,
  type Result,
} from "../src/protocol";
import { airportLookup, type EconomyAirport } from "../src/economy";
import { loadAirportsData } from "../src/core/economy/airports-data";
import { ConnectorSession } from "../src/core/session";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import { openStorage, type Storage } from "../src/storage/db";
import { EconomyRepo } from "../src/storage/economy";
import { FlightRepo } from "../src/storage/flights";
import { tempDir } from "./helpers";
import { reprojectLeg } from "./transit-leg";

const FIXTURE = join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl");
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
/** Frame index well into the climb of the KMEM → KATL fixture (airborne from frame 52). */
const AIRBORNE = 150;

let airportsCache: EconomyAirport[] | null = null;
const airports = () => (airportsCache ??= loadAirportsData().airports);
const apt = (icao: string): EconomyAirport => {
  const a = airportLookup(airports()).get(icao);
  if (!a) throw new Error(icao);
  return a;
};

interface Rig {
  session: ConnectorSession;
  source: FakeSource;
  storage: Storage;
  repo: EconomyRepo;
  cmd(name: string, args?: unknown): Result;
  ok<T>(name: string, args?: unknown): T;
  jobs(): JobsState;
  company(): CompanyState;
  fleet(): FleetState;
  mission(): Mission | null;
  events(name: string): Frame[];
  close(): void;
}

function rig(dir: string, frames: FixtureFrame[], prefix = "M"): Rig {
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
    newId: () => `${prefix}-flight-${++flightN}`,
    economy: {
      repo,
      airports: airports(),
      seed: 4242,
      replay: true,
      now: () => clock.now,
      newId: () => `${prefix}-${++missionN}`,
    },
  });
  const out: Frame[] = [];
  session.store.subscribe((f) => out.push(f));
  session.start();
  const cmd = (name: string, args: unknown = {}): Result =>
    session.command({ type: "command", v: PROTOCOL_VERSION, id: `c${++n}`, name, args } as Command);
  return {
    session,
    source,
    storage,
    repo,
    cmd,
    ok<T>(name: string, args: unknown = {}): T {
      const r = cmd(name, args);
      if (!r.ok) assert.fail(`${name} failed: ${r.error.code} ${r.error.message}`);
      return r.data as T;
    },
    jobs: () => session.store.getDomain("jobs") as JobsState,
    company: () => session.store.getDomain("company") as CompanyState,
    fleet: () => session.store.getDomain("fleet") as FleetState,
    mission: () => (session.store.getDomain("mission") ?? null) as Mission | null,
    events: (name) => out.filter((f) => f.type === "event" && f.name === name),
    close: () => storage.close(),
  };
}

function acceptTo(r: Rig, dest: string): Job {
  r.ok("jobs.refresh", { airport: "KMEM", destination: dest });
  const job = r.jobs().available.find((j) => j.destination === dest);
  assert.ok(job, `the focused board has a ${dest} job`);
  r.ok("job.accept", { jobId: job.id });
  return job;
}

const cents = (n: number) => Math.round(n * 100);
const sumCosts = (m: Mission | null) => (m?.costs ?? []).reduce((s, c) => s + c.amount, 0);

/** The ledger still balances: Σ amounts = cash − starting cash. */
function assertBalanced(r: Rig): void {
  assert.equal(cents(r.repo.ledgerTotals().sum), cents(r.company().cash - 250_000));
}

describe("mission.abort while the flight is running", () => {
  it("releases the aircraft and books the flight's real costs when it ends, no payout", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir, loadFixture(FIXTURE));
      const job = acceptTo(r, "KATL");
      r.ok("mission.load", { jobIds: [job.id] });
      const cash0 = r.company().cash;
      const rep0 = r.company().reputation;
      r.source.playRange(0, AIRBORNE);
      const flying = r.mission();
      assert.equal(flying?.status, "in_progress");
      const aircraftId = flying?.aircraftId ?? "";
      assert.equal(r.fleet().aircraft.find((a) => a.id === aircraftId)?.status, "in_flight");

      const aborted = r.ok<Mission>("mission.abort");
      assert.equal(aborted.status, "aborted");
      assert.equal(r.jobs().accepted.find((j) => j.id === job.id)?.status, "accepted");
      // The aircraft is really still in the air: it stays in flight until that flight ends.
      assert.equal(r.fleet().aircraft.find((a) => a.id === aircraftId)?.status, "in_flight");

      r.source.playRange(AIRBORNE);
      const after = r.fleet().aircraft.find((a) => a.id === aircraftId);
      assert.equal(after?.status, "available", "the aircraft is released");
      assert.equal(after?.location, "KATL", "it is where it parked");
      const m = r.mission();
      assert.equal(m?.id, aborted.id);
      assert.equal(m?.status, "aborted");
      assert.equal(m?.payout, undefined);
      // Weather bonus: frozen at departure only; an aborted mission never decides a bonus.
      assert.equal(m?.weather?.departure?.station, "KMEM");
      assert.equal(m?.weather?.arrival, undefined);
      assert.equal(m?.weather?.bonus, undefined);
      assert.equal(m?.weather?.outcome, undefined);
      const fuel = m?.costs?.find((c) => c.key === "fuel");
      assert.ok(fuel && fuel.amount > 0, `fuel billed: ${JSON.stringify(m?.costs)}`);
      assert.ok(
        m?.costs?.some((c) => c.key === "landing_fee"),
        "landing fee where it parked",
      );
      assert.ok((m?.wear ?? 0) > 0, "wear booked");
      // No payout row, the jobs stay accepted, reputation unchanged.
      const rows = r.repo.listLedger();
      assert.ok(!rows.some((e) => e.category === "mission_payout"));
      assert.equal(r.jobs().accepted.find((j) => j.id === job.id)?.status, "accepted");
      assert.equal(r.company().reputation, rep0);
      assert.equal(cents(r.company().cash), cents(cash0 - sumCosts(m)));
      assertBalanced(r);
      // Persisted: the mission row carries the costs.
      const row = r.repo.listMissions(10).find((x) => x.id === aborted.id);
      assert.equal(row?.status, "aborted");
      assert.equal(cents(sumCosts(row ?? null)), cents(sumCosts(m)));
      // A new mission can be loaded and flown with the released aircraft.
      assert.ok(!r.session.economy?.missionInProgress);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("transit cargo aborted on its onward leg goes back in transit at its stop, clock unchanged", () => {
    const tmp = tempDir();
    try {
      const leg1 = loadFixture(FIXTURE);
      const end = leg1.at(-1)?.t ?? 0;
      const leg2 = reprojectLeg(
        leg1,
        apt("KMEM"),
        apt("KATL"),
        apt("KATL"),
        apt("KRDU"),
        end + 5_000,
      );
      const frames = [...leg1, ...leg2];
      const r = rig(tmp.dir, frames);
      const job = acceptTo(r, "KRDU");
      r.ok("mission.load", { jobIds: [job.id], destination: "KATL" });
      r.source.playRange(0, leg1.length);
      const stored = r.jobs().inTransit?.find((j) => j.id === job.id);
      assert.equal(stored?.status, "in_transit");
      const rep0 = r.company().reputation;

      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playRange(leg1.length, leg1.length + AIRBORNE);
      const m = r.mission();
      assert.equal(m?.status, "in_progress");
      r.ok("mission.abort");
      assert.deepEqual(
        r.jobs().inTransit?.find((j) => j.id === job.id),
        stored,
        "back in transit at KATL with its clock unchanged",
      );
      r.source.playRange(leg1.length + AIRBORNE);
      const aircraft = r.fleet().aircraft.find((a) => a.id === m?.aircraftId);
      assert.equal(aircraft?.status, "available");
      assert.equal(aircraft?.location, "KRDU");
      assert.ok(sumCosts(r.mission()) > 0, "the onward flight's costs are booked");
      assert.deepEqual(
        r.jobs().inTransit?.find((j) => j.id === job.id),
        stored,
      );
      assert.equal(r.company().reputation, rep0, "no penalty for an abort");
      assert.equal(r.events("job.abandoned").length, 0);
      assertBalanced(r);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("connector restart in the middle of a mission flight", () => {
  it("airborne after the restart: the mission is aborted, cargo returned, aircraft released", () => {
    const tmp = tempDir();
    const frames = loadFixture(FIXTURE);
    try {
      const r = rig(tmp.dir, frames);
      const job = acceptTo(r, "KATL");
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playRange(0, AIRBORNE);
      const m1 = r.mission();
      assert.equal(m1?.status, "in_progress");
      const aircraftId = m1?.aircraftId ?? "";
      r.close();

      // Restart on the same database: the tracker's flight is gone.
      const r2 = rig(tmp.dir, frames, "N");
      const a0 = r2.fleet().aircraft.find((a) => a.id === aircraftId);
      assert.notEqual(a0?.status, "in_flight", "no aircraft is left flying after a restart");
      assert.notEqual(r2.mission()?.status, "in_progress", "the lost flight is not resumed");
      // The sim says the aircraft is airborne, away from the origin: the mission is aborted.
      r2.source.playRange(AIRBORNE);
      const m2 = r2.mission();
      assert.equal(m2?.id, m1?.id);
      assert.equal(m2?.status, "aborted");
      assert.equal(m2?.payout, undefined);
      assert.equal(r2.jobs().accepted.find((j) => j.id === job.id)?.status, "accepted");
      const a1 = r2.fleet().aircraft.find((a) => a.id === aircraftId);
      assert.equal(a1?.status, "available");
      assert.ok(!r2.session.economy?.missionInProgress);
      assert.equal(r2.events("mission.recovered").length, 1);
      assertBalanced(r2);
      // Persisted: a third start finds nothing open.
      r2.close();
      const r3 = rig(tmp.dir, frames, "P");
      assert.equal(r3.mission(), null);
      assert.equal(r3.fleet().aircraft.find((a) => a.id === aircraftId)?.status, "available");
      r3.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("parked at the origin after the restart: the mission is loaded again and flies normally", () => {
    const tmp = tempDir();
    const frames = loadFixture(FIXTURE);
    try {
      const r = rig(tmp.dir, frames);
      const job = acceptTo(r, "KATL");
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playRange(0, AIRBORNE);
      assert.equal(r.mission()?.status, "in_progress");
      r.close();

      const r2 = rig(tmp.dir, frames, "N");
      // The simulator is back at the origin, parked (replay from the start).
      r2.source.playRange(0, 10);
      const back = r2.mission();
      assert.equal(back?.status, "loaded");
      assert.equal(back?.flightId, undefined);
      assert.equal(back?.startedAt, undefined);
      // The lost flight's departure weather is cleared with its start: a loaded mission
      // carries no frozen check, and the new departure freezes a fresh one.
      assert.equal(back?.weather, undefined);
      assert.equal(r2.events("mission.recovered").length, 1);
      r2.source.playRange(10);
      const done = r2.mission();
      assert.equal(done?.status, "delivered", JSON.stringify(done?.failure ?? done?.startBlocked));
      assert.equal(done?.flightId, "N-flight-1");
      assert.equal(done?.weather?.departure?.station, "KMEM");
      assert.equal(done?.weather?.arrival?.station, "KATL");
      assert.equal(done?.weather?.outcome, "not_live"); // no weather lookup in this rig
      assert.equal(done?.weather?.bonus, 0);
      assert.ok((done?.payout?.total ?? 0) > 0);
      assert.equal(r2.fleet().aircraft.find((a) => a.id === done?.aircraftId)?.status, "available");
      assertBalanced(r2);
      r2.close();
    } finally {
      tmp.cleanup();
    }
  });
});
