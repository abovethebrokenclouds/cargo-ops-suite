import type { EventName, Mode, SimState, SimStatePatch, Source } from "../protocol";

/** What the sim layer tells the core. Never synthesised: every update has a real origin. */
export type SimUpdate =
  | {
      type: "connected";
      /** e.g. "MSFS 2024". */
      simName: string;
      /** SimConnect protocol name actually negotiated, e.g. "SunRise". */
      protocol: string;
      /** Application version reported by the simulator's open response. */
      version?: string;
    }
  | { type: "disconnected"; reason: string }
  /**
   * Replace the whole state (a replay snapshot). `at` is the source's receive clock
   * in ms (a fixture's recorded `t`); absent means "now" (the session's clock).
   */
  | { type: "reset"; state: SimState; at?: number }
  /** Shallow per-domain patch; full domain objects or partial fields. */
  | { type: "data"; patch: SimStatePatch; at?: number }
  | { type: "event"; name: EventName; data: unknown };

export type SimListener = (update: SimUpdate) => void;

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogFn = (level: LogLevel, message: string) => void;

export interface SimLinkInfo {
  connected: boolean;
  name?: string;
  version?: string;
  protocol?: string;
}

export interface SimSource {
  /** `live` only for SimConnectSource, `replay` for FakeSource. */
  readonly mode: Mode;
  /** Label stamped on every frame produced from this source. */
  readonly frameSource: Source;
  /** Current simulator link; `connected` is true only after a real SimConnect open. */
  link(): SimLinkInfo;
  subscribe(listener: SimListener): () => void;
  start(): void;
  stop(): Promise<void>;
}

/** Tiny listener set shared by sources. */
export class SimEmitter {
  private readonly listeners = new Set<SimListener>();

  subscribe(listener: SimListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(update: SimUpdate): void {
    for (const listener of [...this.listeners]) listener(update);
  }
}
