import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Welcome } from "@cargo-ops/protocol";

import { initialSimState, simReducer, type ClientSimState } from "@/lib/sim-state";

import { lastFlightStartSeq, useTrail } from "./useTrail";

const welcome = (session: string): Welcome => ({
  type: "welcome",
  v: 1,
  session,
  mode: "demo",
  sim: { connected: false },
});

function start(session = "a"): ClientSimState {
  let s = simReducer(initialSimState, { type: "welcome", msg: welcome(session) });
  s = simReducer(s, {
    type: "snapshot",
    msg: { type: "snapshot", v: 1, seq: 0, source: "demo", state: {} },
    at: 0,
  });
  return s;
}

function move(s: ClientSimState, seq: number, lat: number, lon: number): ClientSimState {
  return simReducer(s, {
    type: "delta",
    msg: {
      type: "delta",
      v: 1,
      seq,
      source: "demo",
      patch: { position: { lat, lon, altFt: 1000, aglFt: 500 } },
    },
    at: seq,
  });
}

describe("useTrail", () => {
  it("accumulates positions and resets on a new session and on flight.started", () => {
    let s = move(start(), 1, 35, -90);
    const { result, rerender } = renderHook(({ state }) => useTrail(state), {
      initialProps: { state: s },
    });
    expect(result.current).toEqual([[-90, 35]]);

    s = move(s, 2, 35.1, -89.9);
    rerender({ state: s });
    expect(result.current).toHaveLength(2);

    s = simReducer(s, {
      type: "event",
      msg: { type: "event", v: 1, seq: 3, source: "demo", name: "flight.started", data: {} },
      at: 3,
    });
    expect(lastFlightStartSeq(s)).toBe(3);
    rerender({ state: s });
    expect(result.current).toEqual([[-89.9, 35.1]]);

    s = move(s, 4, 35.2, -89.8);
    rerender({ state: s });
    expect(result.current).toHaveLength(2);

    const next = move(start("b"), 1, 10, 10);
    rerender({ state: next });
    expect(result.current).toEqual([[10, 10]]);
  });

  it("collects nothing before a session", () => {
    const { result } = renderHook(() => useTrail(initialSimState));
    expect(result.current).toEqual([]);
  });
});
