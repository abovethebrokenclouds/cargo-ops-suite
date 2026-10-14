// Transit cargo (docs/ECONOMY.md "Transit cargo"): storage, the chain clock, progress,
// the final payout over the whole chain, reputation per leg, long-haul board jobs and the
// route finder. Worked examples are the ones in the doc.

import { describe, expect, it } from "vitest";
import { aircraftTypeByKey, type AircraftType, type Job } from "@cargo-ops/protocol";
import {
  CARGO_TERMINAL,
  LONG_HAUL_JOBS_PER_BOARD,
  TRANSIT_STOP_SLACK_MIN,
  airportLookup,
  arriveInTransit,
  chainElapsedMin,
  checkTransitProgress,
  computePayout,
  countedGroundMin,
  finalDeliveryTerms,
  findRoutes,
  generateJobs,
  greatCircleNm,
  jobLocation,
  legReputationDelta,
  longHaulCandidates,
  maxJobDistanceNm,
  payloadLimitKg,
  timeLimitMin,
  transitRemainingMin,
  transitStorage,
  type FlownLeg,
} from "../src/index";
import { bundledAirports } from "./airports";

function type(key: string): AircraftType {
  const t = aircraftTypeByKey(key);
  if (!t) throw new Error(key);
  return t;
}

const airports = airportLookup(bundledAirports());
const apt = (icao: string) => {
  const a = airports.get(icao);
  if (!a) throw new Error(icao);
  return a;
};
const C208B = type("c208b");
const MIN = 60_000;
const T0 = 10 * 86_400_000; // company clock at the first arrival

/** A KMEM → KRDU job (549.2 nm) as the board would make it. */
function krduJob(kind: Job["kind"], weightKg: number): Job {
  const distanceNm = Math.round(greatCircleNm(apt("KMEM"), apt("KRDU")) * 10) / 10;
  const breakdown = computePayout({
    jobId: "J-T",
    kind,
    weightKg,
    distanceNm,
    units: 1,
    reputation: 50,
    estimate: true,
  });
  return {
    id: "J-T",
    status: "loaded",
    origin: "KMEM",
    destination: "KRDU",
    kind,
    weightKg,
    units: 1,
    distanceNm,
    timeLimitMin: timeLimitMin(kind, distanceNm, C208B.cruiseKt),
    aircraftKey: "c208b",
    createdAt: "2026-10-13T12:00:00.000Z",
    expiresAt: "2026-10-14T12:00:00.000Z",
    missionId: "M-1",
    payoutEstimate: breakdown.total,
    breakdown,
  };
}

const leg1: FlownLeg = {
  missionId: "M-1",
  flightId: "F-1",
  origin: "KMEM",
  destination: "KATL",
  blockMin: 119,
  landingGrade: "B",
  peakG: 1.18,
  noBonus: false,
  payloadMismatch: false,
};

const stop = (storage: ReturnType<typeof transitStorage>) => ({
  arrivedAt: "2026-10-13T14:00:00.000Z",
  arrivedGameMs: T0,
  locationName: "Hartsfield-Jackson Atlanta International Airport",
  ...storage,
});

describe("transit storage", () => {
  it("own cargo terminal L1/L2/L3 keeps 4/8/12 h off the deadline; otherwise none", () => {
    expect(transitStorage({ fbo: false, terminalLevel: 0 })).toEqual({
      storage: "airport",
      freeStorageMin: 0,
    });
    expect(transitStorage({ fbo: true, terminalLevel: 0 })).toEqual({
      storage: "own_fbo",
      freeStorageMin: 0,
    });
    expect(CARGO_TERMINAL.transitFreeStorageHours).toEqual([4, 8, 12]);
    expect([1, 2, 3].map((l) => transitStorage({ fbo: true, terminalLevel: l }))).toEqual([
      { storage: "own_terminal", freeStorageMin: 240 },
      { storage: "own_terminal", freeStorageMin: 480 },
      { storage: "own_terminal", freeStorageMin: 720 },
    ]);
  });
});

describe("chain clock and deadline", () => {
  it("worked example 1: general cargo KMEM → KRDU via KATL, on time, full payout once", () => {
    const job = krduJob("cargo", 500);
    expect(job.distanceNm).toBe(549.2);
    expect(job.timeLimitMin).toBe(630); // 549.2 / 170 h × 2 + 240 min → 627.7 → 630
    expect(jobLocation(job)).toBe("KMEM");
    const stored = arriveInTransit(
      job,
      leg1,
      stop(transitStorage({ fbo: false, terminalLevel: 0 })),
    );
    expect(stored.status).toBe("in_transit");
    expect(stored.missionId).toBeUndefined();
    expect(jobLocation(stored)).toBe("KATL");
    expect(stored.transit).toMatchObject({
      location: "KATL",
      elapsedMin: 119,
      storage: "airport",
      freeStorageMin: 0,
      arrivedGameMs: T0,
      // 630 − 119 = 511 min left on the company clock.
      deadlineGameMs: T0 + 511 * MIN,
    });
    expect(stored.transit?.legs).toHaveLength(1);
    expect(stored.transit?.legs[0]).toMatchObject({
      origin: "KMEM",
      destination: "KATL",
      groundMin: 0,
    });
    // Two hours on the ground count.
    expect(countedGroundMin(stored.transit!, T0 + 120 * MIN)).toBe(120);
    expect(chainElapsedMin(stored, T0 + 120 * MIN)).toBe(239);
    expect(transitRemainingMin(stored, T0 + 120 * MIN)).toBe(391);
    // Leg 2 KATL → KRDU (125 min) departs 2 h later: chain 119 + 120 + 125 = 364 min.
    const leg2: FlownLeg = {
      ...leg1,
      missionId: "M-2",
      flightId: "F-2",
      origin: "KATL",
      destination: "KRDU",
      startedGameMs: T0 + 120 * MIN,
      blockMin: 125,
    };
    const terms = finalDeliveryTerms(stored, leg2);
    expect(terms).toEqual({
      lateMin: -266,
      chainMin: 364,
      peakG: 1.18,
      noBonus: false,
      payloadMismatch: false,
      legs: 2,
    });
    // base 0.015 × 500 × 549.2 × 1.9420812 = $7,999.43; × 1.04 × B 1.00 = $8,319.41 → $8,319,
    // exactly the board estimate (on time, landing B).
    const paid = computePayout({
      kind: job.kind,
      weightKg: job.weightKg,
      distanceNm: job.distanceNm,
      units: 1,
      reputation: 50,
      estimate: false,
      landingGrade: "B",
      lateMin: terms.lateMin,
      peakG: terms.peakG,
      chain: { legs: terms.legs, chainMin: terms.chainMin },
    });
    expect(paid.base).toBe(7999.43);
    expect(paid.total).toBe(8319);
    expect(paid.total).toBe(job.payoutEstimate);
    expect(paid.factors.find((f) => f.key === "late")?.note).toBe(
      "On time · transit chain of 2 legs, 364.0 min incl. ground time",
    );
  });

  it("worked example 2: express 200 kg, 150 min at the stop — public ramp vs own terminal L1", () => {
    const job = krduJob("express", 200);
    expect(job.timeLimitMin).toBe(240); // 193.8 + 45 → 240
    const leg2 = (startedGameMs: number): FlownLeg => ({
      ...leg1,
      missionId: "M-2",
      origin: "KATL",
      destination: "KRDU",
      startedGameMs,
      blockMin: 125,
    });
    const pay = (lateMin: number) =>
      computePayout({
        kind: "express",
        weightKg: 200,
        distanceNm: job.distanceNm,
        units: 1,
        reputation: 50,
        estimate: false,
        landingGrade: "B",
        lateMin,
      });
    // Public ramp: 119 + 150 + 125 = 394 min → 154 min late → −25.67 % of $4,991.65.
    const ramp = arriveInTransit(job, leg1, stop(transitStorage({ fbo: false, terminalLevel: 0 })));
    const rampTerms = finalDeliveryTerms(ramp, leg2(T0 + 150 * MIN));
    expect(rampTerms.chainMin).toBe(394);
    expect(rampTerms.lateMin).toBe(154);
    expect(pay(rampTerms.lateMin)).toMatchObject({
      gross: 4991.65,
      deductions: 1281.19,
      total: 3710,
    });
    // Own cargo terminal L1 at KATL: 240 free minutes → 0 ground counted → 4 min late.
    const terminal = arriveInTransit(
      job,
      leg1,
      stop(transitStorage({ fbo: true, terminalLevel: 1 })),
    );
    expect(terminal.transit?.deadlineGameMs).toBe(T0 + (240 - 119 + 240) * MIN);
    const termTerms = finalDeliveryTerms(terminal, leg2(T0 + 150 * MIN));
    expect(termTerms.chainMin).toBe(244);
    expect(termTerms.lateMin).toBe(4);
    expect(pay(termTerms.lateMin)).toMatchObject({ deductions: 33.28, total: 4958 });
    // Beyond the free hours the ground counts again: 5 h at the terminal → 60 min.
    expect(countedGroundMin(terminal.transit!, T0 + 300 * MIN)).toBe(60);
  });

  it("a first leg with no transit record counts no ground time", () => {
    const job = krduJob("cargo", 500);
    expect(chainElapsedMin(job, T0)).toBe(0);
    expect(transitRemainingMin(job, T0)).toBe(630);
    expect(
      finalDeliveryTerms(job, { ...leg1, destination: "KRDU", startedGameMs: T0 }).chainMin,
    ).toBe(119);
  });

  it("bonuses lost on any leg and a hard touchdown on any leg carry to the final payout", () => {
    const job = krduJob("fragile", 300);
    const rough = arriveInTransit(
      job,
      { ...leg1, peakG: 1.62, noBonus: true },
      stop(transitStorage({ fbo: false, terminalLevel: 0 })),
    );
    const terms = finalDeliveryTerms(rough, {
      ...leg1,
      origin: "KATL",
      destination: "KRDU",
      startedGameMs: T0 + 30 * MIN,
      peakG: 1.1,
      blockMin: 125,
    });
    expect(terms.peakG).toBe(1.62);
    expect(terms.noBonus).toBe(true);
    expect(terms.payloadMismatch).toBe(false);
    const underloaded = arriveInTransit(
      krduJob("cargo", 500),
      { ...leg1, payloadMismatch: true },
      stop(transitStorage({ fbo: false, terminalLevel: 0 })),
    );
    expect(finalDeliveryTerms(underloaded, { ...leg1, destination: "KRDU" }).payloadMismatch).toBe(
      true,
    );
    // Fragile damaged on leg 1 (1.62 G > 1.5): 50 % of $6,489.14 → $3,245 at the end.
    const paid = computePayout({
      kind: "fragile",
      weightKg: 300,
      distanceNm: job.distanceNm,
      units: 1,
      reputation: 50,
      estimate: false,
      landingGrade: "B",
      lateMin: terms.lateMin,
      peakG: terms.peakG,
    });
    expect(paid).toMatchObject({ gross: 6489.14, deductions: 3244.57, total: 3245 });
  });
});

describe("transit rules", () => {
  it("a transit leg must end closer to the final destination", () => {
    const job = { id: "J-T", destination: "KRDU" };
    expect(checkTransitProgress(job, apt("KMEM"), apt("KATL"), apt("KRDU")).ok).toBe(true);
    expect(checkTransitProgress(job, apt("KMEM"), apt("KRDU"), apt("KRDU")).ok).toBe(true);
    const west = checkTransitProgress(job, apt("KMEM"), apt("KLIT"), apt("KRDU"));
    expect(west.ok).toBe(false);
    if (!west.ok) expect(west.code).toBe("no_progress");
  });

  it("reputation: a transit-only leg earns nothing but a hard landing still costs 5", () => {
    expect(legReputationDelta("A+", [])).toBe(0);
    expect(legReputationDelta("B", [])).toBe(0);
    expect(legReputationDelta("D", [])).toBe(-5);
    expect(legReputationDelta("B", [-266])).toBe(2);
    expect(legReputationDelta("A", [4])).toBe(-3); // one started late hour
  });
});

describe("long-haul jobs on the board", () => {
  const base = {
    origin: apt("KMEM"),
    airports: bundledAirports(),
    aircraft: C208B,
    seed: 4242,
    nowMs: Date.UTC(2026, 9, 13),
    reputation: 50,
  };

  it("are drawn after the regular jobs without changing them", () => {
    const plain = generateJobs(base);
    const withLong = generateJobs({ ...base, longHaulJobs: LONG_HAUL_JOBS_PER_BOARD });
    expect(withLong.slice(0, plain.length)).toEqual(plain);
    const extra = withLong.slice(plain.length);
    expect(extra).toHaveLength(2);
    expect(generateJobs({ ...base, longHaulJobs: 2 })).toEqual(withLong); // deterministic
    const maxNm = maxJobDistanceNm(C208B);
    for (const j of extra) {
      expect(j.longHaul).toBe(true);
      expect(j.distanceNm).toBeGreaterThan(maxNm);
      expect(j.distanceNm).toBeLessThanOrEqual(maxNm * 2);
      expect(j.weightKg).toBeLessThanOrEqual(payloadLimitKg(C208B, j.distanceNm / 2));
      expect(j.timeLimitMin).toBe(
        timeLimitMin(j.kind, j.distanceNm, C208B.cruiseKt) + TRANSIT_STOP_SLACK_MIN,
      );
      expect(plain.some((p) => p.id === j.id)).toBe(false);
    }
  });

  it("a focus beyond the direct range gets the first long-haul job", () => {
    const miami = generateJobs({ ...base, longHaulJobs: 2, focus: apt("KMIA") });
    const long = miami.filter((j) => j.longHaul);
    expect(long[0]?.destination).toBe("KMIA");
    expect(long[0]?.distanceNm).toBeGreaterThan(720);
    expect(longHaulCandidates(apt("KMEM"), bundledAirports(), C208B).length).toBeGreaterThan(100);
  });

  it("the route finder never offers a long-haul job as one leg", () => {
    const jobs = generateJobs({ ...base, longHaulJobs: 2 });
    const longIds = new Set(jobs.filter((j) => j.longHaul).map((j) => j.id));
    const chains = findRoutes({ start: "KMEM", jobs, aircraft: C208B, limit: 50 });
    for (const c of chains)
      for (const l of c.legs) for (const id of l.jobIds) expect(longIds.has(id)).toBe(false);
  });
});
