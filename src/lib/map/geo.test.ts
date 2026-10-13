import { describe, expect, it } from "vitest";

import {
  greatCirclePoints,
  haversineNm,
  initialBearingDeg,
  intermediatePoint,
  isValidLatLon,
  normalizeBearing,
  normalizeLon,
  unwrapLongitudes,
} from "./geo";

const KMEM = { lat: 35.0424, lon: -89.9767 };
const KATL = { lat: 33.6367, lon: -84.4281 };
const LAX = { lat: 33.9425, lon: -118.4081 };
const JFK = { lat: 40.6398, lon: -73.7789 };

describe("haversineNm", () => {
  it("is zero for the same point", () => {
    expect(haversineNm(KMEM, KMEM)).toBe(0);
  });
  it("matches known great-circle distances", () => {
    // KMEM–KATL ≈ 287.7 nm (the demo fixture's planned distance).
    expect(haversineNm(KMEM, KATL)).toBeCloseTo(287.7, 0);
    // LAX–JFK ≈ 2,145 nm.
    expect(haversineNm(LAX, JFK)).toBeGreaterThan(2135);
    expect(haversineNm(LAX, JFK)).toBeLessThan(2155);
  });
  it("is symmetric and one degree of latitude is 60 nm", () => {
    expect(haversineNm(KATL, KMEM)).toBeCloseTo(haversineNm(KMEM, KATL), 9);
    expect(haversineNm({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(60.04, 1);
  });
});

describe("initialBearingDeg", () => {
  it("returns cardinal bearings", () => {
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 1, lon: 0 })).toBeCloseTo(0, 6);
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: 1 })).toBeCloseTo(90, 6);
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: -1, lon: 0 })).toBeCloseTo(180, 6);
    expect(initialBearingDeg({ lat: 0, lon: 0 }, { lat: 0, lon: -1 })).toBeCloseTo(270, 6);
  });
  it("KMEM → KATL is east-south-east", () => {
    const b = initialBearingDeg(KMEM, KATL);
    expect(b).toBeGreaterThan(105);
    expect(b).toBeLessThan(110);
  });
  it("LAX → JFK starts north of east (great circle, not rhumb line)", () => {
    expect(initialBearingDeg(LAX, JFK)).toBeCloseTo(65.9, 0);
  });
});

describe("intermediatePoint", () => {
  it("returns the endpoints at 0 and 1", () => {
    const a = intermediatePoint(KMEM, KATL, 0);
    const b = intermediatePoint(KMEM, KATL, 1);
    expect(a.lat).toBeCloseTo(KMEM.lat, 9);
    expect(a.lon).toBeCloseTo(KMEM.lon, 9);
    expect(b.lat).toBeCloseTo(KATL.lat, 9);
    expect(b.lon).toBeCloseTo(KATL.lon, 9);
  });
  it("the midpoint splits the distance in half", () => {
    const mid = intermediatePoint(LAX, JFK, 0.5);
    expect(haversineNm(LAX, mid)).toBeCloseTo(haversineNm(mid, JFK), 6);
    // The great circle bulges poleward of the straight lat/lon line.
    expect(mid.lat).toBeGreaterThan((LAX.lat + JFK.lat) / 2 + 1.5);
  });
  it("handles identical points", () => {
    expect(intermediatePoint(KMEM, KMEM, 0.3)).toEqual(KMEM);
  });
});

describe("greatCirclePoints", () => {
  it("includes both endpoints and scales the segment count with distance", () => {
    const pts = greatCirclePoints(KMEM, KATL);
    expect(pts[0]).toEqual([KMEM.lon, KMEM.lat]);
    expect(pts[pts.length - 1]).toEqual([KATL.lon, KATL.lat]);
    expect(pts.length).toBe(Math.ceil(haversineNm(KMEM, KATL) / 25) + 1);
    expect(greatCirclePoints(LAX, JFK).length).toBeGreaterThan(pts.length);
  });
  it("draws across the antimeridian without jumping", () => {
    const pts = greatCirclePoints({ lat: 21.3, lon: -157.9 }, { lat: 35.5, lon: 139.8 });
    for (let i = 1; i < pts.length; i++) {
      const prev = pts[i - 1];
      const cur = pts[i];
      expect(prev && cur && Math.abs(cur[0] - prev[0])).toBeLessThan(20);
    }
  });
});

describe("helpers", () => {
  it("normalises bearings and longitudes", () => {
    expect(normalizeBearing(-90)).toBe(270);
    expect(normalizeBearing(720)).toBe(0);
    expect(normalizeLon(190)).toBe(-170);
    expect(normalizeLon(-190)).toBe(170);
    expect(normalizeLon(180)).toBe(-180);
  });
  it("unwraps longitudes", () => {
    expect(
      unwrapLongitudes([
        [179, 0],
        [-179, 0],
      ]),
    ).toEqual([
      [179, 0],
      [181, 0],
    ]);
  });
  it("validates coordinates", () => {
    expect(isValidLatLon({ lat: 10, lon: 20 })).toBe(true);
    expect(isValidLatLon({ lat: 91, lon: 0 })).toBe(false);
    expect(isValidLatLon({ lat: Number.NaN, lon: 0 })).toBe(false);
    expect(isValidLatLon({ lat: 1 })).toBe(false);
    expect(isValidLatLon(null)).toBe(false);
  });
});
