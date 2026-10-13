// Origin/destination coordinates for the map, from real data only: the plan domain's
// next-waypoint coordinates when that waypoint is the destination, otherwise the
// bundled airport list. Unknown idents produce no endpoint (and therefore no route).

import type { ClientSimState } from "@/lib/sim-state";

import { findAirport, type AirportIndex } from "./airports";
import { isValidLatLon, type LatLon } from "./geo";

export interface RouteEnd extends LatLon {
  ident: string;
}

export interface RouteEnds {
  origin: RouteEnd | null;
  destination: RouteEnd | null;
}

export function routeEnds(state: ClientSimState, airports: AirportIndex | null): RouteEnds {
  const plan = state.sim.plan;
  const flight = state.sim.flight;
  const originIdent = plan?.origin ?? flight?.origin ?? null;
  const destIdent = plan?.destination ?? flight?.destination ?? null;

  let origin: RouteEnd | null = null;
  const o = findAirport(airports, originIdent);
  if (o && originIdent) origin = { ident: originIdent, lat: o.lat, lon: o.lon };

  let destination: RouteEnd | null = null;
  if (destIdent) {
    const wp = { lat: plan?.nextWpLat, lon: plan?.nextWpLon };
    if (plan?.nextWpId === destIdent && isValidLatLon(wp)) {
      destination = { ident: destIdent, lat: wp.lat, lon: wp.lon };
    } else {
      const d = findAirport(airports, destIdent);
      if (d) destination = { ident: destIdent, lat: d.lat, lon: d.lon };
    }
  }
  return { origin, destination };
}
