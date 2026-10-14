// Transit cargo (docs/ECONOMY.md "Transit cargo") through the real ConnectorSession and
// storage. Leg 1 replays the synthetic KMEM → KATL fixture; leg 2 KATL → KRDU is the same
// SYNTHETIC fixture re-projected onto that route (connector/test/transit-leg.ts). Neither
// is simulator telemetry. A KMEM → KRDU job is flown via KATL: unloaded there in transit
// (no pay), kept across a restart, picked up two in-game hours later and paid in full on
// the final delivery with the chain time against its limit.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PROTOCOL_VERSION,
  type Command,
  type CompanyState,
  type FixtureFrame,
  type Frame,
  type Job,
  type JobsState,
  type Mission,
  type Result,
  aircraftTypeByKey,
} from "../src/protocol";
import {
  CARGO_TERMINAL,
  airportLookup,
  computePayout,
  greatCircleNm,
  payloadLimitKg,
  transitRemainingMin,
  type EconomyAirport,
} from "../src/economy";
import { loadAirportsData } from "../src/core/economy/airports-data";
import { ConnectorSession } from "../src/core/session";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import { openStorage, type Storage } from "../src/storage/db";
import { EconomyRepo } from "../src/storage/economy";
import { exportCareer, importCareer } from "../src/storage/career";
import { FlightRepo } from "../src/storage/flights";
import { tempDir } from "./helpers";
import { reprojectLeg } from "./transit-leg";

const FIXTURE = join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl");
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

let airportsCache: EconomyAirport[] | null = null;
const airports = () => (airportsCache ??= loadAirportsData().airports);
const lookup = () => airportLookup(airports());
const apt = (icao: string): EconomyAirport => {
  const a = lookup().get(icao);
  if (!a) throw new Error(icao);
  return a;
};

/** Leg 1 (synthetic KMEM → KATL) followed by leg 2 (SYNTHETIC KATL → KRDU re-projection). */
function twoLegs(): { frames: FixtureFrame[]; leg2Start: number } {
  const leg1 = loadFixture(FIXTURE);
  const end = leg1.at(-1)?.t ?? 0;
  const leg2 = reprojectLeg(leg1, apt("KMEM"), apt("KATL"), apt("KATL"), apt("KRDU"), end + 5_000);
  return { frames: [...leg1, ...leg2], leg2Start: leg1.length };
}

interface Rig {
  session: ConnectorSession;
  source: FakeSource;
  storage: Storage;
  repo: EconomyRepo;
  clock: { now: number };
  cmd(name: string, args?: unknown): Result;
  ok<T>(name: string, args?: unknown): T;
  err(name: string, args?: unknown): string;
  jobs(): JobsState;
  company(): CompanyState;
  mission(): Mission | null;
  events(name: string): Frame[];
  close(): void;
}

function rig(dir: string, frames: FixtureFrame[], missionPrefix = "M"): Rig {
  const storage = openStorage(dir, "demo");
  const repo = new EconomyRepo(storage);
  const flights = new FlightRepo(storage, "replay");
  const source = new FakeSource({ frames, manual: true });
  const clock = { now: T0 };
  let n = 0;
  let missionN = 0;
  let flightN = 0;
  const session = new ConnectorSession(source, () => {}, {
    repo: flights,
    now: () => clock.now,
    newId: () => `${missionPrefix}-flight-${++flightN}`,
    economy: {
      repo,
      airports: airports(),
      seed: 4242,
      replay: true,
      now: () => clock.now,
      newId: () => `${missionPrefix}-${++missionN}`,
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
    jobs: () => session.store.getDomain("jobs") as JobsState,
    company: () => session.store.getDomain("company") as CompanyState,
    mission: () => (session.store.getDomain("mission") ?? null) as Mission | null,
    events: (name) => out.filter((f) => f.type === "event" && f.name === name),
    close: () => storage.close(),
  };
}

/** Accept the first KMEM → `dest` job of a board focused on `dest`. */
function acceptTo(r: Rig, dest: string): Job {
  r.ok("jobs.refresh", { airport: "KMEM", destination: dest });
  const job = r.jobs().available.find((j) => j.destination === dest);
  assert.ok(job, `the focused board has a ${dest} job`);
  r.ok("job.accept", { jobId: job.id });
  return job;
}

function gameMs(r: Rig): number {
  return r.company().clock?.gameMs ?? 0;
}

describe("transit cargo: KMEM → KRDU via KATL on two replayed legs", () => {
  it("leg 1 stores the cargo at KATL unpaid; leg 2 pays the whole chain once", () => {
    const tmp = tempDir();
    const { frames, leg2Start } = twoLegs();
    try {
      const r = rig(tmp.dir, frames);
      const job = acceptTo(r, "KRDU");
      assert.equal(job.distanceNm, Math.round(greatCircleNm(apt("KMEM"), apt("KRDU")) * 10) / 10);
      // Direct the leg to KATL: a transit leg for the KRDU job.
      const m1 = r.ok<Mission>("mission.load", { jobIds: [job.id], destination: "KATL" });
      assert.equal(m1.origin, "KMEM");
      assert.equal(m1.destination, "KATL");
      assert.deepEqual(m1.transitJobIds, [job.id]);
      assert.equal(m1.expectedPayout, 0); // nothing is delivered on this leg
      const cash0 = r.company().cash;
      const rep0 = r.company().reputation;

      r.source.playRange(0, leg2Start);
      const leg1 = r.mission();
      assert.ok(leg1);
      assert.equal(leg1.status, "delivered", JSON.stringify(leg1.failure ?? leg1.startBlocked));
      assert.equal(leg1.landingGrade, "B");
      assert.equal(leg1.payout?.total, 0);
      assert.deepEqual(leg1.payout?.jobs, []);
      // No delivery: reputation unchanged by a clean landing, no mission_payout row.
      assert.equal(r.company().reputation, rep0);
      const rows1 = r.repo.listLedger().map((e) => e.category);
      assert.ok(!rows1.includes("mission_payout"));
      const costs1 = leg1.payout?.costs?.reduce((s, c) => s + c.amount, 0) ?? 0;
      assert.ok(costs1 > 0);
      assert.equal(r.company().cash, Math.round((cash0 - costs1) * 100) / 100);
      assert.equal(r.events("job.completed").length, 0);
      assert.equal(r.events("job.in_transit").length, 1);

      const stored = r.jobs().inTransit?.find((j) => j.id === job.id);
      assert.ok(stored, "the job is listed in transit");
      assert.equal(stored.status, "in_transit");
      assert.equal(stored.missionId, undefined);
      assert.equal(stored.transit?.location, "KATL");
      assert.equal(stored.transit?.storage, "airport");
      assert.equal(stored.transit?.freeStorageMin, 0);
      const block1 = leg1.elapsedMin ?? 0;
      assert.ok(block1 > 100 && block1 < 140, `block ${block1}`);
      assert.equal(stored.transit?.elapsedMin, Math.round(block1 * 10) / 10);
      assert.equal(stored.transit?.legs.length, 1);
      assert.equal(stored.transit?.legs[0]?.landingGrade, "B");
      const arrived = stored.transit?.arrivedGameMs ?? 0;
      assert.equal(
        stored.transit?.deadlineGameMs,
        Math.round(arrived + (job.timeLimitMin - (stored.transit?.elapsedMin ?? 0)) * 60_000),
      );
      assert.ok(!r.jobs().accepted.some((j) => j.id === job.id));
      // Persisted with its location (migration 7).
      const row = r.storage.db
        .prepare("SELECT status, location, origin FROM jobs WHERE id = ?")
        .get(job.id) as { status: string; location: string; origin: string };
      assert.deepEqual({ ...row }, { status: "in_transit", location: "KATL", origin: "KMEM" });
      // The fleet aircraft is at KATL now.
      r.close();

      // Restart on the same database: the cargo is still waiting at KATL.
      const r2 = rig(tmp.dir, frames, "N");
      const again = r2.jobs().inTransit?.find((j) => j.id === job.id);
      assert.deepEqual(again, stored);
      // Two in-game hours on the ground at KATL count against the deadline.
      r2.session.economy?.advanceGameTime(2 * HOUR);
      const now2 = gameMs(r2);
      assert.equal(now2 - arrived, 2 * HOUR);
      assert.equal(
        transitRemainingMin(again, now2),
        Math.round((job.timeLimitMin - (stored.transit?.elapsedMin ?? 0) - 120) * 10) / 10,
      );
      // Rules for the onward leg: it starts where the cargo is; unload keeps it in transit.
      const m2 = r2.ok<Mission>("mission.load", { jobIds: [job.id] });
      assert.equal(m2.origin, "KATL");
      assert.equal(m2.destination, "KRDU");
      assert.equal(m2.transitJobIds, undefined);
      assert.equal(m2.expectedPayout, job.payoutEstimate);
      r2.ok("mission.unload");
      assert.equal(r2.jobs().inTransit?.find((j) => j.id === job.id)?.status, "in_transit");
      r2.ok("mission.load", { jobIds: [job.id] });
      const rep1 = r2.company().reputation;

      r2.source.playRange(leg2Start);
      const leg2 = r2.mission();
      assert.ok(leg2);
      assert.equal(leg2.status, "delivered", JSON.stringify(leg2.failure ?? leg2.startBlocked));
      assert.equal(leg2.origin, "KATL");
      assert.equal(leg2.landingGrade, "B");
      const block2 = leg2.elapsedMin ?? 0;
      const chainMin = Math.round(((stored.transit?.elapsedMin ?? 0) + 120 + block2) * 10) / 10;
      const lateMin = Math.round((chainMin - job.timeLimitMin) * 10) / 10;
      assert.ok(lateMin < 0, `on time (${lateMin})`);
      // Full payout over the origin → destination distance, landing of the final leg.
      const expected = computePayout({
        kind: job.kind,
        weightKg: job.weightKg,
        distanceNm: job.distanceNm,
        units: job.units,
        reputation: rep1,
        estimate: false,
        landingGrade: "B",
        lateMin,
        ...(job.demandFactor !== undefined ? { demand: job.demandFactor } : {}),
      }).total;
      assert.equal(leg2.payout?.total, expected);
      assert.equal(leg2.payout?.jobs.length, 1);
      const late = leg2.payout?.jobs[0]?.factors.find((f) => f.key === "late");
      assert.match(late?.note ?? "", /transit chain of 2 legs/);
      assert.equal(r2.company().reputation, rep1 + 2); // on-time B delivery
      const payouts = r2.repo.listLedger().filter((e) => e.category === "mission_payout");
      assert.equal(payouts.length, 1);
      assert.equal(payouts[0]?.amount, expected);
      assert.equal(payouts[0]?.refId, job.id);
      assert.match(payouts[0]?.memo ?? "", /2 legs via transit/);
      assert.equal(r2.events("job.completed").length, 1);
      assert.equal(r2.jobs().inTransit?.length ?? 0, 0);
      const done = r2.storage.db.prepare("SELECT status FROM jobs WHERE id = ?").get(job.id) as {
        status: string;
      };
      assert.equal(done.status, "delivered");
      // The ledger still balances.
      assert.equal(
        Math.round(r2.repo.ledgerTotals().sum * 100),
        Math.round((r2.company().cash - 250_000) * 100),
      );
      r2.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("an own cargo terminal at the stop keeps its free hours off the deadline", () => {
    const tmp = tempDir();
    const { frames, leg2Start } = twoLegs();
    try {
      const r = rig(tmp.dir, frames);
      // Tools-only funding so the FBO and its terminal are affordable (ledger `adjustment`).
      const book = r.session.economy?.companyBook;
      assert.ok(book);
      book.post("adjustment", 1_500_000, null, null, "test funding");
      const fbo = r.ok<{ fbo: { id: string } }>("fbo.buy", { icao: "KATL" }).fbo;
      r.ok("fbo.module.buy", { fboId: fbo.id, module: "cargo" });
      r.session.economy?.advanceGameTime(3 * DAY);
      const katl = r.session.economy
        ?.fbosDomain()
        .fbos.find((f) => f.icao === "KATL")
        ?.modules.find((m) => m.kind === "cargo");
      assert.equal(katl?.level, 1);
      const job = acceptTo(r, "KRDU");
      r.ok("mission.load", { jobIds: [job.id], destination: "KATL" });
      r.source.playRange(0, leg2Start);
      const stored = r.jobs().inTransit?.find((j) => j.id === job.id);
      assert.ok(stored?.transit);
      assert.equal(stored.transit.storage, "own_terminal");
      assert.equal(
        stored.transit.freeStorageMin,
        (CARGO_TERMINAL.transitFreeStorageHours[0] ?? 0) * 60,
      );
      const left = transitRemainingMin(stored, stored.transit.arrivedGameMs);
      // Three hours in the terminal cost nothing; five cost one hour.
      assert.equal(transitRemainingMin(stored, stored.transit.arrivedGameMs + 3 * HOUR), left);
      assert.equal(transitRemainingMin(stored, stored.transit.arrivedGameMs + 5 * HOUR), left - 60);
      assert.equal(
        stored.transit.deadlineGameMs,
        Math.round(stored.transit.arrivedGameMs + (left + 240) * 60_000),
      );
      r.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("transit cargo: load rules, long-haul jobs, abandon and export", () => {
  it("refuses no-progress, same-airport, mixed and overweight legs; stacks a delivery with transit cargo", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir, loadFixture(FIXTURE));
      const krdu = acceptTo(r, "KRDU");
      const katl = acceptTo(r, "KATL");
      // KLIT lies west of KMEM: further from KRDU.
      assert.equal(
        r.err("mission.load", { jobIds: [krdu.id], destination: "KLIT" }),
        "no_progress",
      );
      assert.equal(r.err("mission.load", { jobIds: [krdu.id, katl.id] }), "mixed_route");
      assert.equal(
        r.err("mission.load", { jobIds: [krdu.id], destination: "KMEM" }),
        "same_airport",
      );
      // The payload rule applies per leg to everything on board (seeded: 955 kg > 944 kg).
      const limit = payloadLimitKg(aircraftTypeByKey("c208b")!, 287.7);
      assert.ok(krdu.weightKg + katl.weightKg > limit);
      assert.equal(
        r.err("mission.load", { jobIds: [krdu.id, katl.id], destination: "KATL" }),
        "payload_exceeded",
      );
      // Lighter cargo fits: the lightest KRDU and KATL jobs of the focused boards.
      r.ok("job.release", { jobId: katl.id });
      r.ok("job.release", { jobId: krdu.id });
      const lightest = (dest: string) => {
        r.ok("jobs.refresh", { airport: "KMEM", destination: dest });
        const j = r
          .jobs()
          .available.filter((x) => x.destination === dest)
          .sort((x, y) => x.weightKg - y.weightKg)[0];
        assert.ok(j);
        r.ok("job.accept", { jobId: j.id });
        return j;
      };
      const far = lightest("KRDU");
      const light = lightest("KATL");
      assert.ok(far.weightKg + light.weightKg <= limit, `${far.weightKg} + ${light.weightKg} kg`);
      // Both on one leg to KATL: the KATL job is delivered there, the KRDU job goes on.
      const m = r.ok<Mission>("mission.load", {
        jobIds: [far.id, light.id],
        destination: "KATL",
      });
      assert.deepEqual(m.transitJobIds, [far.id]);
      assert.equal(m.expectedPayout, light.payoutEstimate);
      r.ok("mission.abort");
      assert.deepEqual(
        r
          .jobs()
          .accepted.filter((j) => j.id === far.id || j.id === light.id)
          .map((j) => j.status),
        ["accepted", "accepted"],
      );
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("boards carry long-haul jobs that need a stop; a focus beyond range gets one", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir, loadFixture(FIXTURE));
      r.ok("jobs.refresh", { airport: "KMEM", destination: "KMIA" });
      const board = r.jobs().available.filter((j) => j.origin === "KMEM");
      const longHaul = board.filter((j) => j.longHaul);
      assert.equal(longHaul.length, 2);
      assert.equal(board.length, 26);
      const miami = longHaul[0];
      assert.ok(miami);
      assert.equal(miami.destination, "KMIA");
      assert.ok(miami.distanceNm > 720, `${miami.distanceNm} nm is beyond 80 % of the range`);
      r.ok("job.accept", { jobId: miami.id });
      assert.equal(r.err("mission.load", { jobIds: [miami.id] }), "out_of_range");
      const m = r.ok<Mission>("mission.load", { jobIds: [miami.id], destination: "KATL" });
      assert.deepEqual(m.transitJobIds, [miami.id]);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("a crash on a transit leg fails the cargo; abandoning stored cargo costs 3 reputation", () => {
    const tmp = tempDir();
    const leg1 = loadFixture(FIXTURE);
    try {
      // Crash: no partial credit, the job ends failed.
      const crashed = rig(tmp.dir, withCrash(leg1));
      const a = acceptTo(crashed, "KRDU");
      crashed.ok("mission.load", { jobIds: [a.id], destination: "KATL" });
      crashed.source.playAll();
      assert.equal(crashed.mission()?.status, "failed");
      assert.equal(crashed.jobs().inTransit?.length ?? 0, 0);
      const row = crashed.storage.db.prepare("SELECT status FROM jobs WHERE id = ?").get(a.id) as {
        status: string;
      };
      assert.equal(row.status, "failed");
      crashed.close();
    } finally {
      tmp.cleanup();
    }
    const tmp2 = tempDir();
    try {
      const r = rig(tmp2.dir, leg1);
      const b = acceptTo(r, "KRDU");
      r.ok("mission.load", { jobIds: [b.id], destination: "KATL" });
      r.source.playAll();
      assert.equal(r.jobs().inTransit?.[0]?.id, b.id);
      // Export (version 5) carries the stored cargo; an import restores it.
      const exported = exportCareer(r.repo, "demo", T0);
      assert.equal(exported.version, 5);
      const inExport = exported.jobs.find((j) => j.id === b.id);
      assert.equal(inExport?.status, "in_transit");
      assert.equal(inExport?.transit?.location, "KATL");
      const rep = r.company().reputation;
      const res = r.ok<{ status: string; reputationDelta: number }>("job.release", {
        jobId: b.id,
      });
      assert.deepEqual(res, { jobId: b.id, status: "failed", reputationDelta: -3 });
      assert.equal(r.company().reputation, rep - 3);
      assert.equal(r.events("job.abandoned").length, 1);
      assert.equal(r.jobs().inTransit?.length ?? 0, 0);
      // A version 4 export (no transit cargo then) still imports.
      const v4 = importCareer(r.repo, "demo", {
        ...exported,
        version: 4,
        jobs: exported.jobs.filter((j) => j.status !== "in_transit" && !j.longHaul),
      });
      assert.ok(v4.ok);
      assert.equal(v4.ok && v4.version, 4);
      r.session.economy?.reload();
      assert.equal(r.jobs().inTransit?.length ?? 0, 0);
      const imported = importCareer(r.repo, "demo", exported);
      assert.ok(imported.ok);
      r.session.economy?.reload();
      assert.equal(r.jobs().inTransit?.[0]?.id, b.id);
      assert.equal(r.jobs().inTransit?.[0]?.transit?.location, "KATL");
      const loc = r.storage.db.prepare("SELECT location FROM jobs WHERE id = ?").get(b.id) as {
        location: string;
      };
      assert.equal(loc.location, "KATL");
      r.close();
    } finally {
      tmp2.cleanup();
    }
  });
});

function withCrash(frames: FixtureFrame[]): FixtureFrame[] {
  const out = [...frames];
  const at = out.findIndex((_, i) => i > 140);
  const t = out[at]?.t ?? 0;
  out.splice(at, 0, {
    t,
    msg: {
      type: "event",
      v: PROTOCOL_VERSION,
      seq: 0,
      source: "replay",
      name: "crash",
      data: null,
    },
  } as FixtureFrame);
  return out;
}
