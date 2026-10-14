// The Ops dashboard's front-wall display: the shared OpsMap (composed, not modified) with
// the route, trail and aircraft. No overlay panel or controls: the numbers live on the
// readouts beside it, and /map is the full map.
//
// Camera: the wall frames the whole route (origin and destination) rather than following
// the aircraft. OpsMap frames the route once per map instance, and only while it has no
// aircraft, so this wrapper (1) remounts the map when the route changes and (2) holds the
// aircraft back until that map is ready and has framed the route. Follow mode stays off
// while there is a route; without one (unknown airports) the map follows the aircraft.

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
import { cn } from "@/lib/utils";

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

/** Key of the framed route, or null when there is no route to frame. */
function routeFrameKey(origin: RouteEnd | null, destination: RouteEnd | null) {
  return origin && destination ? `${origin.ident}-${destination.ident}` : null;
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
  const [followChoice, setFollow] = useState<boolean | null>(null);
  const [framedKey, setFramedKey] = useState<string | null>(null);
  const wrapper = useRef<HTMLDivElement | null>(null);
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
  const routeKey = routeFrameKey(origin, destination);
  const framed = routeKey === null || framedKey === routeKey;
  const follow = followChoice ?? routeKey === null;

  // Release the aircraft once the (re)mounted map reports ready. The timeout lets OpsMap's
  // camera effect for that commit run first, so it frames the route while it still has no
  // aircraft.
  useEffect(() => {
    const el = wrapper.current;
    if (routeKey === null || framedKey === routeKey || !el) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const check = () => {
      if (timer !== null) return;
      const map = el.querySelector('[data-testid="ops-map"]');
      if (map?.getAttribute("data-ready") !== "true") return;
      timer = setTimeout(() => setFramedKey(routeKey), 0);
    };
    const observer = new MutationObserver(check);
    observer.observe(el, { attributes: true, subtree: true, attributeFilter: ["data-ready"] });
    check();
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [routeKey, framedKey]);

  const aircraft =
    position && framed
      ? { lat: position.lat, lon: position.lon, hdgTrueDeg: motion?.hdgTrueDeg ?? null }
      : null;

  return (
    <div
      ref={wrapper}
      className={cn("h-full w-full", className)}
      data-testid="front-wall-map-frame"
      data-route-framed={routeKey === null ? "no-route" : framed ? "true" : "false"}
    >
      <OpsMap
        key={routeKey ?? "no-route"}
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
      />
    </div>
  );
}
