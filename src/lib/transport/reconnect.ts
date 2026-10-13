import { defaultTimers, type Timers } from "./types";

// Reconnect policy (plan §3.2): exponential backoff 0.5 s → 30 s with jitter,
// reset once a session is established; client watchdog 30 s.

export interface BackoffOptions {
  initialMs: number;
  maxMs: number;
  factor: number;
  /** Fraction of the delay randomised either way, 0–1. */
  jitter: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = {
  initialMs: 500,
  maxMs: 30_000,
  factor: 2,
  jitter: 0.2,
};

export const WATCHDOG_MS = 30_000;

/** Delay before reconnect attempt `attempt` (0-based). `random` returns [0, 1). */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  options: BackoffOptions = DEFAULT_BACKOFF,
): number {
  const base = Math.min(options.maxMs, options.initialMs * options.factor ** Math.max(0, attempt));
  const spread = base * options.jitter * (2 * random() - 1);
  return Math.round(Math.min(options.maxMs, Math.max(0, base + spread)));
}

export type ReconnectPhase = "idle" | "connecting" | "open" | "established" | "waiting" | "stopped";

export interface ReconnectState {
  phase: ReconnectPhase;
  /** Consecutive failed attempts since the last established session. */
  attempt: number;
  /** Delay to wait before the next attempt while `waiting`. */
  delayMs: number | null;
}

export type ReconnectEvent =
  | { type: "start" }
  | { type: "opened" }
  /** A session is confirmed (welcome received); resets the backoff. */
  | { type: "established" }
  | { type: "closed" }
  /** The wait timer fired. */
  | { type: "retry" }
  | { type: "stop" };

export const initialReconnectState: ReconnectState = { phase: "idle", attempt: 0, delayMs: null };

/** Pure reconnect FSM. The caller performs the side effects the new phase implies. */
export function reconnectStep(
  state: ReconnectState,
  event: ReconnectEvent,
  random: () => number = Math.random,
  options: BackoffOptions = DEFAULT_BACKOFF,
): ReconnectState {
  switch (event.type) {
    case "start":
      return { phase: "connecting", attempt: 0, delayMs: null };
    case "stop":
      return { phase: "stopped", attempt: 0, delayMs: null };
    case "opened":
      return state.phase === "connecting" ? { ...state, phase: "open" } : state;
    case "established":
      return state.phase === "open" || state.phase === "established"
        ? { phase: "established", attempt: 0, delayMs: null }
        : state;
    case "closed":
      if (state.phase === "stopped" || state.phase === "idle" || state.phase === "waiting") {
        return state;
      }
      return {
        phase: "waiting",
        attempt: state.attempt + 1,
        delayMs: backoffDelay(state.attempt, random, options),
      };
    case "retry":
      return state.phase === "waiting" ? { ...state, phase: "connecting", delayMs: null } : state;
  }
}

/** Fires `onTimeout` if `kick()` is not called within `timeoutMs`. */
export class Watchdog {
  private handle: unknown = null;

  constructor(
    private readonly onTimeout: () => void,
    private readonly timeoutMs: number = WATCHDOG_MS,
    private readonly timers: Timers = defaultTimers,
  ) {}

  kick(): void {
    this.stop();
    this.handle = this.timers.setTimeout(() => {
      this.handle = null;
      this.onTimeout();
    }, this.timeoutMs);
  }

  stop(): void {
    if (this.handle !== null) this.timers.clearTimeout(this.handle);
    this.handle = null;
  }

  get running(): boolean {
    return this.handle !== null;
  }
}
