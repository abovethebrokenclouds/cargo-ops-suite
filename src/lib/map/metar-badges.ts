// METAR flight-category badges for the ops map: which airports get one (flight/mission origin
// and destination, then accepted jobs' airports), and the GeoJSON the badge layer draws.
// Only stations with a report get a badge; the reports come from the one batched METAR
// request the map already makes (useMetar), never from extra requests.

import type { FeatureCollection, Point } from "geojson";
import {
  MAX_STATIONS,
  normalizeStations,
  type FlightCategory,
  type MetarResponse,
  type WeatherOrigin,
} from "@cargo-ops/weather";

import { findAirport, type AirportIndex } from "./airports";

export type WeatherRole = "Origin" | "Destination" | "Accepted job";

export interface WeatherStation {
  ident: string;
  roles: WeatherRole[];
}

export interface MetarBadge {
  station: string;
  lat: number;
  lon: number;
  roles: WeatherRole[];
  category: FlightCategory | null;
  origin: WeatherOrigin;
  stale: boolean;
  rawText: string;
  observedAt: string | null;
}

/**
 * Stations to show, in priority order (route ends first), each with every role it has.
 * At most MAX_STATIONS, the connector's batch limit.
 */
export function mapWeatherStations(input: {
  origin?: string | null | undefined;
  destination?: string | null | undefined;
  missionOrigin?: string | null | undefined;
  missionDestination?: string | null | undefined;
  acceptedJobs?: ReadonlyArray<{ origin: string; destination: string }> | null | undefined;
}): WeatherStation[] {
  const out: WeatherStation[] = [];
  const add = (id: string | null | undefined, role: WeatherRole) => {
    const ident = normalizeStations([id])[0];
    if (!ident) return;
    const existing = out.find((s) => s.ident === ident);
    if (existing) {
      if (!existing.roles.includes(role)) existing.roles.push(role);
      return;
    }
    if (out.length < MAX_STATIONS) out.push({ ident, roles: [role] });
  };
  add(input.origin, "Origin");
  add(input.destination, "Destination");
  add(input.missionOrigin, "Origin");
  add(input.missionDestination, "Destination");
  for (const job of input.acceptedJobs ?? []) {
    add(job.origin, "Accepted job");
    add(job.destination, "Accepted job");
  }
  return out;
}

/** Badges for the stations that have a report and a known position. */
export function metarBadges(
  stations: readonly WeatherStation[],
  response: MetarResponse | null,
  airports: AirportIndex | null,
): MetarBadge[] {
  if (!response) return [];
  const out: MetarBadge[] = [];
  for (const s of stations) {
    const report = response.stations.find((r) => r.station === s.ident)?.report ?? null;
    const airport = findAirport(airports, s.ident);
    if (!report || !airport) continue;
    out.push({
      station: s.ident,
      lat: airport.lat,
      lon: airport.lon,
      roles: s.roles,
      category: report.category,
      origin: report.origin,
      stale: report.stale,
      rawText: report.rawText,
      observedAt: report.observedAt,
    });
  }
  return out;
}

export function metarBadgesGeoJson(badges: readonly MetarBadge[]): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: badges.map((b) => ({
      type: "Feature",
      properties: {
        station: b.station,
        category: b.category ?? "unknown",
        origin: b.origin,
        stale: b.stale,
      },
      geometry: { type: "Point", coordinates: [b.lon, b.lat] },
    })),
  };
}
