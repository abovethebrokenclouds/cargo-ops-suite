// Airport records the economy works with: a subset of the OurAirports fields
// (public domain) as bundled in src/assets/data/airports-major.json.

import {
  surfaceClass,
  type AircraftType,
  type SurfaceClass,
} from "../../protocol/src/aircraft-types";
import { greatCircleNm } from "./geo";

export interface EconomyAirport {
  ident: string;
  name: string;
  type: "large" | "medium" | "small";
  lat: number;
  lon: number;
  country?: string;
  /** IATA code (P5 part 2: stands in for scheduled service in the FBO size score). */
  iata?: string;
  /** Field elevation, ft. */
  elevFt?: number;
  longestRwyFt?: number;
  surface?: string;
}

export interface AirportLookup {
  list: readonly EconomyAirport[];
  get(ident: string | null | undefined): EconomyAirport | null;
}

/** Index airports by upper-case ident, sorted by ident so iteration order is stable. */
export function airportLookup(list: readonly EconomyAirport[]): AirportLookup {
  const sorted = [...list].sort((a, b) => (a.ident < b.ident ? -1 : a.ident > b.ident ? 1 : 0));
  const map = new Map<string, EconomyAirport>();
  for (const a of sorted) map.set(a.ident.toUpperCase(), a);
  return {
    list: sorted,
    get: (ident) => (ident ? (map.get(ident.trim().toUpperCase()) ?? null) : null),
  };
}

/** Nearest airport within `radiusNm`, or null. */
export function nearestAirport(
  list: readonly EconomyAirport[],
  at: { lat: number; lon: number },
  radiusNm: number,
): { airport: EconomyAirport; distanceNm: number } | null {
  let best: { airport: EconomyAirport; distanceNm: number } | null = null;
  const dLat = radiusNm / 60 + 0.01;
  for (const airport of list) {
    if (Math.abs(airport.lat - at.lat) > dLat) continue;
    const distanceNm = greatCircleNm(at, airport);
    if (distanceNm <= radiusNm && (!best || distanceNm < best.distanceNm)) {
      best = { airport, distanceNm };
    }
  }
  return best;
}

export type SuitabilityIssue = "runway_unknown" | "runway_short" | "surface";

export interface Suitability {
  ok: boolean;
  issues: SuitabilityIssue[];
  surface: SurfaceClass;
}

/** Can `aircraft` use this airport's longest runway? (length + surface; unknown = unsuitable). */
export function runwaySuitability(airport: EconomyAirport, aircraft: AircraftType): Suitability {
  const issues: SuitabilityIssue[] = [];
  const surface = surfaceClass(airport.surface);
  if (airport.longestRwyFt === undefined) issues.push("runway_unknown");
  else if (airport.longestRwyFt < aircraft.minRunwayFt) issues.push("runway_short");
  if (!aircraft.surfaces.includes(surface)) issues.push("surface");
  return { ok: issues.length === 0, issues, surface };
}

/** A strip that suits bush work: unpaved, or paved but shorter than 4,000 ft. */
export function isBushStrip(airport: EconomyAirport): boolean {
  const surface = surfaceClass(airport.surface);
  if (surface === "gravel" || surface === "turf" || surface === "dirt") return true;
  return airport.longestRwyFt !== undefined && airport.longestRwyFt < 4_000;
}
