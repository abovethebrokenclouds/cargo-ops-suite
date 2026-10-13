import { useEffect, useRef, useState } from "react";

import type { ClientSimState } from "@/lib/sim-state";

import type { LonLat } from "./geo";
import { TRAIL_CAPACITY, TrailBuffer } from "./trail";

/** Seq of the most recent `flight.started` event, or null. */
export function lastFlightStartSeq(state: ClientSimState): number | null {
  for (let i = state.events.length - 1; i >= 0; i--) {
    const ev = state.events[i];
    if (ev?.msg.name === "flight.started") return ev.msg.seq;
  }
  return null;
}

/**
 * Breadcrumb trail accumulated client-side from position frames. Resets on a new
 * session (new `welcome`) and on `flight.started`. Returns points oldest first.
 */
export function useTrail(state: ClientSimState, capacity = TRAIL_CAPACITY): LonLat[] {
  const buffer = useRef<TrailBuffer | null>(null);
  const welcomeRef = useRef(state.welcome);
  const startSeq = useRef<number | null>(null);
  const [points, setPoints] = useState<LonLat[]>([]);
  const lat = state.sim.position?.lat;
  const lon = state.sim.position?.lon;
  const flightStart = lastFlightStartSeq(state);

  useEffect(() => {
    buffer.current ??= new TrailBuffer(capacity);
    const trail = buffer.current;
    let changed = false;
    if (welcomeRef.current !== state.welcome) {
      welcomeRef.current = state.welcome;
      startSeq.current = flightStart;
      trail.clear();
      changed = true;
    }
    if (flightStart !== null && flightStart !== startSeq.current) {
      startSeq.current = flightStart;
      trail.clear();
      changed = true;
    }
    if (state.welcome && typeof lat === "number" && typeof lon === "number") {
      if (trail.push(lon, lat)) changed = true;
    }
    if (changed) setPoints(trail.toArray());
  }, [state.welcome, lat, lon, flightStart, capacity]);

  return points;
}
