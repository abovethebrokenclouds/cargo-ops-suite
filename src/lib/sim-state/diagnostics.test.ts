import { describe, expect, it } from "vitest";

import { buildDiagnostics, compactJson } from "./diagnostics";
import { initialSimState, simReducer } from "./reducer";

describe("buildDiagnostics", () => {
  it("captures connection, events and raw state", () => {
    let s = simReducer(initialSimState, {
      type: "welcome",
      msg: { type: "welcome", v: 1, session: "demo-1", mode: "demo", sim: { connected: false } },
    });
    s = simReducer(s, {
      type: "snapshot",
      msg: {
        type: "snapshot",
        v: 1,
        seq: 0,
        source: "demo",
        state: { phase: { current: "Climb" } },
      },
      at: 1000,
    });
    s = simReducer(s, {
      type: "event",
      msg: {
        type: "event",
        v: 1,
        seq: 1,
        source: "demo",
        name: "phase.changed",
        data: { to: "Climb" },
      },
      at: 1500,
    });
    const out = buildDiagnostics({
      state: s,
      transportKind: "demo",
      now: 3500,
      framesPerSec: 1.234,
    });
    expect(out.client).toEqual({ protocolVersion: 1, transport: "demo" });
    expect(out.connection).toMatchObject({
      state: "demo",
      source: "demo",
      lastSeq: 1,
      needsResync: false,
      frameAgeMs: 2000,
      framesPerSec: 1.2,
    });
    expect(out.connection.welcome?.session).toBe("demo-1");
    expect(out.events).toEqual([
      {
        at: new Date(1500).toISOString(),
        seq: 1,
        source: "demo",
        name: "phase.changed",
        data: { to: "Climb" },
      },
    ]);
    expect(out.state).toEqual({ phase: { current: "Climb" } });
    expect(() => JSON.stringify(out)).not.toThrow();
  });

  it("reports nulls before any session", () => {
    const out = buildDiagnostics({
      state: initialSimState,
      transportKind: null,
      now: 0,
      framesPerSec: null,
    });
    expect(out.connection).toMatchObject({ welcome: null, frameAgeMs: null, framesPerSec: null });
  });
});

describe("compactJson", () => {
  it("stringifies on one line and truncates", () => {
    expect(compactJson({ a: 1 })).toBe('{"a":1}');
    expect(compactJson("x".repeat(200), 10)).toHaveLength(10);
    expect(compactJson(undefined)).toBe("undefined");
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    expect(compactJson(cyclic)).toBe("[unserialisable]");
  });
});
