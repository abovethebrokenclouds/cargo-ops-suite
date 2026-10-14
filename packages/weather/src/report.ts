// What the connector's GET /api/weather/metar and /api/weather/taf return and the browser
// renders.

import type { MetarDecoded } from "./metar";
import type { TafDecoded } from "./taf";

/** "live" = fetched from aviationweather.gov; "sample" = built-in example, never real weather. */
export type MetarOrigin = "live" | "sample";
export type WeatherOrigin = MetarOrigin;

export interface MetarReport extends MetarDecoded {
  origin: MetarOrigin;
  rawText: string;
  decodedBy: "api" | "parser";
  /** When the connector fetched (live) or built (sample) the report, ISO 8601. */
  fetchedAt: string;
  /** Live report served from cache after a failed refresh. */
  stale: boolean;
}

export interface TafReport extends TafDecoded {
  origin: WeatherOrigin;
  rawText: string;
  /** Periods always come from our parser on the raw text (see awc.ts). */
  decodedBy: "parser";
  fetchedAt: string;
  stale: boolean;
}

export interface StationResult<R> {
  station: string;
  report: R | null;
  /** Why there is no report (or why it is stale). */
  note: string | null;
}

export type MetarStationResult = StationResult<MetarReport>;
export type TafStationResult = StationResult<TafReport>;

/**
 * Weather mode of the connector:
 *  - online: live METARs/TAFs from aviationweather.gov (when the page allows online weather)
 *  - sample: built-in sample reports (replays and the in-browser demo), labelled SAMPLE
 *  - off:    no weather at all
 */
export type WeatherMode = "online" | "sample" | "off";
export const WEATHER_MODES: readonly WeatherMode[] = ["online", "sample", "off"];

export interface WeatherResponse<R> {
  mode: WeatherMode;
  /** The page's "online weather" switch as the connector received it. */
  onlineAllowed: boolean;
  stations: StationResult<R>[];
  /** Data source credit, shown under live reports. */
  attribution: string;
  endpoint: string;
}

export type MetarResponse = WeatherResponse<MetarReport>;
export type TafResponse = WeatherResponse<TafReport>;

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
