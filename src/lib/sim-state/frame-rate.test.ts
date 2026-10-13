import { describe, expect, it } from "vitest";

import { addFrameSample, framesPerSecond, type FrameSample } from "./frame-rate";

describe("frame rate", () => {
  it("returns null before any frame", () => {
    expect(framesPerSecond([], 1000)).toBeNull();
  });

  it("averages frames over the 5 s window", () => {
    let samples: FrameSample[] = [];
    let prev = -1;
    for (let seq = 0; seq < 10; seq++) {
      samples = addFrameSample(samples, prev, seq, seq * 500);
      prev = seq;
    }
    // 10 frames in 4.5 s, measured over a 5 s window.
    expect(framesPerSecond(samples, 4500)).toBe(2);
  });

  it("counts seq steps for frames applied in one batch", () => {
    let samples = addFrameSample([], -1, 0, 0);
    samples = addFrameSample(samples, 0, 2, 1000);
    expect(samples.map((s) => s.frames)).toEqual([1, 2]);
    expect(framesPerSecond(samples, 1000)).toBeCloseTo(0.6);
  });

  it("treats a seq reset as a single frame", () => {
    const samples = addFrameSample([{ at: 0, frames: 1 }], 300, 0, 100);
    expect(samples.at(-1)?.frames).toBe(1);
  });

  it("drops samples that fall out of the window", () => {
    let samples = addFrameSample([], -1, 0, 0);
    samples = addFrameSample(samples, 0, 1, 6000);
    expect(samples).toHaveLength(1);
    expect(framesPerSecond(samples, 12_000)).toBe(0);
  });
});
