import { describe, expect, it } from "vitest";

import { TRAIL_CAPACITY, TrailBuffer } from "./trail";

describe("TrailBuffer", () => {
  it("defaults to about 2,000 points", () => {
    expect(new TrailBuffer().capacity).toBe(TRAIL_CAPACITY);
    expect(TRAIL_CAPACITY).toBe(2000);
  });

  it("returns points oldest first", () => {
    const t = new TrailBuffer(5);
    t.push(1, 10);
    t.push(2, 20);
    t.push(3, 30);
    expect(t.size).toBe(3);
    expect(t.toArray()).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
    ]);
  });

  it("overwrites the oldest point when full", () => {
    const t = new TrailBuffer(3);
    for (let i = 1; i <= 7; i++) t.push(i, i);
    expect(t.size).toBe(3);
    expect(t.toArray()).toEqual([
      [5, 5],
      [6, 6],
      [7, 7],
    ]);
  });

  it("skips consecutive duplicates and non-finite values", () => {
    const t = new TrailBuffer(4);
    expect(t.push(1, 1)).toBe(true);
    expect(t.push(1, 1)).toBe(false);
    expect(t.push(Number.NaN, 1)).toBe(false);
    expect(t.push(1, Number.POSITIVE_INFINITY)).toBe(false);
    expect(t.push(2, 1)).toBe(true);
    expect(t.push(1, 1)).toBe(true);
    expect(t.size).toBe(3);
  });

  it("clears", () => {
    const t = new TrailBuffer(3);
    t.push(1, 1);
    t.push(2, 2);
    t.clear();
    expect(t.size).toBe(0);
    expect(t.toArray()).toEqual([]);
    t.push(3, 3);
    expect(t.toArray()).toEqual([[3, 3]]);
  });

  it("keeps the last 2,000 of 5,000 positions", () => {
    const t = new TrailBuffer();
    for (let i = 0; i < 5000; i++) t.push(i * 0.001, 30);
    const pts = t.toArray();
    expect(pts).toHaveLength(2000);
    expect(pts[0]?.[0]).toBeCloseTo(3000 * 0.001, 9);
    expect(pts[1999]?.[0]).toBeCloseTo(4999 * 0.001, 9);
  });

  it("rejects an invalid capacity", () => {
    expect(() => new TrailBuffer(0)).toThrow(RangeError);
  });
});
