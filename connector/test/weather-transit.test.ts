// Weather bonus on transit cargo (docs/ECONOMY.md "Weather bonus on transit cargo") through
// the real ConnectorSession. Leg 1 replays the synthetic KMEM → KATL fixture; leg 2 KATL →
// KRDU is the same SYNTHETIC fixture re-projected onto that route (transit-leg.ts). Neither
// is simulator telemetry: the frames are re-stamped `sim` by a test-only source (as in
// weather-bonus.test.ts) to reach the sim-telemetry branch, and the "live" METARs are
// hand-made test reports, never fetched weather.
//
// Rule under test: the final delivery uses the FIRST leg's departure check (KMEM) and the
// final leg's arrival check (KRDU); the intermediate stop (KATL) is recorded on the legs that
// actually arrived/departed there but never sets the bonus.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  PROTOCOL_VERSION,
  type Command,
  type FixtureFrame,
  type Job,
  type JobsState,
  type Mission,
  type Result,
} from "../src/protocol";
import {
  airportLookup,
  computePayout,
  type EconomyAirport,
  type WeatherReportInput,
} from "../src/economy";
import { loadAirportsData } from "../src/core/economy/airports-data";
import type { WeatherLookup } from "../src/core/economy/engine";
import { ConnectorSession } from "../src/core/session";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import type { SimSource } from "../src/sim/source";
import { openStorage } from "../src/storage/db";
import { EconomyRepo } from "../src/storage/economy";
import { exportCareer, importCareer } from "../src/storage/career";
import { FlightRepo } from "../src/storage/flights";
import { tempDir } from "./helpers";
import { reprojectLeg } from "./transit-leg";

const FIXTURE = join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl");
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);

let airportsCache: EconomyAirport[] | null = null;
const airports = () => (airportsCache ??= loadAirportsData().airports);
const apt = (icao: string): EconomyAirport => {
  const a = airportLookup(airports()).get(icao);
  if (!a) throw new Error(icao);
  return a;
};

function twoLegs(): { frames: FixtureFrame[]; leg2Start: number } {
  const leg1 = loadFixture(FIXTURE);
  const end = leg1.at(-1)?.t ?? 0;
  const leg2 = reprojectLeg(leg1, apt("KMEM"), apt("KATL"), apt("KATL"), apt("KRDU"), end + 5_000);
  return { frames: [...leg1, ...leg2], leg2Start: leg1.length };
}

/** Test-only: the replay fixture stamped `sim` (see the file header). */
function simTagged(inner: FakeSource): SimSource {
  return {
    mode: "live",
    frameSource: "sim",
    link: () => inner.link(),
    subscribe: (l) => inner.subscribe(l),
    start: () => inner.start(),
    stop: () => inner.stop(),
  };
}

/** A hand-made live report, fetched 4 min and observed 9 min before the check. */
function live(category: WeatherReportInput["category"], station: string): WeatherReportInput {
  return {
    origin: "live",
    category,
    rawText: `${station} 131151Z TEST`,
    observedAt: new Date(NOW - 9 * 60_000).toISOString(),
    fetchedAt: new Date(NOW - 4 * 60_000).toISOString(),
    stale: false,
  };
}

function rig(dir: string, frames: FixtureFrame[], weather: WeatherLookup) {
  const storage = openStorage(dir, "demo");
  const fake = new FakeSource({ frames, manual: true });
  const source = simTagged(fake);
  const repo = new EconomyRepo(storage);
  let n = 0;
  let flightN = 0;
  let missionN = 0;
  const session = new ConnectorSession(source, () => {}, {
    repo: new FlightRepo(storage, source.frameSource),
    now: () => NOW,
    newId: () => `flight-${++flightN}`,
    economy: {
      repo,
      airports: airports(),
      seed: 4242,
      replay: true,
      now: () => NOW,
      newId: () => `M-${++missionN}`,
    },
  });
  session.economy?.setWeatherLookup(weather);
  session.start();
  const ok = <T>(name: string, args: unknown = {}): T => {
    const r: Result = session.command({
      type: "command",
      v: PROTOCOL_VERSION,
      id: `c${++n}`,
      name,
      args,
    } as Command);
    if (!r.ok) assert.fail(`${name} failed: ${r.error.code} ${r.error.message}`);
    return r.data as T;
  };
  return {
    fake,
    storage,
    repo,
    ok,
    jobs: () => session.store.getDomain("jobs") as JobsState,
    mission: () => session.store.getDomain("mission") as Mission,
    reputation: () => session.economy?.companyBook.company.reputation ?? 0,
    close: () => storage.close(),
  };
}

type Rig = ReturnType<typeof rig>;

/** Fly KMEM → KRDU via KATL; returns the job, the stored job and both legs. */
function flyChain(r: Rig, leg2Start: number) {
  r.ok("jobs.refresh", { airport: "KMEM", destination: "KRDU" });
  const job = r.jobs().available.find((j) => j.destination === "KRDU");
  assert.ok(job);
  r.ok("job.accept", { jobId: job.id });
  r.ok("mission.load", { jobIds: [job.id], destination: "KATL" });
  r.fake.playRange(0, leg2Start);
  const leg1 = r.mission();
  assert.equal(leg1.status, "delivered", JSON.stringify(leg1.failure ?? leg1.startBlocked));
  const stored = r.jobs().inTransit?.find((j) => j.id === job.id);
  assert.ok(stored);
  r.ok("mission.load", { jobIds: [job.id] });
  const rep = r.reputation();
  r.fake.playRange(leg2Start);
  const leg2 = r.mission();
  assert.equal(leg2.status, "delivered", JSON.stringify(leg2.failure ?? leg2.startBlocked));
  return { job, stored, leg1, leg2, rep };
}

function expectedTotal(job: Job, leg2: Mission, rep: number, stored: Job): number {
  const late = leg2.payout?.jobs[0]?.factors.find((f) => f.key === "late");
  assert.ok(late);
  const block2 = leg2.elapsedMin ?? 0;
  const chainMin = Math.round(((stored.transit?.elapsedMin ?? 0) + block2) * 10) / 10;
  return computePayout({
    kind: job.kind,
    weightKg: job.weightKg,
    distanceNm: job.distanceNm,
    units: job.units,
    reputation: rep,
    estimate: false,
    landingGrade: "B",
    lateMin: Math.round((chainMin - job.timeLimitMin) * 10) / 10,
    weather: {
      ...(leg2.weather?.arrival ? { arrival: leg2.weather.arrival } : {}),
      ...(stored.transit?.legs[0]?.weather?.departure
        ? { departure: stored.transit.legs[0].weather.departure }
        : {}),
    },
    ...(job.demandFactor !== undefined ? { demand: job.demandFactor } : {}),
  }).total;
}

describe("weather bonus on a two-leg transit delivery (KMEM → KATL → KRDU)", () => {
  it("first departure IFR, stop LIFR, final arrival VFR: +5 % from KMEM, KATL never counts", () => {
    const tmp = tempDir();
    const { frames, leg2Start } = twoLegs();
    const wx: Record<string, WeatherReportInput["category"]> = {
      KMEM: "IFR",
      KATL: "LIFR",
      KRDU: "VFR",
    };
    try {
      const r = rig(tmp.dir, frames, (s) => live(wx[s] ?? null, s));
      const { job, stored, leg1, leg2, rep } = flyChain(r, leg2Start);

      // Leg 1 delivered nothing: both checks recorded, no bonus decided yet.
      assert.equal(leg1.weather?.departure?.station, "KMEM");
      assert.equal(leg1.weather?.arrival?.station, "KATL");
      assert.equal(leg1.weather?.arrival?.category, "LIFR");
      assert.equal(leg1.weather?.bonus, undefined);
      // The stored job carries the checks of the leg it flew.
      const l1 = stored.transit?.legs[0]?.weather;
      assert.equal(l1?.departure?.category, "IFR");
      assert.equal(l1?.departure?.eligible, true);
      assert.equal(l1?.arrival?.station, "KATL");
      assert.equal(l1?.bonus, undefined);

      // Leg 2 records its own ends (KATL departure LIFR, KRDU arrival VFR) ...
      assert.equal(leg2.weather?.departure?.station, "KATL");
      assert.equal(leg2.weather?.departure?.category, "LIFR");
      assert.equal(leg2.weather?.arrival?.station, "KRDU");
      assert.equal(leg2.weather?.arrival?.category, "VFR");
      // ... but the chain pays on KMEM's IFR (first departure) and KRDU's VFR: +5 %.
      const cond = leg2.payout?.jobs[0]?.factors.find((f) => f.key === "conditions");
      assert.equal(cond?.value, 1.05);
      assert.match(cond?.note ?? "", /IFR at KMEM departure \(live METAR\) \+5 %/);
      assert.equal(leg2.payout?.jobs[0]?.weatherBonus, 0.05);
      assert.equal(leg2.weather?.bonus, 0.05);
      assert.equal(leg2.payout?.total, expectedTotal(job, leg2, rep, stored));

      // Weather lives in the job and mission JSON: the v5 career export carries it and an
      // import into a fresh database round-trips it unchanged (no format bump needed).
      const exported = exportCareer(r.repo, "demo", NOW);
      assert.equal(exported.version, 5);
      const exJob = exported.jobs.find((j) => j.id === job.id);
      assert.equal(exJob?.status, "delivered");
      assert.equal(exJob?.transit?.legs[0]?.weather?.departure?.category, "IFR");
      const exLeg2 = exported.missions.find((m) => m.id === leg2.id);
      assert.equal(exLeg2?.weather?.bonus, 0.05);
      assert.equal(exLeg2?.payout?.jobs[0]?.weatherBonus, 0.05);
      r.close();
      const tmp2 = tempDir();
      try {
        const s2 = openStorage(tmp2.dir, "demo");
        const repo2 = new EconomyRepo(s2);
        const res = importCareer(repo2, "demo", JSON.parse(JSON.stringify(exported)));
        assert.ok(res.ok, JSON.stringify(res));
        const again = exportCareer(repo2, "demo", NOW);
        assert.deepEqual(again.jobs, exported.jobs);
        assert.deepEqual(again.missions, exported.missions);
        s2.close();
      } finally {
        tmp2.cleanup();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it("final arrival LIFR pays +10 % even when the first departure was VFR", () => {
    const tmp = tempDir();
    const { frames, leg2Start } = twoLegs();
    const wx: Record<string, WeatherReportInput["category"]> = {
      KMEM: "VFR",
      KATL: "VFR",
      KRDU: "LIFR",
    };
    try {
      const r = rig(tmp.dir, frames, (s) => live(wx[s] ?? null, s));
      const { job, stored, leg2, rep } = flyChain(r, leg2Start);
      assert.equal(leg2.payout?.jobs[0]?.weatherBonus, 0.1);
      assert.equal(leg2.weather?.bonus, 0.1);
      assert.equal(leg2.payout?.total, expectedTotal(job, leg2, rep, stored));
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("an IFR/LIFR stop alone (VFR at both chain ends) earns nothing", () => {
    const tmp = tempDir();
    const { frames, leg2Start } = twoLegs();
    const wx: Record<string, WeatherReportInput["category"]> = {
      KMEM: "VFR",
      KATL: "LIFR",
      KRDU: "MVFR",
    };
    try {
      const r = rig(tmp.dir, frames, (s) => live(wx[s] ?? null, s));
      const { job, stored, leg2, rep } = flyChain(r, leg2Start);
      assert.equal(leg2.weather?.departure?.category, "LIFR"); // recorded on the leg
      assert.equal(leg2.payout?.jobs[0]?.weatherBonus, undefined);
      assert.equal(leg2.weather?.bonus, 0);
      const cond = leg2.payout?.jobs[0]?.factors.find((f) => f.key === "conditions");
      assert.equal(cond?.value, 1);
      assert.equal(leg2.payout?.total, expectedTotal(job, leg2, rep, stored));
      r.close();
    } finally {
      tmp.cleanup();
    }
  });
});
