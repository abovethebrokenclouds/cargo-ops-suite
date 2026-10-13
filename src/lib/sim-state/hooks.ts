import { useEffect, useRef, useState } from "react";

import { addFrameSample, framesPerSecond, type FrameSample } from "./frame-rate";
import type { ClientSimState } from "./reducer";

/**
 * Client clock that ticks every `intervalMs`. Null during SSR and the first render so
 * server and client markup match; time-based UI (stale marks, frame age) starts after
 * mount.
 */
export function useNow(intervalMs = 1000): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(Date.now());
    const id = globalThis.setInterval(() => setNow(Date.now()), intervalMs);
    return () => globalThis.clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** Measured frames per second over the last 5 s, or null before any frame. */
export function useFrameRate(state: ClientSimState, now: number | null): number | null {
  const samples = useRef<FrameSample[]>([]);
  const prevSeq = useRef(-1);
  const [snapshot, setSnapshot] = useState<FrameSample[]>([]);
  const { lastSeq, lastFrameAt } = state;

  useEffect(() => {
    if (lastSeq < 0 || lastFrameAt === null) return;
    samples.current = addFrameSample(samples.current, prevSeq.current, lastSeq, lastFrameAt);
    prevSeq.current = lastSeq;
    setSnapshot(samples.current);
  }, [lastSeq, lastFrameAt]);

  if (now === null) return null;
  return framesPerSecond(snapshot, now);
}
