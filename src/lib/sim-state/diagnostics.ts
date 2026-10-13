import { PROTOCOL_VERSION } from "@cargo-ops/protocol";

import type { ClientSimState } from "./reducer";
import { frameAgeMs } from "./selectors";

export interface DiagnosticsInput {
  state: ClientSimState;
  transportKind: string | null;
  now: number;
  framesPerSec: number | null;
  /** How many recent events to include. */
  eventCount?: number;
}

/** JSON-safe snapshot of the connection for the "copy diagnostics" button. */
export function buildDiagnostics({
  state,
  transportKind,
  now,
  framesPerSec,
  eventCount = 50,
}: DiagnosticsInput) {
  return {
    generatedAt: new Date(now).toISOString(),
    client: { protocolVersion: PROTOCOL_VERSION, transport: transportKind },
    connection: {
      state: state.connection,
      error: state.error ?? null,
      welcome: state.welcome,
      source: state.source,
      lastSeq: state.lastSeq,
      needsResync: state.needsResync,
      frameAgeMs: frameAgeMs(state, now),
      framesPerSec: framesPerSec === null ? null : Math.round(framesPerSec * 10) / 10,
    },
    events: state.events.slice(-eventCount).map((e) => ({
      at: new Date(e.at).toISOString(),
      seq: e.msg.seq,
      source: e.msg.source,
      name: e.msg.name,
      data: e.msg.data,
    })),
    state: state.sim,
  };
}

/** Single-line JSON for the event log, truncated to `max` characters. */
export function compactJson(value: unknown, max = 120): string {
  let text: string;
  try {
    text = JSON.stringify(value) ?? "undefined";
  } catch {
    text = "[unserialisable]";
  }
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
