// The Ops dashboard's front-wall display: the shared OpsMap (composed, not modified) with
// the route, trail and aircraft, following the aircraft. No overlay panel or controls: the
// numbers live on the readouts beside it, and /map is the full map.

import { useEffect, useMemo, useRef, useState } from "react";

import { OpsMap } from "@/components/map/OpsMap";
import { isSessionUp, isStale } from "@/lib/flight/flight-view";
import { loadAirports, type AirportIndex } from "@/lib/map/airports";
import { greatCirclePoints } from "@/lib/map/geo";
import { routeEnds, type RouteEnd } from "@/lib/map/route";
import type { OverlayGroup } from "@/lib/map/style";
import { useTrail } from "@/lib/map/useTrail";
import { useOnlineMapsSetting } from "@/lib/settings/map-settings";
import type { ClientSimState } from "@/lib/sim-state";
import type { TransportKind } from "@/lib/transport/useSimConnection";

const LAYERS: Record<OverlayGroup, boolean> = { airports: false, trail: true, route: true };

function sameEnd(a: RouteEnd | null, b: RouteEnd | null): boolean {
  if (!a || !b) return a === b;
  return a.ident === b.ident && a.lat === b.lat && a.lon === b.lon;
}

function useStableEnd(value: RouteEnd | null): RouteEnd | null {
  const ref = useRef(value);
  if (!sameEnd(ref.current, value)) ref.current = value;
  return ref.current;
}

export function OpsMapCompact({
  state,
  transportKind,
  now,
  className,
}: {
  state: ClientSimState;
  transportKind: TransportKind | null;
  now: number | null;
  className?: string;
}) {
  const [onlineAllowed] = useOnlineMapsSetting();
  const [airports, setAirports] = useState<AirportIndex | null>(null);
  const [follow, setFollow] = useState(true);
  const trail = useTrail(state);

  useEffect(() => {
    let cancelled = false;
    loadAirports()
      .then((index) => {
        if (!cancelled) setAirports(index);
      })
      .catch(() => {
        // Without the airport list there is no route line; the aircraft still shows.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sessionUp = isSessionUp(state);
  const position = sessionUp ? (state.sim.position ?? null) : null;
  const motion = sessionUp ? (state.sim.motion ?? null) : null;
  const ends = useMemo(() => routeEnds(state, airports), [state, airports]);
  const origin = useStableEnd(ends.origin);
  const destination = useStableEnd(ends.destination);
  const routeLine = useMemo(
    () => (origin && destination ? greatCirclePoints(origin, destination) : null),
    [origin, destination],
  );
  const aircraft = position
    ? { lat: position.lat, lon: position.lon, hdgTrueDeg: motion?.hdgTrueDeg ?? null }
    : null;

  return (
    <OpsMap
      servedByConnector={transportKind === null ? null : transportKind === "live"}
      onlineAllowed={onlineAllowed}
      aircraft={aircraft}
      stale={isStale(state, now)}
      route={routeLine}
      origin={origin}
      destination={destination}
      trail={trail}
      airports={airports}
      layers={LAYERS}
      follow={follow}
      onFollowChange={setFollow}
      {...(className ? { className } : {})}
    />
  );
}
