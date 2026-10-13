import { act, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MetricTile } from "@/components/dashboard/MetricTile";
import { formatUsd } from "@/lib/format";

import { counterValue, easeOutCubic, useAnimatedNumber } from "./use-animated-number";

type Mql = { matches: boolean; addEventListener: () => void; removeEventListener: () => void };
const original = window.matchMedia;

function setReducedMotion(reduce: boolean) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string): Mql & { media: string } => ({
      matches: reduce && query.includes("reduce"),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  });
}

/** Manual requestAnimationFrame so frames are stepped deterministically. */
function manualFrames() {
  let queue: Array<{ id: number; cb: FrameRequestCallback }> = [];
  let next = 1;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    queue.push({ id: next, cb });
    return next++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => {
    queue = queue.filter((f) => f.id !== id);
  });
  return {
    step(now: number) {
      const run = queue;
      queue = [];
      act(() => run.forEach((f) => f.cb(now)));
    },
    get pending() {
      return queue.length;
    },
  };
}

afterEach(() => {
  Object.defineProperty(window, "matchMedia", { writable: true, value: original });
  vi.unstubAllGlobals();
});

describe("counter maths", () => {
  it("eases out and lands exactly on the target", () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(0.5)).toBeCloseTo(0.875);
    expect(counterValue(100, 200, 0, 600)).toBe(100);
    expect(counterValue(100, 200, 300, 600)).toBeCloseTo(187.5);
    expect(counterValue(100, 200, 600, 600)).toBe(200);
    expect(counterValue(100, 200, 9_999, 600)).toBe(200);
    expect(counterValue(100, 200, 10, 0)).toBe(200);
  });
});

describe("useAnimatedNumber", () => {
  beforeEach(() => setReducedMotion(false));

  it("shows the first value immediately (no count-up from zero)", () => {
    manualFrames();
    const { result } = renderHook(() => useAnimatedNumber(4_200));
    expect(result.current).toBe(4_200);
  });

  it("eases between values when motion is allowed", () => {
    const frames = manualFrames();
    const { result, rerender } = renderHook(({ v }) => useAnimatedNumber(v, true, 600), {
      initialProps: { v: 100 as number | null },
    });
    rerender({ v: 200 });
    frames.step(1_000); // first frame: start
    expect(result.current).toBe(100);
    frames.step(1_300); // halfway in time
    expect(result.current).toBeCloseTo(187.5);
    frames.step(1_600);
    expect(result.current).toBe(200);
    expect(frames.pending).toBe(0);
  });

  it("jumps straight to the value with prefers-reduced-motion", () => {
    setReducedMotion(true);
    const frames = manualFrames();
    const { result, rerender } = renderHook(({ v }) => useAnimatedNumber(v), {
      initialProps: { v: 100 },
    });
    rerender({ v: 250 });
    expect(result.current).toBe(250);
    expect(frames.pending).toBe(0);
  });

  it("never animates from or to null", () => {
    const frames = manualFrames();
    const { result, rerender } = renderHook(({ v }) => useAnimatedNumber(v), {
      initialProps: { v: null as number | null },
    });
    rerender({ v: 300 });
    expect(result.current).toBe(300);
    rerender({ v: null });
    expect(result.current).toBeNull();
    expect(frames.pending).toBe(0);
  });

  it("is off unless enabled (telemetry tiles)", () => {
    const frames = manualFrames();
    const { result, rerender } = renderHook(({ v }) => useAnimatedNumber(v, false), {
      initialProps: { v: 1 },
    });
    rerender({ v: 2 });
    expect(result.current).toBe(2);
    expect(frames.pending).toBe(0);
  });
});

describe("MetricTile counters", () => {
  it("animate + reduced motion renders the final value at once", () => {
    setReducedMotion(true);
    manualFrames();
    const { rerender } = render(
      <MetricTile label="Cash" value={1_000} format={formatUsd} size="xl" animate />,
    );
    rerender(<MetricTile label="Cash" value={8_124} format={formatUsd} size="xl" animate />);
    expect(screen.getByTestId("metric-value")).toHaveTextContent("$8,124");
    expect(screen.getByTestId("metric-value")).toHaveAttribute("data-value", "8124");
  });

  it("animate with motion shows an intermediate value, then the target", () => {
    setReducedMotion(false);
    const frames = manualFrames();
    const { rerender } = render(
      <MetricTile label="Cash" value={1_000} format={formatUsd} size="xl" animate />,
    );
    rerender(<MetricTile label="Cash" value={2_000} format={formatUsd} size="xl" animate />);
    frames.step(0);
    frames.step(325);
    const mid = screen.getByTestId("metric-value").textContent ?? "";
    expect(mid).not.toBe("$1,000");
    expect(mid).not.toBe("$2,000");
    frames.step(2_000);
    expect(screen.getByTestId("metric-value")).toHaveTextContent("$2,000");
  });

  it("telemetry tiles (no animate) always show the reported value", () => {
    setReducedMotion(false);
    const frames = manualFrames();
    const { rerender } = render(<MetricTile label="Altitude" value={3_000} size="xl" />);
    rerender(<MetricTile label="Altitude" value={3_500} size="xl" />);
    expect(screen.getByTestId("metric-value")).toHaveTextContent("3,500");
    expect(frames.pending).toBe(0);
  });
});
