// What the connector's GET /api/weather/metar returns and the browser renders.

import type { MetarDecoded } from "./metar";

/** "live" = fetched from aviationweather.gov; "sample" = built-in example, never real weather. */
export type MetarOrigin = "live" | "sample";

export interface MetarReport extends MetarDecoded {
  origin: MetarOrigin;
  rawText: string;
  decodedBy: "api" | "parser";
  /** When the connector fetched (live) or built (sample) the report, ISO 8601. */
  fetchedAt: string;
  /** Live report served from cache after a failed refresh. */
  stale: boolean;
}

export interface MetarStationResult {
  station: string;
  report: MetarReport | null;
  /** Why there is no report (or why it is stale). */
  note: string | null;
}

/**
 * Weather mode of the connector:
 *  - online: live METARs from aviationweather.gov (when the page allows online weather)
 *  - sample: built-in sample METARs (replays and the in-browser demo), labelled SAMPLE
 *  - off:    no weather at all
 */
export type WeatherMode = "online" | "sample" | "off";
export const WEATHER_MODES: readonly WeatherMode[] = ["online", "sample", "off"];

export interface MetarResponse {
  mode: WeatherMode;
  /** The page's "online weather" switch as the connector received it. */
  onlineAllowed: boolean;
  stations: MetarStationResult[];
  /** Data source credit, shown under live reports. */
  attribution: string;
  endpoint: string;
}

/** ICAO-style station id accepted by the API route (3–4 letters/digits, first a letter). */
export const STATION_RE = /^[A-Z][A-Z0-9]{2,3}$/;
export const MAX_STATIONS = 8;

/** Normalise a list of ids: upper-case, valid, unique, at most MAX_STATIONS. */
export function normalizeStations(ids: readonly (string | null | undefined)[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const s = (id ?? "").trim().toUpperCase();
    if (STATION_RE.test(s) && !out.includes(s)) out.push(s);
    if (out.length >= MAX_STATIONS) break;
  }
  return out;
}
