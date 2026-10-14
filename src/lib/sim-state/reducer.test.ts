import { describe, expect, it } from "vitest";
import type { Delta, SimEvent, Snapshot, Welcome } from "@cargo-ops/protocol";
import {
  MAX_EVENTS,
  actionFromMessage,
  initialSimState,
  simReducer,
  type ClientSimState,
  type SimAction,
} from "./reducer";

const liveWelcome: Welcome = {
  type: "welcome",
  v: 1,
  session: "s1",
  mode: "live",
  sim: { connected: true, name: "MSFS 2024", protocol: "SunRise" },
};

function snapshot(seq: number, state: Snapshot["state"] = {}): Snapshot {
  return { type: "snapshot", v: 1, seq, source: "sim", state };
}
function delta(seq: number, patch: Delta["patch"]): Delta {
  return { type: "delta", v: 1, seq, source: "sim", patch };
}
function event(seq: number, name: SimEvent["name"] = "phase.changed"): SimEvent {
  return { type: "event", v: 1, seq, source: "sim", name, data: { seq } };
}

const position = { lat: 35, lon: -90, altFt: 341, aglFt: 0 };
const motion = {
  iasKt: 0,
  tasKt: 0,
  gsKt: 0,
  hdgMagDeg: 180,
  hdgTrueDeg: 178,
  vsFpm: 0,
  gForce: 1,
  onGround: true,
};

function run(actions: SimAction[], from: ClientSimState = initialSimState): ClientSimState {
  return actions.reduce(simReducer, from);
}

function welcomed(msg: Welcome = liveWelcome): ClientSimState {
  return run([
    { type: "status", status: "connecting" },
    { type: "status", status: "open" },
    { type: "welcome", msg },
  ]);
}

describe("simReducer connection", () => {
  it("starts idle with no data", () => {
    expect(initialSimState).toMatchObject({
      connection: "idle",
      welcome: null,
      source: null,
      lastSeq: -1,
      sim: {},
      events: [],
      lastFrameAt: null,
      needsResync: false,
    });
  });

  it("stays connecting when the socket opens, until a welcome arrives", () => {
    const s = run([
      { type: "status", status: "connecting" },
      { type: "status", status: "open" },
    ]);
    expect(s.connection).toBe("connecting");
    expect(s.welcome).toBeNull();
  });

  it.each([
    ["live", "live"],
    ["demo", "demo"],
    ["replay", "replay"],
  ] as const)("welcome mode %s sets connection %s", (mode, connection) => {
    const s = welcomed({ ...liveWelcome, mode });
    expect(s.connection).toBe(connection);
    expect(s.welcome?.mode).toBe(mode);
  });

  it("ignores frames received before a welcome", () => {
    const s = run([
      { type: "status", status: "connecting" },
      { type: "snapshot", msg: snapshot(0, { position }), at: 1 },
      { type: "delta", msg: delta(1, { position: { lat: 36 } }), at: 2 },
      { type: "event", msg: event(2), at: 3 },
    ]);
    expect(s.sim).toEqual({});
    expect(s.events).toEqual([]);
    expect(s.lastSeq).toBe(-1);
    expect(s.source).toBeNull();
    expect(s.lastFrameAt).toBeNull();
  });

  it("drops the session on disconnect and ignores frames until the next welcome", () => {
    let s = run(
      [
        { type: "snapshot", msg: snapshot(0, { position }), at: 1 },
        { type: "status", status: "disconnected" },
      ],
      welcomed(),
    );
    expect(s.connection).toBe("disconnected");
    expect(s.welcome).toBeNull();
    s = simReducer(s, { type: "delta", msg: delta(1, { position: { lat: 40 } }), at: 2 });
    expect(s.sim.position?.lat).toBe(35);
  });

  it("records transport errors and clears them on the next welcome", () => {
    let s = simReducer(welcomed(), { type: "status", status: "error", error: "refused" });
    expect(s).toMatchObject({ connection: "error", error: "refused", welcome: null });
    s = simReducer(s, { type: "status", status: "error" });
    expect(s.error).toBe("transport error");
    s = run([{ type: "welcome", msg: liveWelcome }], s);
    expect(s.error).toBeUndefined();
    expect(s.connection).toBe("live");
  });

  it("starts a new session empty on welcome", () => {
    const s = run(
      [
        { type: "snapshot", msg: snapshot(5, { position }), at: 1 },
        { type: "welcome", msg: { ...liveWelcome, session: "s2" } },
      ],
      welcomed(),
    );
    expect(s.sim).toEqual({});
    expect(s.lastSeq).toBe(-1);
    expect(s.source).toBeNull();
  });

  it("reset returns the initial state", () => {
    expect(simReducer(welcomed(), { type: "reset" })).toBe(initialSimState);
  });
});

describe("simReducer frames", () => {
  it("snapshot replaces state and records source, seq and time", () => {
    const s = run(
      [
        { type: "snapshot", msg: snapshot(0, { position, motion }), at: 100 },
        { type: "snapshot", msg: snapshot(10, { position: { ...position, lat: 33 } }), at: 200 },
      ],
      welcomed(),
    );
    expect(s.sim).toEqual({ position: { ...position, lat: 33 } });
    expect(s.sim.motion).toBeUndefined();
    expect(s).toMatchObject({ source: "sim", lastSeq: 10, lastFrameAt: 200 });
  });

  it("delta shallow-merges per domain", () => {
    const s = run(
      [
        { type: "snapshot", msg: snapshot(0, { position, motion }), at: 1 },
        { type: "delta", msg: delta(1, { position: { lat: 35.5 }, motion: { gsKt: 12 } }), at: 2 },
      ],
      welcomed(),
    );
    expect(s.sim.position).toEqual({ ...position, lat: 35.5 });
    expect(s.sim.motion).toEqual({ ...motion, gsKt: 12 });
    expect(s.needsResync).toBe(false);
    expect(s.lastSeq).toBe(1);
  });

  it("delta replaces arrays inside a domain and null clears a domain", () => {
    const s = run(
      [
        {
          type: "snapshot",
          msg: snapshot(0, {
            fuel: { totalGal: 250, totalLb: 1675, flowPph: [100, 100] },
            plan: { active: true, destination: "KATL" },
          }),
          at: 1,
        },
        { type: "delta", msg: delta(1, { fuel: { flowPph: [300] }, plan: null }), at: 2 },
      ],
      welcomed(),
    );
    expect(s.sim.fuel).toEqual({ totalGal: 250, totalLb: 1675, flowPph: [300] });
    expect(s.sim.plan).toBeNull();
  });

  it("delta can add a complete domain that was absent", () => {
    const s = run(
      [
        { type: "snapshot", msg: snapshot(0, {}), at: 1 },
        { type: "delta", msg: delta(1, { controls: { parkingBrake: true } }), at: 2 },
      ],
      welcomed(),
    );
    expect(s.sim.controls).toEqual({ parkingBrake: true });
    expect(s.needsResync).toBe(false);
  });

  it("skips a partial delta for an absent domain and requests a resync", () => {
    const s = run(
      [
        { type: "snapshot", msg: snapshot(0, {}), at: 1 },
        {
          type: "delta",
          msg: delta(1, { position: { lat: 1 }, controls: { parkingBrake: false } }),
          at: 2,
        },
      ],
      welcomed(),
    );
    expect(s.sim.position).toBeUndefined();
    expect(s.sim.controls).toEqual({ parkingBrake: false });
    expect(s.needsResync).toBe(true);
  });

  it("flags a seq gap, keeps applying, and a snapshot clears the flag", () => {
    let s = run(
      [
        { type: "snapshot", msg: snapshot(0, { position }), at: 1 },
        { type: "delta", msg: delta(3, { position: { lat: 36 } }), at: 2 },
      ],
      welcomed(),
    );
    expect(s.needsResync).toBe(true);
    expect(s.sim.position?.lat).toBe(36);
    expect(s.lastSeq).toBe(3);
    // Still flagged after a contiguous delta.
    s = simReducer(s, { type: "delta", msg: delta(4, { position: { lat: 37 } }), at: 3 });
    expect(s.needsResync).toBe(true);
    s = simReducer(s, { type: "snapshot", msg: snapshot(20, { position }), at: 4 });
    expect(s.needsResync).toBe(false);
    expect(s.lastSeq).toBe(20);
  });

  it("flags a delta that arrives before any snapshot", () => {
    const s = simReducer(welcomed(), { type: "delta", msg: delta(0, { motion }), at: 1 });
    expect(s.needsResync).toBe(true);
    expect(s.sim.motion).toEqual(motion);
  });

  it("ignores stale and duplicate deltas and events", () => {
    const base = run(
      [
        { type: "snapshot", msg: snapshot(0, { position }), at: 1 },
        { type: "delta", msg: delta(1, { position: { lat: 36 } }), at: 2 },
      ],
      welcomed(),
    );
    expect(
      simReducer(base, { type: "delta", msg: delta(1, { position: { lat: 0 } }), at: 3 }),
    ).toBe(base);
    expect(simReducer(base, { type: "event", msg: event(0), at: 3 })).toBe(base);
  });

  it("events share the seq stream", () => {
    const s = run(
      [
        { type: "snapshot", msg: snapshot(0, { position }), at: 1 },
        { type: "event", msg: event(1, "flight.started"), at: 2 },
        { type: "delta", msg: delta(2, { position: { lat: 36 } }), at: 3 },
      ],
      welcomed(),
    );
    expect(s.needsResync).toBe(false);
    expect(s.events.map((e) => e.msg.name)).toEqual(["flight.started"]);
    expect(s.events[0]?.at).toBe(2);
    const gapped = simReducer(s, { type: "event", msg: event(9), at: 4 });
    expect(gapped.needsResync).toBe(true);
  });

  it("keeps at most MAX_EVENTS events, newest last", () => {
    let s = simReducer(welcomed(), { type: "snapshot", msg: snapshot(0), at: 0 });
    for (let i = 1; i <= MAX_EVENTS + 25; i++) {
      s = simReducer(s, { type: "event", msg: event(i), at: i });
    }
    expect(s.events).toHaveLength(MAX_EVENTS);
    expect(s.events[0]?.msg.seq).toBe(26);
    expect(s.events.at(-1)?.msg.seq).toBe(MAX_EVENTS + 25);
  });

  it("does not mutate the previous state", () => {
    const before = run([{ type: "snapshot", msg: snapshot(0, { position }), at: 1 }], welcomed());
    const frozen = JSON.parse(JSON.stringify(before));
    simReducer(before, { type: "delta", msg: delta(1, { position: { lat: 1 } }), at: 2 });
    expect(before).toEqual(frozen);
  });
});

describe("simReducer with the simulator offline", () => {
  const offline: Welcome = { ...liveWelcome, sim: { connected: false } };
  const stale: Snapshot["state"] = {
    sim: { connected: true, paused: false, simRate: 1 },
    position,
    motion,
    controls: { parkingBrake: true },
    phase: { current: "Cruise" },
    flight: { active: true, elapsedSec: 600 },
    company: {
      name: "Co",
      base: "KMEM",
      cash: 1000,
      reputation: 50,
      reputationTier: 2,
    } as NonNullable<Snapshot["state"]["company"]>,
  };

  it("never holds sim-derived domains while a live welcome says the sim is offline", () => {
    const s = run([{ type: "snapshot", msg: snapshot(5, stale), at: 1 }], welcomed(offline));
    for (const d of ["sim", "position", "motion", "controls", "phase", "flight"] as const) {
      expect(s.sim[d], d).toBeUndefined();
    }
    // Connector-owned state is not simulator telemetry and stays.
    expect(s.sim.company?.name).toBe("Co");
    const d = run([{ type: "delta", msg: delta(6, { phase: { current: "Descent" } }), at: 2 }], s);
    expect(d.sim.phase).toBeUndefined();
    expect(d.lastSeq).toBe(6);
  });

  it("keeps them when the simulator is connected, and in demo/replay sessions", () => {
    const live = run([{ type: "snapshot", msg: snapshot(1, stale), at: 1 }], welcomed());
    expect(live.sim.phase?.current).toBe("Cruise");
    const replay = run(
      [{ type: "snapshot", msg: { ...snapshot(1, stale), source: "replay" }, at: 1 }],
      welcomed({ ...offline, mode: "replay" }),
    );
    expect(replay.sim.phase?.current).toBe("Cruise");
  });
});

describe("actionFromMessage", () => {
  it("maps state messages and ignores the rest", () => {
    expect(actionFromMessage(liveWelcome, 5)).toEqual({ type: "welcome", msg: liveWelcome });
    expect(actionFromMessage(snapshot(0), 5)).toMatchObject({ type: "snapshot", at: 5 });
    expect(actionFromMessage(delta(1, {}), 5)).toMatchObject({ type: "delta", at: 5 });
    expect(actionFromMessage(event(2), 5)).toMatchObject({ type: "event", at: 5 });
    expect(actionFromMessage({ type: "ping", v: 1, t: 0 }, 5)).toBeNull();
    expect(
      actionFromMessage({ type: "result", v: 1, id: "a", ok: true, data: null }, 5),
    ).toBeNull();
  });
});
