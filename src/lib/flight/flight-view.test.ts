import { describe, expect, it } from "vitest";
import type { SimEvent, Snapshot, Welcome } from "@cargo-ops/protocol";
import { initialSimState, simReducer, type ClientSimState } from "@/lib/sim-state";

import {
  displayAglFt,
  enduranceStatus,
  enginesRunning,
  flightSummary,
  isSessionUp,
  isStale,
  latestTouchdown,
  routeView,
  simRateBadge,
  totalFuelFlowPph,
  weightsView,
} from "./flight-view";

const welcome: Welcome = {
  type: "welcome",
  v: 1,
  session: "s",
  mode: "demo",
  sim: { connected: false },
};

function withSnapshot(state: Snapshot["state"], at = 1000): ClientSimState {
  const s = simReducer(initialSimState, { type: "welcome", msg: welcome });
  return simReducer(s, {
    type: "snapshot",
    msg: { type: "snapshot", v: 1, seq: 0, source: "demo", state },
    at,
  });
}

function ev(seq: number, name: SimEvent["name"], data: unknown = null) {
  return {
    at: seq * 10,
    msg: { type: "event", v: 1, seq, source: "demo", name, data } as SimEvent,
  };
}

describe("isStale", () => {
  it("is false before any frame and before the clock starts", () => {
    expect(isStale(initialSimState, 10_000)).toBe(false);
    expect(isStale(withSnapshot({}), null)).toBe(false);
  });

  it("flags frames older than 5 s while connected", () => {
    const s = withSnapshot({}, 1000);
    expect(isSessionUp(s)).toBe(true);
    expect(isStale(s, 6000)).toBe(false);
    expect(isStale(s, 6001)).toBe(true);
  });

  it("flags held data once the session has ended", () => {
    const s = simReducer(withSnapshot({}, 1000), { type: "status", status: "disconnected" });
    expect(isStale(s, 1001)).toBe(true);
  });
});

describe("flight values", () => {
  it("shows AGL only below 2,500 ft", () => {
    expect(displayAglFt({ lat: 0, lon: 0, altFt: 3000, aglFt: 2499 })).toBe(2499);
    expect(displayAglFt({ lat: 0, lon: 0, altFt: 3000, aglFt: 2500 })).toBeNull();
    expect(displayAglFt(null)).toBeNull();
  });

  it("sums fuel flow and reports null without readings", () => {
    expect(totalFuelFlowPph({ totalGal: 1, totalLb: 1, flowPph: [200, 150.5] })).toBe(350.5);
    expect(totalFuelFlowPph({ totalGal: 1, totalLb: 1, flowPph: [] })).toBeNull();
    expect(totalFuelFlowPph(undefined)).toBeNull();
  });

  it("counts running engines", () => {
    expect(enginesRunning({ running: [true, false] })).toEqual({ running: 1, total: 2 });
    expect(enginesRunning({ running: [] })).toBeNull();
    expect(enginesRunning(null)).toBeNull();
  });

  it("warns when endurance is below ETE plus a 45 min reserve, only when ETE is known", () => {
    expect(enduranceStatus(100, 60)).toBe("low");
    expect(enduranceStatus(105, 60)).toBe("ok");
    expect(enduranceStatus(30, null)).toBeNull();
    expect(enduranceStatus(null, 30)).toBeNull();
  });

  it("badges sim rate only when not real time, warning above 4×", () => {
    expect(simRateBadge(1)).toBeNull();
    expect(simRateBadge(undefined)).toBeNull();
    expect(simRateBadge(2)).toEqual({ label: "×2", level: "info" });
    expect(simRateBadge(0.25)).toEqual({ label: "×0.25", level: "info" });
    expect(simRateBadge(4)).toEqual({ label: "×4", level: "info" });
    expect(simRateBadge(8)).toEqual({ label: "×8", level: "warning" });
  });

  it("derives weights and flags overweight", () => {
    expect(
      weightsView({ totalLb: 8430, emptyLb: 4730, maxGrossLb: 8750, payloadLb: 2000 }),
    ).toMatchObject({ fuelAndOtherLb: 1700, marginLb: 320, overweight: false });
    expect(
      weightsView({ totalLb: 9000, emptyLb: 4730, maxGrossLb: 8750, payloadLb: 2000 })?.overweight,
    ).toBe(true);
    expect(weightsView(null)).toBeNull();
  });
});

describe("routeView", () => {
  it("is all null without a plan domain", () => {
    expect(routeView(withSnapshot({ flight: { active: true, plannedDistanceNm: 100 } }))).toEqual({
      origin: null,
      destination: null,
      distanceRemainingNm: null,
      eteMin: null,
      progress: null,
      flownNm: null,
    });
  });

  it("derives progress and ETE from plan, flight and ground speed", () => {
    const s = withSnapshot({
      plan: { active: true, origin: "KMEM", destination: "KATL", destDistanceNm: 75 },
      flight: { active: true, plannedDistanceNm: 300, flownDistanceNm: 226 },
      motion: {
        iasKt: 150,
        tasKt: 170,
        gsKt: 150,
        hdgMagDeg: 100,
        hdgTrueDeg: 99,
        vsFpm: 0,
        gForce: 1,
        onGround: false,
      },
    });
    expect(routeView(s)).toEqual({
      origin: "KMEM",
      destination: "KATL",
      distanceRemainingNm: 75,
      eteMin: 30,
      progress: 0.75,
      flownNm: 226,
    });
  });

  it("leaves progress null without a planned distance", () => {
    const s = withSnapshot({ plan: { active: true, destDistanceNm: 75 } });
    expect(routeView(s).progress).toBeNull();
    expect(routeView(s).eteMin).toBeNull();
  });
});

describe("latestTouchdown", () => {
  const touchdown = {
    rateFpm: -142,
    gForce: 1.18,
    gsKt: 72,
    bankDeg: 0.8,
    pitchDeg: 4.6,
  };

  it("returns the latest touchdown with a provisional grade", () => {
    const view = latestTouchdown([ev(1, "flight.started"), ev(2, "touchdown", touchdown)]);
    expect(view).toMatchObject({ seq: 2, source: "demo", rateFpm: -142, grade: "B" });
  });

  it("is null before a touchdown and after the next flight starts", () => {
    expect(latestTouchdown([ev(1, "flight.started")])).toBeNull();
    expect(latestTouchdown([ev(1, "touchdown", touchdown), ev(2, "flight.started")])).toBeNull();
  });

  it("leaves missing fields null instead of guessing", () => {
    const view = latestTouchdown([ev(1, "touchdown", { rateFpm: -300 })]);
    expect(view).toMatchObject({ rateFpm: -300, gForce: null, bankDeg: null, grade: "C" });
    expect(latestTouchdown([ev(1, "touchdown", "bad")])?.grade).toBeNull();
  });
});

describe("latestTouchdown with the connector analyser", () => {
  const analysed = {
    rateFpm: -310,
    rateSource: "touchdownVelocity",
    peakG: 1.45,
    gsKt: 68,
    bankDeg: 1.2,
    pitchDeg: -3.5,
    lat: 33.64,
    lon: -84.45,
    bounces: 1,
    grade: "D",
    rateGrade: "D",
    gGrade: "C",
    speedGrade: null,
  };

  it("keeps the connector's grade and rate source", () => {
    const view = latestTouchdown([ev(1, "touchdown", analysed)]);
    expect(view).toMatchObject({
      analysed: true,
      rateSource: "touchdownVelocity",
      rateFpm: -310,
      gForce: 1.45,
      bounces: 1,
      grade: "D",
    });
  });

  it("marks legacy payloads as not analysed", () => {
    const view = latestTouchdown([ev(1, "touchdown", { rateFpm: -142, gForce: 1.18 })]);
    expect(view).toMatchObject({ analysed: false, rateSource: null, grade: "B" });
  });
});

describe("flightSummary", () => {
  it("prefers tracker fields and falls back to P1 fields", () => {
    expect(flightSummary(null)).toBeNull();
    expect(flightSummary({ active: true, flownDistanceNm: 12, elapsedSec: 600 })).toMatchObject({
      distanceNm: 12,
      blockMin: 10,
      airborneMin: null,
      flags: null,
    });
    const flags = {
      teleport: true,
      noBonus: false,
      invalidated: false,
      crashed: false,
      paused: false,
    };
    const view = flightSummary({
      active: false,
      status: "completed",
      distanceNm: 287.5,
      blockMin: 119.3,
      flags,
    });
    expect(view).toMatchObject({ status: "completed", distanceNm: 287.5, blockMin: 119.3, flags });
  });
});
