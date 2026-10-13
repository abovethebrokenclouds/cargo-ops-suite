// Client-side telemetry history for the TelemetryStrip: a fixed-capacity ring
// buffer of points taken from received frames (never interpolated or invented).

import { useEffect, useRef, useState } from "react";

import type { ClientSimState } from "./reducer";

/** One received frame's values; `t` is the client receive clock, ms. */
export interface TelemetryPoint {
  t: number;
  altFt: number;
  vsFpm: number;
  gsKt: number;
}

/** Window the strip shows. */
export const HISTORY_WINDOW_MS = 10 * 60_000;
/** 10 minutes at the connector's fastest rate (10 Hz). */
export const HISTORY_CAPACITY = 6_000;

/** Fixed-capacity FIFO: pushing beyond capacity drops the oldest item. */
export class RingBuffer<T> {
  private readonly items: Array<T | undefined>;
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be ≥ 1");
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  push(item: T): void {
    const index = (this.start + this.count) % this.capacity;
    this.items[index] = item;
    if (this.count < this.capacity) this.count++;
    else this.start = (this.start + 1) % this.capacity;
  }

  /** Items oldest first. */
  toArray(): T[] {
    const out: T[] = [];
    for (let i = 0; i < this.count; i++) {
      const item = this.items[(this.start + i) % this.capacity];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  last(): T | undefined {
    return this.count === 0 ? undefined : this.items[(this.start + this.count - 1) % this.capacity];
  }

  clear(): void {
    this.items.fill(undefined);
    this.start = 0;
    this.count = 0;
  }
}

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** A point from the current state, or null without position and motion data. */
export function pointFromState(state: ClientSimState): TelemetryPoint | null {
  const { position, motion } = state.sim;
  if (!position || !motion || state.lastFrameAt === null) return null;
  if (!finite(position.altFt) || !finite(motion.vsFpm) || !finite(motion.gsKt)) return null;
  return { t: state.lastFrameAt, altFt: position.altFt, vsFpm: motion.vsFpm, gsKt: motion.gsKt };
}

/** Points no older than `windowMs` before the newest one, oldest first. */
export function windowed(
  points: readonly TelemetryPoint[],
  windowMs = HISTORY_WINDOW_MS,
): TelemetryPoint[] {
  const newest = points.at(-1);
  if (!newest) return [];
  return points.filter((p) => newest.t - p.t <= windowMs);
}

/**
 * Accumulates a point per applied frame that carries position/motion data. The
 * history is per session: a new `welcome` clears it.
 */
export function useTelemetryHistory(state: ClientSimState): TelemetryPoint[] {
  const buffer = useRef<RingBuffer<TelemetryPoint> | null>(null);
  const [points, setPoints] = useState<TelemetryPoint[]>([]);
  const { welcome } = state;
  const { position, motion } = state.sim;

  useEffect(() => {
    buffer.current?.clear();
    setPoints([]);
  }, [welcome]);

  useEffect(() => {
    // A new position or motion object means a frame changed them (events do not).
    const point = pointFromState(state);
    if (!point) return;
    buffer.current ??= new RingBuffer<TelemetryPoint>(HISTORY_CAPACITY);
    const last = buffer.current.last();
    if (last && last.t === point.t) return;
    buffer.current.push(point);
    setPoints(windowed(buffer.current.toArray()));
    // `state` is read when position/motion change; other fields must not add points.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [position, motion]);

  return points;
}
