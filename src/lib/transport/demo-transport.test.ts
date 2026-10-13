import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureFrame, ServerMessage } from "@cargo-ops/protocol";
import { initialSimState, simReducer, actionFromMessage } from "@/lib/sim-state/reducer";
import { statusLabel } from "@/lib/sim-state/selectors";
import { DemoTransport } from "./demo-transport";
import type { TransportEvent } from "./types";

const frames: FixtureFrame[] = [
  {
    t: 0,
    msg: {
      type: "snapshot",
      v: 1,
      seq: 10,
      source: "sim",
      state: {
        sim: { connected: true, paused: false, simRate: 1 },
        controls: { parkingBrake: true },
      },
    },
  },
  {
    t: 1000,
    msg: {
      type: "delta",
      v: 1,
      seq: 11,
      source: "replay",
      patch: { controls: { parkingBrake: false } },
    },
  },
  {
    t: 1000,
    msg: { type: "event", v: 1, seq: 12, source: "sim", name: "flight.started", data: {} },
  },
  { t: 1500, msg: { type: "ping", v: 1, t: 0 } },
  {
    t: 3000,
    msg: { type: "delta", v: 1, seq: 13, source: "sim", patch: { sim: { paused: true } } },
  },
];

function collect(transport: DemoTransport) {
  const events: TransportEvent[] = [];
  transport.subscribe((e) => events.push(e));
  const messages = () =>
    events.flatMap((e) => (e.type === "message" ? [e.msg] : [])) as ServerMessage[];
  const statuses = () => events.flatMap((e) => (e.type === "status" ? [e.status] : []));
  return { events, messages, statuses };
}

describe("DemoTransport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces demo mode with no sim connection, then replays with fixture timing", () => {
    const t = new DemoTransport({ frames, loop: false });
    const { messages, statuses } = collect(t);
    t.connect();
    expect(statuses()).toEqual(["connecting"]);
    expect(messages()).toEqual([]);

    vi.advanceTimersByTime(0);
    expect(statuses()).toEqual(["connecting", "open"]);
    expect(messages()[0]).toMatchObject({
      type: "welcome",
      mode: "demo",
      sim: { connected: false },
    });
    expect(messages().map((m) => m.type)).toEqual(["welcome", "snapshot"]);

    vi.advanceTimersByTime(999);
    expect(messages()).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(messages().map((m) => m.type)).toEqual(["welcome", "snapshot", "delta", "event"]);

    vi.advanceTimersByTime(2000);
    // The ping is not a frame and is not replayed.
    expect(messages().map((m) => m.type)).toEqual([
      "welcome",
      "snapshot",
      "delta",
      "event",
      "delta",
    ]);
  });

  it("forces source demo, re-sequences from 0 and never reports the sim as connected", () => {
    const t = new DemoTransport({ frames, loop: false });
    const { messages } = collect(t);
    t.connect();
    vi.advanceTimersByTime(5000);
    const out = messages().filter((m) => m.type !== "welcome");
    expect(out.map((m) => ("source" in m ? m.source : null))).toEqual([
      "demo",
      "demo",
      "demo",
      "demo",
    ]);
    expect(out.map((m) => ("seq" in m ? m.seq : null))).toEqual([0, 1, 2, 3]);
    const snap = out[0];
    expect(snap?.type === "snapshot" && snap.state.sim?.connected).toBe(false);
    const last = out[3];
    expect(last?.type === "delta" && last.patch.sim).toEqual({ paused: true, connected: false });
  });

  it("loops with monotonic seq so the reducer never sees a gap", () => {
    const t = new DemoTransport({ frames, loopGapMs: 2000 });
    const { messages } = collect(t);
    t.connect();
    vi.advanceTimersByTime(3000 + 2000 + 3000);
    const seqs = messages().flatMap((m) => ("seq" in m ? [m.seq] : []));
    expect(seqs).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);

    let state = initialSimState;
    for (const msg of messages()) {
      const action = actionFromMessage(msg, 0);
      if (action) state = simReducer(state, action);
    }
    expect(state.connection).toBe("demo");
    expect(statusLabel(state)).toBe("DEMO DATA");
    expect(state.needsResync).toBe(false);
    expect(state.source).toBe("demo");
    expect(state.lastSeq).toBe(7);
  });

  it("stops on disconnect and can reconnect with a fresh session", () => {
    const t = new DemoTransport({ frames, loop: false });
    const { messages, statuses } = collect(t);
    t.connect();
    vi.advanceTimersByTime(0);
    t.disconnect();
    expect(statuses().at(-1)).toBe("disconnected");
    const count = messages().length;
    vi.advanceTimersByTime(10_000);
    expect(messages()).toHaveLength(count);

    t.connect();
    vi.advanceTimersByTime(0);
    const welcomes = messages().filter((m) => m.type === "welcome");
    expect(welcomes.map((w) => w.type === "welcome" && w.session)).toEqual(["demo-1", "demo-2"]);
    const snap = messages().at(-1);
    expect(snap?.type === "snapshot" && snap.seq).toBe(0);
  });

  it("answers commands with a demo-mode error and ignores other client messages", () => {
    const t = new DemoTransport({ frames: [], loop: false });
    const { messages } = collect(t);
    t.connect();
    vi.advanceTimersByTime(0);
    t.send({ type: "command", v: 1, id: "c1", name: "job.accept", args: {} });
    t.send({ type: "resync", v: 1, lastSeq: 0 });
    vi.advanceTimersByTime(0);
    expect(messages().at(-1)).toMatchObject({
      type: "result",
      id: "c1",
      ok: false,
      error: { code: "demo_mode" },
    });
    expect(messages()).toHaveLength(2);
  });

  it("loads frames lazily and reports a loader failure as an error", () => {
    const loader = vi.fn(() => {
      throw new Error("bad fixture");
    });
    const t = new DemoTransport({ frames: loader });
    expect(loader).not.toHaveBeenCalled();
    const { events } = collect(t);
    t.connect();
    vi.advanceTimersByTime(0);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(events.at(-1)).toEqual({ type: "status", status: "error", error: "bad fixture" });
  });

  it("unsubscribe stops delivery", () => {
    const t = new DemoTransport({ frames, loop: false });
    const listener = vi.fn();
    const off = t.subscribe(listener);
    off();
    t.connect();
    vi.advanceTimersByTime(5000);
    expect(listener).not.toHaveBeenCalled();
  });
});
