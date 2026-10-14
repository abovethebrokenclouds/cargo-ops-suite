// aviationweather.gov Data API (NOAA Aviation Weather Center): METAR JSON → MetarDecoded.
//
//   GET https://aviationweather.gov/api/data/metar?ids=KMEM,KATL&format=json
//
// US Government work (public domain), no key. Documented limits: 100 requests per minute,
// a custom User-Agent, at most one request per minute per thread. HTTP 204 = no data.
// The JSON carries decoded fields (wdir, wspd, wgst, visib, clouds, temp, dewp, altim,
// fltCat); they are preferred, and our parser fills anything missing from `rawOb`.
// Every field is treated as optional: the schema is not versioned.

import {
  CLOUD_COVERS,
  ceilingOf,
  flightCategory,
  isFlightCategory,
  parseFraction,
  parseMetar,
  type CloudCover,
  type CloudLayer,
  type MetarDecoded,
  type Wind,
} from "./metar";
import { parseTaf, type TafDecoded } from "./taf";

export const AWC_METAR_URL = "https://aviationweather.gov/api/data/metar";
export const AWC_DOCS_URL = "https://aviationweather.gov/data/api/";
export const AWC_ATTRIBUTION = "METAR: NOAA Aviation Weather Center (aviationweather.gov)";

/** Request URL for up to a handful of ICAO stations. */
export function awcMetarUrl(stations: readonly string[]): string {
  return `${AWC_METAR_URL}?ids=${stations.map(encodeURIComponent).join(",")}&format=json`;
}

export interface AwcDecoded extends MetarDecoded {
  /** Which decoder produced most fields: the API's JSON, or our parser on `rawOb`. */
  decodedBy: "api" | "parser";
  rawText: string;
}

type Obj = Record<string, unknown>;

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v)
    ? v
    : typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))
      ? Number(v)
      : null;

function apiVisibility(v: unknown): { sm: number; plus: boolean } | null {
  if (typeof v === "number" && Number.isFinite(v)) return { sm: v, plus: false };
  if (typeof v !== "string") return null;
  const plus = v.trim().endsWith("+");
  const value = parseFraction(v.replace("+", "").replace(/^[PM]/, ""));
  return value === null ? null : { sm: value, plus: plus || v.startsWith("P") };
}

function apiClouds(v: unknown): CloudLayer[] | null {
  if (!Array.isArray(v)) return null;
  const layers: CloudLayer[] = [];
  for (const c of v) {
    if (!c || typeof c !== "object") continue;
    const cover = (c as Obj)["cover"];
    if (typeof cover !== "string") continue;
    if (!(CLOUD_COVERS as readonly string[]).includes(cover)) continue; // CLR, SKC, CAVOK …
    layers.push({ cover: cover as CloudCover, baseFt: num((c as Obj)["base"]) });
  }
  return layers;
}

function apiObservedAt(o: Obj): string | null {
  const t = num(o["obsTime"]);
  if (t !== null) return new Date(t * 1000).toISOString();
  const r = o["reportTime"];
  if (typeof r === "string") {
    const d = new Date(r.includes("T") || r.endsWith("Z") ? r : `${r.replace(" ", "T")}Z`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** Map one element of the API's JSON array; null when it has no station or raw text. */
export function fromAwcMetar(value: unknown, ref: Date = new Date()): AwcDecoded | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Obj;
  const rawText = typeof o["rawOb"] === "string" ? o["rawOb"].trim() : "";
  const id = typeof o["icaoId"] === "string" ? o["icaoId"].trim().toUpperCase() : "";
  const parsed = rawText ? parseMetar(rawText, ref) : null;
  const station = id || parsed?.station || "";
  if (!station || !rawText) return null;

  let apiFields = 0;
  let fallbacks = 0;
  const pick = <T>(api: T | null, fallback: T | null): T | null => {
    if (api !== null) {
      apiFields++;
      return api;
    }
    if (fallback !== null) fallbacks++;
    return fallback;
  };

  const speed = num(o["wspd"]);
  const dirRaw = o["wdir"];
  const apiWind: Wind | null =
    speed !== null
      ? {
          directionDeg: dirRaw === "VRB" ? null : num(dirRaw),
          speedKt: speed,
          gustKt: num(o["wgst"]),
          varyingFromDeg: parsed?.wind?.varyingFromDeg ?? null,
          varyingToDeg: parsed?.wind?.varyingToDeg ?? null,
        }
      : null;
  const vis = apiVisibility(o["visib"]);
  const apiSky = apiClouds(o["clouds"]);
  const altim = num(o["altim"]);
  // altim is hPa in the current API; treat a value under 100 as inches of mercury.
  const apiAltHpa =
    altim === null ? null : altim < 100 ? Math.round(altim * 33.8639 * 10) / 10 : altim;
  const wxString = typeof o["wxString"] === "string" && o["wxString"] ? o["wxString"] : null;

  const clouds = pick(apiSky, parsed?.clouds ?? null);
  const visibilitySm = pick(vis?.sm ?? null, parsed?.visibilitySm ?? null);
  const visibilityPlus = vis ? vis.plus : (parsed?.visibilityPlus ?? false);
  const ceilingFt = ceilingOf(clouds);
  const apiCategory = isFlightCategory(o["fltCat"]) ? o["fltCat"] : null;
  const category = pick(apiCategory, flightCategory(visibilitySm, ceilingFt, clouds !== null));

  const out: AwcDecoded = {
    station,
    observedAt: pick(apiObservedAt(o), parsed?.observedAt ?? null),
    wind: pick(apiWind, parsed?.wind ?? null),
    visibilitySm,
    visibilityPlus,
    clouds,
    ceilingFt,
    tempC: pick(num(o["temp"]), parsed?.tempC ?? null),
    dewpointC: pick(num(o["dewp"]), parsed?.dewpointC ?? null),
    altimeterHpa: pick(apiAltHpa, parsed?.altimeterHpa ?? null),
    weather: pick(wxString, parsed?.weather ?? null),
    category,
    decodedBy: apiFields >= fallbacks ? "api" : "parser",
    rawText,
  };
  return out;
}

/** Map the API's JSON body (an array; anything else is an empty result). */
export function fromAwcResponse(body: unknown, ref: Date = new Date()): AwcDecoded[] {
  if (!Array.isArray(body)) return [];
  const out: AwcDecoded[] = [];
  for (const item of body) {
    const m = fromAwcMetar(item, ref);
    if (m) out.push(m);
  }
  return out;
}

// ---- TAF ----------------------------------------------------------------------------------
//
//   GET https://aviationweather.gov/api/data/taf?ids=KMEM,KATL&format=json
//
// Same service, terms and limits as METAR. Documented JSON: an array with one object per TAF
// carrying `icaoId`, `rawTAF`, `issueTime` (ISO string), `validTimeFrom`/`validTimeTo` (unix
// seconds) and `fcsts` (the API's own period decoding). Our parser on `rawTAF` is the source
// of the periods so their semantics (BECMG/TEMPO/PROB merging, categories) are ours and do
// not depend on the unversioned `fcsts` shape; the header fields only fill gaps. The number
// of `fcsts` is kept so the live check can compare it with our period count.

export const AWC_TAF_URL = "https://aviationweather.gov/api/data/taf";
export const AWC_TAF_ATTRIBUTION = "TAF: NOAA Aviation Weather Center (aviationweather.gov)";

export function awcTafUrl(stations: readonly string[]): string {
  return `${AWC_TAF_URL}?ids=${stations.map(encodeURIComponent).join(",")}&format=json`;
}

export interface AwcTafDecoded extends TafDecoded {
  rawText: string;
  /** Length of the API's `fcsts` array (null when absent); diagnostics only. */
  apiPeriodCount: number | null;
}

function isoFrom(v: unknown): string | null {
  if (typeof v === "number" && Number.isFinite(v)) return new Date(v * 1000).toISOString();
  if (typeof v === "string" && v.trim() !== "") {
    if (/^\d+$/.test(v.trim())) return new Date(Number(v) * 1000).toISOString();
    const d = new Date(v.includes("T") || v.endsWith("Z") ? v : `${v.replace(" ", "T")}Z`);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

/** Map one element of the TAF JSON array; null without a station or raw text. */
export function fromAwcTaf(value: unknown, ref: Date = new Date()): AwcTafDecoded | null {
  if (!value || typeof value !== "object") return null;
  const o = value as Obj;
  const rawText = typeof o["rawTAF"] === "string" ? o["rawTAF"].trim().replace(/\s+/g, " ") : "";
  if (!rawText) return null;
  const issued = isoFrom(o["issueTime"]);
  // Date the raw DDHHMMZ against the API's issue time when it has one.
  const parsed = parseTaf(rawText, issued ? new Date(issued) : ref);
  const id = typeof o["icaoId"] === "string" ? o["icaoId"].trim().toUpperCase() : "";
  const station = id || parsed?.station || "";
  if (!station || !parsed) return null;
  return {
    ...parsed,
    station,
    issuedAt: parsed.issuedAt ?? issued,
    validFrom: parsed.validFrom ?? isoFrom(o["validTimeFrom"]),
    validTo: parsed.validTo ?? isoFrom(o["validTimeTo"]),
    rawText,
    apiPeriodCount: Array.isArray(o["fcsts"]) ? o["fcsts"].length : null,
  };
}

/** Map the TAF JSON body (an array; anything else is an empty result). */
export function fromAwcTafResponse(body: unknown, ref: Date = new Date()): AwcTafDecoded[] {
  if (!Array.isArray(body)) return [];
  const out: AwcTafDecoded[] = [];
  for (const item of body) {
    const t = fromAwcTaf(item, ref);
    if (t) out.push(t);
  }
  return out;
}
