import type { ClientMessage, ServerMessage } from "@cargo-ops/protocol";
import type { TransportStatus } from "@/lib/sim-state/reducer";

export type { TransportStatus };

export type TransportEvent =
  | { type: "status"; status: TransportStatus; error?: string }
  | { type: "message"; msg: ServerMessage };

export type TransportListener = (event: TransportEvent) => void;

export interface Transport {
  connect(): void;
  disconnect(): void;
  send(msg: ClientMessage): void;
  subscribe(listener: TransportListener): () => void;
}

/** Injectable clock so tests can drive transports with fake timers. */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

/** Resolves the globals at call time (not import time) so fake timers and SSR both work. */
export const defaultTimers: Timers = {
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

/** Small listener set shared by transport implementations. */
export class Emitter {
  private listeners = new Set<TransportListener>();

  subscribe(listener: TransportListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(event: TransportEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }
}
