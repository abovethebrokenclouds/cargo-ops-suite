// State store: keeps the latest SimState per domain and turns source updates into
// protocol frames. One monotonic `seq` stream per connector session is shared by
// deltas, events and broadcast snapshots. A snapshot for one client (on connect or
// resync) carries the current seq without advancing it, so the next broadcast
// frame is exactly seq + 1 for every client.

import {
  PROTOCOL_VERSION,
  SIM_DOMAINS,
  simDomainSchemas,
  type EventName,
  type Frame,
  type SimDomain,
  type SimState,
  type SimStatePatch,
  type Snapshot,
  type Source,
} from "../protocol";

export type FrameListener = (frame: Frame) => void;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) if (v !== undefined) out[k] = v;
  return out;
}

export interface StoreStats {
  seq: number;
  frames: number;
  rejectedPatches: number;
}

export class StateStore {
  private seq = 0;
  private state: Record<string, unknown> = {};
  private readonly listeners = new Set<FrameListener>();
  private frames = 0;
  private rejectedPatches = 0;

  constructor(
    readonly source: Source,
    private readonly onReject: (domain: string, reason: string) => void = () => {},
  ) {}

  subscribe(listener: FrameListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  get currentSeq(): number {
    return this.seq;
  }

  stats(): StoreStats {
    return { seq: this.seq, frames: this.frames, rejectedPatches: this.rejectedPatches };
  }

  /** Current state as a snapshot at the current seq (does not advance seq). */
  snapshot(): Snapshot {
    return {
      type: "snapshot",
      v: PROTOCOL_VERSION,
      seq: this.seq,
      source: this.source,
      state: structuredClone(this.state) as SimState,
    };
  }

  getDomain(domain: SimDomain): unknown {
    return this.state[domain];
  }

  /** Replace the whole state and broadcast a snapshot with a new seq. */
  reset(state: SimState): void {
    const next: Record<string, unknown> = {};
    for (const domain of SIM_DOMAINS) {
      const value = (state as Record<string, unknown>)[domain];
      if (value === undefined) continue;
      if (value !== null && !simDomainSchemas[domain].safeParse(value).success) {
        this.reject(domain, "invalid domain in snapshot");
        continue;
      }
      next[domain] = structuredClone(value);
    }
    this.state = next;
    this.seq++;
    this.emit(this.snapshot());
  }

  /**
   * Merge a patch and broadcast a delta that holds only what changed: changed
   * fields for an existing domain, the full domain object for a new one, `null`
   * for a cleared one. Returns the delta, or null when nothing changed.
   */
  apply(patch: SimStatePatch): Frame | null {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined || !(key in simDomainSchemas)) continue;
      const domain = key as SimDomain;
      const prev = this.state[domain];
      if (value === null) {
        if (prev !== undefined && prev !== null) {
          this.state[domain] = null;
          out[domain] = null;
        }
        continue;
      }
      if (isPlainObject(prev) && isPlainObject(value)) {
        const merged = { ...prev, ...stripUndefined(value) };
        if (!simDomainSchemas[domain].safeParse(merged).success) {
          this.reject(domain, "patch makes the domain invalid");
          continue;
        }
        const changed: Record<string, unknown> = {};
        for (const [field, fieldValue] of Object.entries(merged)) {
          if (!sameValue(prev[field], fieldValue)) changed[field] = fieldValue;
        }
        if (Object.keys(changed).length === 0) continue;
        this.state[domain] = merged;
        out[domain] = structuredClone(changed);
        continue;
      }
      // No base to merge into: only a complete, valid domain object is accepted.
      if (!simDomainSchemas[domain].safeParse(value).success) {
        this.reject(domain, "partial patch for a domain with no data");
        continue;
      }
      if (sameValue(prev, value)) continue;
      this.state[domain] = structuredClone(value);
      out[domain] = structuredClone(value);
    }
    if (Object.keys(out).length === 0) return null;
    this.seq++;
    const delta: Frame = {
      type: "delta",
      v: PROTOCOL_VERSION,
      seq: this.seq,
      source: this.source,
      patch: out as SimStatePatch,
    };
    this.emit(delta);
    return delta;
  }

  /** Broadcast an event on the shared seq stream. */
  event(name: EventName, data: unknown): Frame {
    this.seq++;
    const frame: Frame = {
      type: "event",
      v: PROTOCOL_VERSION,
      seq: this.seq,
      source: this.source,
      name,
      data: data ?? null,
    };
    this.emit(frame);
    return frame;
  }

  private reject(domain: string, reason: string): void {
    this.rejectedPatches++;
    this.onReject(domain, reason);
  }

  private emit(frame: Frame): void {
    this.frames++;
    for (const listener of [...this.listeners]) listener(frame);
  }
}
