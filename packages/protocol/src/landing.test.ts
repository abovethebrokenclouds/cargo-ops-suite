import { describe, expect, it } from "vitest";
import {
  flightDomainSchema,
  landingGrade,
  parseServerMessage,
  simStatePatchSchema,
  speedGrade,
  touchdownSchema,
} from "./index";

const touchdown = {
  rateFpm: -142,
  rateSource: "verticalSpeed",
  peakG: 1.18,
  gsKt: 72,
  bankDeg: null,
  pitchDeg: null,
  lat: 33.64515,
  lon: -84.45826,
  bounces: 0,
  grade: "B",
  rateGrade: "B",
  gGrade: "A",
  speedGrade: null,
};

describe("touchdownSchema", () => {
  it("accepts a connector touchdown and rejects unknown rate sources", () => {
    expect(touchdownSchema.safeParse(touchdown).success).toBe(true);
    expect(touchdownSchema.safeParse({ ...touchdown, rateSource: "guess" }).success).toBe(false);
    expect(touchdownSchema.safeParse({ ...touchdown, bounces: -1 }).success).toBe(false);
  });

  it("does not match the legacy authored demo payload (no rateSource)", () => {
    const legacy = {
      rateFpm: -142,
      gForce: 1.18,
      gsKt: 72,
      bankDeg: 0.8,
      pitchDeg: 4.6,
      lat: 1,
      lon: 2,
    };
    expect(touchdownSchema.safeParse(legacy).success).toBe(false);
  });
});

describe("speed grade", () => {
  it("is null without a reference speed and caps the grade when known", () => {
    expect(speedGrade(72, null)).toBeNull();
    expect(speedGrade(72, 70)).toBe("A+");
    expect(speedGrade(85, 70)).toBe("C");
    expect(speedGrade(120, 70)).toBe("E");
    expect(landingGrade(-50, 1.0, speedGrade(85, 70))).toBe("C");
    expect(landingGrade(-50, 1.0)).toBe("A+");
  });
});

describe("flight domain (P2 fields)", () => {
  it("accepts the tracker fields and stays backward compatible", () => {
    expect(flightDomainSchema.safeParse({ active: true, flownDistanceNm: 3 }).success).toBe(true);
    const full = {
      active: false,
      id: "f1",
      status: "completed",
      startedAt: "2026-10-13T12:00:00.000Z",
      endedAt: "2026-10-13T14:00:00.000Z",
      distanceNm: 287.5,
      airborneMin: 106.1,
      blockMin: 119.3,
      maxAltFt: 9515,
      fuelUsedLb: 623.1,
      flags: { teleport: false, noBonus: true, invalidated: false, crashed: false, paused: false },
    };
    expect(flightDomainSchema.safeParse(full).success).toBe(true);
    expect(flightDomainSchema.safeParse({ ...full, status: "lost" }).success).toBe(false);
    expect(simStatePatchSchema.safeParse({ sim: { simTimeSec: 12.5 } }).success).toBe(true);
  });

  it("parseServerMessage still accepts P1 frames and the new event payloads", () => {
    const p1 = {
      type: "delta",
      v: 1,
      seq: 3,
      source: "sim",
      patch: { flight: { active: true, flownDistanceNm: 10, elapsedSec: 60 } },
    };
    expect(parseServerMessage(p1).ok).toBe(true);
    const ev = {
      type: "event",
      v: 1,
      seq: 4,
      source: "replay",
      name: "touchdown",
      data: touchdown,
    };
    expect(parseServerMessage(ev).ok).toBe(true);
    const motion = {
      type: "delta",
      v: 1,
      seq: 5,
      source: "sim",
      patch: { motion: { touchdownVelocityFpm: -126, touchdownBankDeg: 1.5 } },
    };
    expect(parseServerMessage(motion).ok).toBe(true);
  });
});
