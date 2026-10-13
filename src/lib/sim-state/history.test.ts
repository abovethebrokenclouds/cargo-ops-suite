import { describe, expect, it } from "vitest";
import type { Snapshot } from "@cargo-ops/protocol";

import { initialSimState, simReducer } from "./reducer";
import { HISTORY_WINDOW_MS, RingBuffer, pointFromState, windowed } from "./history";

describe("RingBuffer", () => {
  it("keeps the newest items up to capacity, oldest first", () => {
    const ring = new RingBuffer<number>(3);
    expect(ring.toArray()).toEqual([]);
    expect(ring.last()).toBeUndefined();
    ring.push(1);
    ring.push(2);
    expect(ring.toArray()).toEqual([1, 2]);
    ring.push(3);
    ring.push(4);
    ring.push(5);
    expect(ring.toArray()).toEqual([3, 4, 5]);
    expect(ring.size).toBe(3);
    expect(ring.last()).toBe(5);
    ring.clear();
    expect(ring.toArray()).toEqual([]);
    ring.push(6);
    expect(ring.toArray()).toEqual([6]);
  });

  it("rejects a bad capacity", () => {
    expect(() => new RingBuffer(0)).toThrow();
  });
});

describe("windowed", () => {
  it("keeps the last ten minutes relative to the newest point", () => {
    const pts = [0, 60_000, 300_000, HISTORY_WINDOW_MS + 60_000].map((t) => ({
      t,
      altFt: 0,
      vsFpm: 0,
      gsKt: 0,
    }));
    expect(windowed(pts).map((p) => p.t)).toEqual([60_000, 300_000, HISTORY_WINDOW_MS + 60_000]);
    expect(windowed([])).toEqual([]);
  });
});

describe("pointFromState", () => {
  it("takes values only from received frames", () => {
    expect(pointFromState(initialSimState)).toBeNull();
    let s = simReducer(initialSimState, {
      type: "welcome",
      msg: { type: "welcome", v: 1, session: "s", mode: "replay", sim: { connected: false } },
    });
    const state: Snapshot["state"] = {
      position: { lat: 35, lon: -90, altFt: 5500, aglFt: 5200 },
      motion: {
        iasKt: 140,
        tasKt: 150,
        gsKt: 160,
        hdgMagDeg: 90,
        hdgTrueDeg: 91,
        vsFpm: 700,
        gForce: 1,
        onGround: false,
      },
    };
    s = simReducer(s, {
      type: "snapshot",
      msg: { type: "snapshot", v: 1, seq: 0, source: "replay", state },
      at: 1234,
    });
    expect(pointFromState(s)).toEqual({ t: 1234, altFt: 5500, vsFpm: 700, gsKt: 160 });
  });
});
