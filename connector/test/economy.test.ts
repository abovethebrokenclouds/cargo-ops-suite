// P3 acceptance (plan §5): a KMEM → KATL job accepted on a seeded board, loaded,
// started, flown by replaying demo-kmem-katl.jsonl, delivered and paid exactly what
// the formula gives. Plus the mission rules (start at origin, verification failures,
// crash, noBonus, stacking) through the real ConnectorSession and storage.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PROTOCOL_VERSION,
  type Command,
  type FixtureFrame,
  type Frame,
  type Job,
  type JobsState,
  type Mission,
  type Result,
} from "../src/protocol";
import { computePayout, payloadLimitKg, type EconomyAirport } from "../src/economy";
import { aircraftTypeByKey } from "../src/protocol";
import { loadAirportsData } from "../src/core/economy/airports-data";
import { ConnectorSession } from "../src/core/session";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import { openStorage, type Storage } from "../src/storage/db";
import { EconomyRepo } from "../src/storage/economy";
import { FlightRepo } from "../src/storage/flights";
import { tempDir } from "./helpers";

const FIXTURE = join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl");
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const SEED = 4242;
/** Frames 0–20 are the parked boarding segment (on ground, brake set, at KMEM). */
const BOARDING_END = 20;

let airportsCache: EconomyAirport[] | null = null;
const airports = () => (airportsCache ??= loadAirportsData().airports);

interface Rig {
  session: ConnectorSession;
  source: FakeSource;
  out: Frame[];
  storage: Storage;
  economy: EconomyRepo;
  flights: FlightRepo;
  cmd(name: string, args?: unknown): Result;
  ok<T>(name: string, args?: unknown): T;
  jobs(): JobsState;
  mission(): Mission | null;
  events(name: string): Frame[];
  close(): void;
}

function rig(frames: FixtureFrame[], dir: string, seed = SEED): Rig {
  const storage = openStorage(dir, "demo");
  const flights = new FlightRepo(storage, "replay");
  const economy = new EconomyRepo(storage);
  const source = new FakeSource({ frames, manual: true });
  let flightN = 0;
  let missionN = 0;
  const session = new ConnectorSession(source, () => {}, {
    repo: flights,
    now: () => NOW,
    newId: () => `flight-${++flightN}`,
    economy: {
      repo: economy,
      airports: airports(),
      seed,
      replay: true,
      now: () => NOW,
      newId: () => `M-${++missionN}`,
    },
  });
  const out: Frame[] = [];
  session.store.subscribe((f) => out.push(f));
  session.start();
  let n = 0;
  const cmd = (name: string, args: unknown = {}): Result =>
    session.command({ type: "command", v: PROTOCOL_VERSION, id: `c${++n}`, name, args } as Command);
  return {
    session,
    source,
    out,
    storage,
    economy,
    flights,
    cmd,
    ok<T>(name: string, args: unknown = {}): T {
      const r = cmd(name, args);
      if (!r.ok) assert.fail(`${name} failed: ${r.error.code} ${r.error.message}`);
      return r.data as T;
    },
    jobs: () => session.store.getDomain("jobs") as JobsState,
    mission: () => (session.store.getDomain("mission") ?? null) as Mission | null,
    events: (name) => out.filter((f) => f.type === "event" && f.name === name),
    close: () => storage.close(),
  };
}

function acceptKatlJob(r: Rig, index = 0): Job {
  r.ok("jobs.refresh", { airport: "KMEM", destination: "KATL" });
  const job = r.jobs().available.filter((j) => j.destination === "KATL")[index];
  assert.ok(job, "the focused board has KATL jobs");
  r.ok("job.accept", { jobId: job.id });
  return job;
}

describe("P3 acceptance: KMEM → KATL mission on the replayed fixture", () => {
  const frames = loadFixture(FIXTURE);

  it("accept → load → start → fly → deliver → payout equals the formula", () => {
    const tmp = tempDir();
    try {
      const r = rig(frames, tmp.dir);
      // Board at the company base on start, for the default/fixture type.
      assert.equal(r.jobs().boards[0]?.origin, "KMEM");
      const job = acceptKatlJob(r);
      // The seeded job (company seed 4242, board #2 at KMEM for the C208B, first KATL slot).
      assert.deepEqual(
        { kind: job.kind, weightKg: job.weightKg, units: job.units, distanceNm: job.distanceNm },
        EXPECTED_JOB,
      );
      const mission = r.ok<Mission>("mission.load", { jobIds: [job.id] });
      assert.equal(mission.status, "loaded");
      assert.equal(r.jobs().accepted[0]?.status, "loaded");

      r.source.playAll();

      const m = r.mission();
      assert.ok(m);
      assert.equal(m.status, "delivered", JSON.stringify(m.failure ?? m.startBlocked));
      assert.equal(m.landingGrade, "B");
      assert.equal(r.events("mission.started").length, 1);
      assert.equal(r.events("mission.delivered").length, 1);
      assert.equal(r.events("job.completed").length, 1);

      // Recompute independently: landing B → 1.00, on time (block ≈ 126 min), reputation 50.
      const expected = computePayout({
        kind: job.kind,
        weightKg: job.weightKg,
        distanceNm: job.distanceNm,
        units: job.units,
        reputation: 50,
        estimate: false,
        landingGrade: "B",
        lateMin: 0,
      }).total;
      assert.equal(m.payout?.total, expected);
      assert.equal(m.payout?.total, EXPECTED_PAYOUT);
      // B landing, on time: the board estimate is exactly what was paid.
      assert.equal(m.payout?.total, job.payoutEstimate);
      const late = m.payout?.jobs[0]?.factors.find((f) => f.key === "late");
      assert.equal(late?.value, 0);

      const company = r.session.store.getDomain("company") as { cash: number; reputation: number };
      assert.equal(company.cash, 250_000 + EXPECTED_PAYOUT);
      assert.equal(company.reputation, 52); // +2 for an on-time B landing

      // Persisted: ledger, missions, logbook join.
      const ledger = r.economy.listLedger();
      assert.equal(ledger.length, 1);
      assert.equal(ledger[0]?.category, "job_payout");
      assert.equal(ledger[0]?.amount, EXPECTED_PAYOUT);
      const log = r.economy.logbook();
      assert.equal(log.length, 1);
      assert.equal(log[0]?.mission?.payout, EXPECTED_PAYOUT);
      assert.equal(log[0]?.landing?.grade, "B");
      assert.equal(log[0]?.payloadKg, job.weightKg);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("explicit flight.start checks the mission origin (3 nm)", () => {
    const tmp = tempDir();
    try {
      const r = rig(frames, tmp.dir);
      r.ok("jobs.refresh", { airport: "KBNA" });
      const job = r.jobs().available.find((j) => j.origin === "KBNA");
      assert.ok(job);
      r.ok("job.accept", { jobId: job.id });
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playRange(0, BOARDING_END);
      const res = r.cmd("flight.start");
      assert.equal(res.ok, false);
      if (!res.ok) assert.equal(res.error.code, "not_at_origin");
      // Without a mission the same start is accepted (P2 behaviour unchanged).
      r.ok("mission.unload");
      r.ok("flight.start");
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("explicit flight.start at the origin starts the mission", () => {
    const tmp = tempDir();
    try {
      const r = rig(frames, tmp.dir);
      const job = acceptKatlJob(r);
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playRange(0, BOARDING_END);
      r.ok("flight.start");
      assert.equal(r.mission()?.status, "in_progress");
      r.source.playRange(BOARDING_END);
      assert.equal(r.mission()?.status, "delivered");
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("a departure away from the origin leaves the mission loaded with startBlocked", () => {
    const tmp = tempDir();
    try {
      const r = rig(frames, tmp.dir);
      r.ok("jobs.refresh", { airport: "KBNA" });
      const job = r.jobs().available.find((j) => j.origin === "KBNA");
      assert.ok(job);
      r.ok("job.accept", { jobId: job.id });
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playAll();
      const m = r.mission();
      assert.equal(m?.status, "loaded");
      assert.equal(m?.startBlocked?.code, "not_at_origin");
      assert.equal(r.events("mission.delivered").length, 0);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("sim rate > 8× invalidates: mission failed, no payout", () => {
    const tmp = tempDir();
    try {
      const r = rig(withSimRate(frames, 16), tmp.dir);
      const job = acceptKatlJob(r);
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playAll();
      const m = r.mission();
      assert.equal(m?.status, "failed");
      assert.equal(m?.failure?.code, "invalidated");
      assert.equal(m?.payout, undefined);
      assert.equal(r.economy.listLedger().length, 0);
      assert.equal((r.session.store.getDomain("company") as { cash: number }).cash, 250_000);
      assert.equal(r.events("mission.failed").length, 1);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("a teleport fails the mission", () => {
    const tmp = tempDir();
    try {
      const r = rig(withTeleport(frames), tmp.dir);
      const job = acceptKatlJob(r);
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playAll();
      assert.equal(r.mission()?.failure?.code, "teleport");
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("sim rate 2× pays without bonuses (reputation factor 1.00)", () => {
    const tmp = tempDir();
    try {
      const r = rig(withSimRate(frames, 2), tmp.dir);
      const job = acceptKatlJob(r);
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playAll();
      const m = r.mission();
      assert.equal(m?.status, "delivered");
      const b = m?.payout?.jobs[0];
      assert.equal(b?.noBonus, true);
      assert.equal(b?.factors.find((f) => f.key === "reputation")?.value, 1);
      assert.ok((m?.payout?.total ?? 0) < job.payoutEstimate);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("a crash fails the mission and costs 20 reputation", () => {
    const tmp = tempDir();
    try {
      const r = rig(withCrash(frames), tmp.dir);
      const job = acceptKatlJob(r);
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playAll();
      const m = r.mission();
      assert.equal(m?.status, "failed");
      assert.equal(m?.failure?.code, "crashed");
      assert.equal((r.session.store.getDomain("company") as { reputation: number }).reputation, 30);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("a session reset mid-flight aborts the mission and returns its jobs", () => {
    const tmp = tempDir();
    try {
      const r = rig(frames, tmp.dir);
      const job = acceptKatlJob(r);
      r.ok("mission.load", { jobIds: [job.id] });
      r.source.playRange(0, 150);
      assert.equal(r.mission()?.status, "in_progress");
      r.source.playRange(0, 1); // replay restart: new snapshot
      assert.equal(r.mission()?.status, "aborted");
      assert.equal(r.jobs().accepted.find((j) => j.id === job.id)?.status, "accepted");
      r.close();
    } finally {
      tmp.cleanup();
    }
  });
});

describe("job and mission commands", () => {
  const frames = loadFixture(FIXTURE);

  it("stacks same-route jobs within the payload limit and refuses mixed routes", () => {
    const tmp = tempDir();
    try {
      const r = rig(frames, tmp.dir);
      r.ok("jobs.refresh", { airport: "KMEM", destination: "KATL" });
      const katl = r
        .jobs()
        .available.filter((j) => j.destination === "KATL")
        .slice(0, 3);
      const other = r.jobs().available.find((j) => j.destination !== "KATL");
      assert.ok(other);
      for (const j of [...katl, other]) r.ok("job.accept", { jobId: j.id });
      const mixed = r.cmd("mission.load", { jobIds: [katl[0]?.id, other.id] });
      assert.equal(!mixed.ok && mixed.error.code, "mixed_route");
      const c208 = aircraftTypeByKey("c208b");
      assert.ok(c208);
      const limit = payloadLimitKg(c208, 287.7);
      // Greedy pick of KATL jobs that fit, then everything (which may not).
      const fit: Job[] = [];
      let kg = 0;
      for (const j of katl) {
        if (kg + j.weightKg > limit) continue;
        fit.push(j);
        kg += j.weightKg;
      }
      const all = r.cmd("mission.load", { jobIds: katl.map((j) => j.id) });
      const total = katl.reduce((s, j) => s + j.weightKg, 0);
      if (total > limit) assert.equal(!all.ok && all.error.code, "payload_exceeded");
      else {
        assert.equal(all.ok, true);
        r.ok("mission.unload");
      }
      const m = r.ok<Mission>("mission.load", { jobIds: fit.map((j) => j.id) });
      assert.equal(m.payloadKg, kg);
      assert.equal(m.jobs.length, fit.length);
      assert.equal(
        m.expectedPayout,
        fit.reduce((s, j) => s + j.payoutEstimate, 0),
      );
      const again = r.cmd("mission.load", { jobIds: [other.id] });
      assert.equal(!again.ok && again.error.code, "mission_active");
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("accept/release/unload/abort and persistence across a restart", () => {
    const tmp = tempDir();
    try {
      const r = rig(frames, tmp.dir);
      const job = acceptKatlJob(r);
      const twice = r.cmd("job.accept", { jobId: job.id });
      assert.equal(!twice.ok && twice.error.code, "job_unavailable");
      r.ok("job.release", { jobId: job.id });
      assert.ok(r.jobs().available.some((j) => j.id === job.id));
      r.ok("job.accept", { jobId: job.id });
      r.ok("mission.load", { jobIds: [job.id] });
      const rel = r.cmd("job.release", { jobId: job.id });
      assert.equal(!rel.ok && rel.error.code, "job_loaded");
      r.ok("mission.abort");
      assert.equal(r.mission()?.status, "aborted");
      assert.equal(r.jobs().accepted[0]?.status, "accepted");
      const bad = r.cmd("jobs.refresh", { airport: "ZZZZ" });
      assert.equal(!bad.ok && bad.error.code, "unknown_airport");
      const board = r.jobs().boards[0];
      r.close();

      // Same database: company, board and accepted job come back.
      const again = rig(frames, tmp.dir, 1);
      assert.deepEqual(again.jobs().boards[0], board);
      assert.equal(again.jobs().accepted[0]?.id, job.id);
      again.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("aircraft type override changes the board and reference speed", () => {
    const tmp = tempDir();
    try {
      const r = rig(frames, tmp.dir);
      r.source.playRange(0, 2);
      assert.equal(r.jobs().aircraft.typeKey, "c208b");
      assert.equal(r.jobs().aircraft.source, "title");
      r.ok("settings.update", { aircraftType: "atr72f" });
      assert.equal(r.jobs().aircraft.source, "override");
      assert.equal(r.jobs().boards[0]?.aircraftKey, "atr72f");
      assert.ok(r.jobs().available.every((j) => j.aircraftKey === "atr72f"));
      const bad = r.cmd("settings.update", { aircraftType: "concorde" });
      assert.equal(!bad.ok && bad.error.code, "unknown_type");
      r.ok("settings.update", { aircraftType: null });
      assert.equal(r.jobs().aircraft.typeKey, "c208b");
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("is deterministic for a seed", () => {
    const a = tempDir();
    const b = tempDir();
    try {
      const r1 = rig(frames, a.dir);
      const r2 = rig(frames, b.dir);
      assert.deepEqual(r1.jobs().available, r2.jobs().available);
      r1.close();
      r2.close();
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });
});

// ---- fixture variants ----

function mapDeltas(
  frames: FixtureFrame[],
  fn: (patch: Record<string, unknown>, i: number) => void,
) {
  return frames.map((f, i) => {
    if (f.msg.type !== "delta") return f;
    const patch = structuredClone(f.msg.patch) as Record<string, unknown>;
    fn(patch, i);
    return { ...f, msg: { ...f.msg, patch } } as FixtureFrame;
  });
}

/** Set the sim rate for the airborne part of the flight. */
function withSimRate(frames: FixtureFrame[], rate: number): FixtureFrame[] {
  return mapDeltas(frames, (patch, i) => {
    if (i === 120) patch["sim"] = { ...(patch["sim"] as object), simRate: rate };
    if (i === 160) patch["sim"] = { ...(patch["sim"] as object), simRate: 1 };
  });
}

/** Move the aircraft 2° east for one cruise frame. */
function withTeleport(frames: FixtureFrame[]): FixtureFrame[] {
  return mapDeltas(frames, (patch, i) => {
    const pos = patch["position"] as { lon: number } | undefined;
    if (i >= 150 && pos) pos.lon += 2;
  });
}

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
  });
  return out;
}

// Pinned values for the seeded acceptance job (see docs/ECONOMY.md "Acceptance").
const EXPECTED_JOB = { kind: "cargo", weightKg: 840, units: 1, distanceNm: 287.7 };
// 0.015 × 840 × 287.7 × atan(287.7/25)/atan(1) (1.8896377) = 6849.98; × cargo 1.0 × 1^-0.3
// × conditions 1.00 × reputation tier 2 (1.04) × landing B (1.00) = 7123.98 → $7,124.
const EXPECTED_PAYOUT = 7124;
