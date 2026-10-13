import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_BACKOFF,
  WATCHDOG_MS,
  Watchdog,
  backoffDelay,
  initialReconnectState,
  reconnectStep,
  type ReconnectEvent,
  type ReconnectState,
} from "./reconnect";

const mid = () => 0.5;

describe("backoffDelay", () => {
  it("doubles from 0.5 s and caps at 30 s", () => {
    const delays = Array.from({ length: 10 }, (_, i) => backoffDelay(i, mid));
    expect(delays).toEqual([500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000]);
  });

  it("applies ±20 % jitter from the injected random source", () => {
    expect(backoffDelay(2, () => 0)).toBe(1600);
    expect(backoffDelay(2, () => 0.999999)).toBe(2400);
    // Never above the cap even with positive jitter.
    expect(backoffDelay(20, () => 0.999999)).toBe(DEFAULT_BACKOFF.maxMs);
  });

  it("treats negative attempts as the first", () => {
    expect(backoffDelay(-3, mid)).toBe(500);
  });
});

describe("reconnectStep", () => {
  const run = (events: ReconnectEvent[], from: ReconnectState = initialReconnectState) =>
    events.reduce((s, e) => reconnectStep(s, e, mid), from);

  it("goes connecting → open → established", () => {
    expect(run([{ type: "start" }])).toEqual({ phase: "connecting", attempt: 0, delayMs: null });
    expect(run([{ type: "start" }, { type: "opened" }]).phase).toBe("open");
    expect(run([{ type: "start" }, { type: "opened" }, { type: "established" }]).phase).toBe(
      "established",
    );
  });

  it("backs off exponentially across failed attempts", () => {
    let s = run([{ type: "start" }]);
    const delays: Array<number | null> = [];
    for (let i = 0; i < 4; i++) {
      s = reconnectStep(s, { type: "closed" }, mid);
      expect(s.phase).toBe("waiting");
      delays.push(s.delayMs);
      s = reconnectStep(s, { type: "retry" }, mid);
      expect(s.phase).toBe("connecting");
    }
    expect(delays).toEqual([500, 1000, 2000, 4000]);
    expect(s.attempt).toBe(4);
  });

  it("does not reset on socket open alone, only once a session is established", () => {
    let s = run([{ type: "start" }, { type: "closed" }, { type: "retry" }, { type: "closed" }]);
    expect(s.attempt).toBe(2);
    s = run([{ type: "retry" }, { type: "opened" }], s);
    expect(s.attempt).toBe(2);
    s = run([{ type: "established" }], s);
    expect(s).toEqual({ phase: "established", attempt: 0, delayMs: null });
    s = run([{ type: "closed" }], s);
    expect(s.delayMs).toBe(500);
  });

  it("ignores events that do not apply to the current phase", () => {
    expect(run([{ type: "closed" }])).toBe(initialReconnectState);
    expect(run([{ type: "retry" }])).toBe(initialReconnectState);
    expect(run([{ type: "established" }])).toBe(initialReconnectState);
    const waiting = run([{ type: "start" }, { type: "closed" }]);
    expect(reconnectStep(waiting, { type: "closed" }, mid)).toBe(waiting);
  });

  it("stop is terminal until start", () => {
    const stopped = run([{ type: "start" }, { type: "stop" }]);
    expect(stopped.phase).toBe("stopped");
    expect(run([{ type: "closed" }, { type: "retry" }], stopped).phase).toBe("stopped");
    expect(run([{ type: "start" }], stopped).phase).toBe("connecting");
  });
});

describe("Watchdog", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires after 30 s without a kick", () => {
    const onTimeout = vi.fn();
    const dog = new Watchdog(onTimeout);
    dog.kick();
    vi.advanceTimersByTime(WATCHDOG_MS - 1);
    expect(onTimeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(onTimeout).toHaveBeenCalledTimes(1);
    expect(dog.running).toBe(false);
  });

  it("kicks postpone and stop cancels", () => {
    const onTimeout = vi.fn();
    const dog = new Watchdog(onTimeout, 1000);
    dog.kick();
    vi.advanceTimersByTime(900);
    dog.kick();
    vi.advanceTimersByTime(900);
    expect(onTimeout).not.toHaveBeenCalled();
    dog.stop();
    vi.advanceTimersByTime(5000);
    expect(onTimeout).not.toHaveBeenCalled();
  });
});
