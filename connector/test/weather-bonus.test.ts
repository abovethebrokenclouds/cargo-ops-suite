// Weather bonus through the real ConnectorSession (docs/ECONOMY.md "Weather bonus"):
// the METAR flight category is frozen at departure (origin) and arrival (destination).
// Replays use SAMPLE weather and never earn a bonus; only live, current IFR/LIFR reports
// under simulator telemetry do.

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
import { computePayout, type EconomyAirport, type WeatherReportInput } from "../src/economy";
import { loadAirportsData } from "../src/core/economy/airports-data";
import type { WeatherLookup } from "../src/core/economy/engine";
import { WeatherService } from "../src/core/weather";
import { ConnectorSession } from "../src/core/session";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import type { SimSource } from "../src/sim/source";
import { openStorage } from "../src/storage/db";
import { EconomyRepo } from "../src/storage/economy";
import { FlightRepo } from "../src/storage/flights";
import { sampleMetar } from "../src/weather";
import { tempDir } from "./helpers";

const FIXTURE = join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl");
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const SEED = 4242;
/** The acceptance job pays $7,124 without any weather bonus (docs/ECONOMY.md). */
const EXPECTED_PAYOUT = 7124;

let airportsCache: EconomyAirport[] | null = null;
const airports = () => (airportsCache ??= loadAirportsData().airports);

/**
 * The replay fixture delivered through a source that stamps `sim` instead of `replay`:
 * the only way to exercise the sim-telemetry branch without a simulator. Test-only.
 */
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

function rig(dir: string, weather: WeatherLookup | null, opts: { sim?: boolean } = {}) {
  const frames = loadFixture(FIXTURE) as FixtureFrame[];
  const storage = openStorage(dir, "demo");
  const fake = new FakeSource({ frames, manual: true });
  const source = opts.sim ? simTagged(fake) : fake;
  const economy = new EconomyRepo(storage);
  let flightN = 0;
  let missionN = 0;
  const session = new ConnectorSession(source, () => {}, {
    repo: new FlightRepo(storage, source.frameSource),
    now: () => NOW,
    newId: () => `flight-${++flightN}`,
    economy: {
      repo: economy,
      airports: airports(),
      seed: SEED,
      replay: true,
      now: () => NOW,
      newId: () => `M-${++missionN}`,
    },
  });
  session.economy?.setWeatherLookup(weather);
  session.start();
  let n = 0;
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
  const fly = (): { job: Job; mission: Mission } => {
    ok("jobs.refresh", { airport: "KMEM", destination: "KATL" });
    const jobs = session.store.getDomain("jobs") as JobsState;
    const job = jobs.available.find((j) => j.destination === "KATL");
    assert.ok(job);
    ok("job.accept", { jobId: job.id });
    ok("mission.load", { jobIds: [job.id] });
    fake.playAll();
    const mission = session.store.getDomain("mission") as Mission;
    assert.equal(mission.status, "delivered");
    return { job, mission };
  };
  return { fly, economy, close: () => storage.close() };
}

/** A live report as the weather service would hold it, fetched 4 min and observed 9 min ago. */
function live(category: WeatherReportInput["category"], station: string): WeatherReportInput {
  return {
    origin: "live",
    category,
    rawText: `${station} 131151Z ...`,
    observedAt: new Date(NOW - 9 * 60_000).toISOString(),
    fetchedAt: new Date(NOW - 4 * 60_000).toISOString(),
    stale: false,
  };
}

const conditions = (m: Mission) => m.payout?.jobs[0]?.factors.find((f) => f.key === "conditions");

describe("weather bonus on the replayed KMEM → KATL mission", () => {
  it("replay + SAMPLE weather (the connector's default): categories recorded, no bonus", () => {
    const tmp = tempDir();
    try {
      const svc = new WeatherService({
        mode: "sample",
        version: "0",
        log: () => {},
        now: () => NOW,
      });
      const r = rig(tmp.dir, (s) => svc.peek(s));
      const { mission } = r.fly();
      const dep = mission.weather?.departure;
      const arr = mission.weather?.arrival;
      assert.deepEqual(
        [dep?.station, dep?.category, dep?.metarOrigin, dep?.source, dep?.eligible],
        ["KMEM", "VFR", "sample", "replay", false],
      );
      assert.deepEqual(
        [arr?.station, arr?.category, arr?.metarOrigin, arr?.source, arr?.eligible],
        ["KATL", "MVFR", "sample", "replay", false],
      );
      assert.match(dep?.message ?? "", /sample METAR, never a bonus/);
      assert.equal(mission.weather?.bonus, 0);
      assert.equal(conditions(mission)?.value, 1);
      assert.equal(mission.payout?.total, EXPECTED_PAYOUT);
      assert.equal(mission.payout?.jobs[0]?.weatherBonus, undefined);
      // The logbook row carries the frozen weather.
      assert.equal(r.economy.logbook()[0]?.mission?.weather?.arrival?.category, "MVFR");
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("a SAMPLE LIFR report never pays, even under sim telemetry", () => {
    const tmp = tempDir();
    try {
      const fog = (s: string) => {
        const r = sampleMetar("KSEA", new Date(NOW)); // 1/2SM FG VV002 → LIFR
        assert.ok(r);
        return { ...r, station: s };
      };
      const r = rig(tmp.dir, fog, { sim: true });
      const { mission } = r.fly();
      assert.equal(mission.weather?.departure?.category, "LIFR");
      assert.equal(mission.weather?.departure?.eligible, false);
      assert.equal(mission.weather?.arrival?.eligible, false);
      assert.equal(mission.weather?.bonus, 0);
      assert.equal(mission.payout?.total, EXPECTED_PAYOUT);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("a live LIFR report under replay telemetry pays nothing", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir, (s) => live("LIFR", s));
      const { mission } = r.fly();
      assert.equal(mission.weather?.departure?.metarOrigin, "live");
      assert.equal(mission.weather?.departure?.eligible, false);
      assert.match(mission.weather?.departure?.message ?? "", /replay telemetry/);
      assert.equal(mission.payout?.total, EXPECTED_PAYOUT);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("no weather at all (--weather off): unknown, no bonus, no penalty", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir, null, { sim: true });
      const { mission } = r.fly();
      assert.equal(mission.weather?.departure?.category, null);
      assert.equal(mission.weather?.arrival?.category, null);
      assert.equal(mission.weather?.bonus, 0);
      assert.equal(mission.payout?.total, EXPECTED_PAYOUT);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("sim telemetry + live IFR at KMEM and LIFR at KATL: +10 % (max of the ends, capped)", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir, (s) => live(s === "KMEM" ? "IFR" : "LIFR", s), { sim: true });
      const { job, mission } = r.fly();
      assert.equal(mission.weather?.departure?.category, "IFR");
      assert.equal(mission.weather?.departure?.eligible, true);
      assert.equal(mission.weather?.departure?.source, "sim");
      assert.equal(mission.weather?.arrival?.category, "LIFR");
      assert.equal(mission.weather?.bonus, 0.1);
      assert.equal(conditions(mission)?.value, 1.1);
      assert.match(conditions(mission)?.note ?? "", /LIFR at KATL arrival \(live METAR\) \+10 %/);
      // 6,849.98 × 1.10 (conditions) × 1.04 (tier 2) = 7,836.38 → $7,836.
      const expected = computePayout({
        kind: job.kind,
        weightKg: job.weightKg,
        distanceNm: job.distanceNm,
        units: job.units,
        reputation: 50,
        estimate: false,
        landingGrade: "B",
        lateMin: 0,
        weather: mission.weather ?? null,
      }).total;
      assert.equal(expected, 7836);
      assert.equal(mission.payout?.total, 7836);
      assert.equal(mission.payout?.jobs[0]?.weatherBonus, 0.1);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });

  it("a stale live report (failed refresh) is not used", () => {
    const tmp = tempDir();
    try {
      const r = rig(tmp.dir, (s) => ({ ...live("LIFR", s), stale: true }), { sim: true });
      const { mission } = r.fly();
      assert.equal(mission.weather?.departure?.eligible, false);
      assert.match(mission.weather?.departure?.message ?? "", /stale/);
      assert.equal(mission.payout?.total, EXPECTED_PAYOUT);
      r.close();
    } finally {
      tmp.cleanup();
    }
  });
});
