// MSFS facilities override (plan §6.1, §8): merge the airport data the connected simulator
// returned (packages/protocol "facilities") over the bundled OurAirports record.
//
// Rules (docs/ECONOMY.md "MSFS airport data"):
// - A field comes from MSFS only when the sim returned it; otherwise it stays OurAirports
//   (or absent). Each merged airport carries the source of every field.
// - Position and elevation: MSFS when present (the sim always returns them with the airport).
// - Longest runway and its surface: from the longest runway MSFS returned (ties: the first
//   one). An airport with no runways in MSFS keeps the OurAirports runway. A surface code
//   that is not in MSFS_SURFACES keeps the OurAirports surface.
// - An airport the bundle does not have (an add-on airport) is added as "small" with the
//   MSFS name (or its ICAO when the sim returned no name).
// Pure and deterministic: the same base list and facility records give the same lookup
// (sorted by ident, like airportLookup), so the job generator stays seeded-deterministic.

import type { MsfsAirport, MsfsRunway } from "../../protocol/src/facilities";
import { airportLookup, type AirportLookup, type EconomyAirport } from "./airports";

const FT_PER_M = 3.280_839_895;

/** Metres (SimConnect facility units) to feet, rounded to whole feet. */
export function metresToFeet(m: number): number {
  return Math.round(m * FT_PER_M);
}

/**
 * SURFACE enum of a facility runway (SDK runway members; transcription noted in
 * docs/SIMVARS.md "Facility definition"): the name, and a surface code that
 * `surfaceClass` (protocol/aircraft-types) classifies like an OurAirports code.
 * Values from 24 up rest on a single secondary source (PC-57 checks them on the sim).
 */
export const MSFS_SURFACES: Readonly<Record<number, { name: string; code: string }>> = {
  0: { name: "concrete", code: "CONCRETE" },
  1: { name: "grass", code: "GRASS" },
  2: { name: "water (FSX)", code: "WATER" },
  3: { name: "bumpy grass", code: "GRASS-BUMPY" },
  4: { name: "asphalt", code: "ASPHALT" },
  5: { name: "short grass", code: "GRASS-SHORT" },
  6: { name: "long grass", code: "GRASS-LONG" },
  7: { name: "hard turf", code: "TURF-HARD" },
  8: { name: "snow", code: "SNOW" },
  9: { name: "ice", code: "ICE" },
  10: { name: "urban", code: "URBAN" },
  11: { name: "forest", code: "FOREST" },
  12: { name: "dirt", code: "DIRT" },
  13: { name: "coral", code: "CORAL" },
  14: { name: "gravel", code: "GRAVEL" },
  15: { name: "oil treated", code: "OIL-TREATED" },
  16: { name: "steel mats", code: "PSP-STEEL-MATS" },
  17: { name: "bituminous", code: "BITUMINOUS" },
  18: { name: "brick", code: "BRICK" },
  19: { name: "macadam", code: "MACADAM" },
  20: { name: "planks", code: "PLANKS" },
  21: { name: "sand", code: "SAND" },
  22: { name: "shale", code: "SHALE" },
  23: { name: "tarmac", code: "TARMAC" },
  24: { name: "wright flyer track", code: "WRIGHT-FLYER-TRACK" },
  25: { name: "ocean", code: "WATER-OCEAN" },
  26: { name: "water", code: "WATER" },
  27: { name: "pond", code: "WATER-POND" },
  28: { name: "lake", code: "WATER-LAKE" },
  29: { name: "river", code: "WATER-RIVER" },
  30: { name: "waste water", code: "WATER-WASTE" },
  31: { name: "paint", code: "PAINT" },
};

/** Name of a SURFACE value, or null when it is not in the table (e.g. 254 "unknown"). */
export function msfsSurfaceName(code: number): string | null {
  return MSFS_SURFACES[code]?.name ?? null;
}

/** The longest runway MSFS returned (ties: the first), or null. */
export function longestMsfsRunway(runways: readonly MsfsRunway[]): MsfsRunway | null {
  let best: MsfsRunway | null = null;
  for (const r of runways) if (!best || r.lengthFt > best.lengthFt) best = r;
  return best;
}

export type FieldSource = "msfs" | "ourairports";

/** Where each shown field of a merged airport came from (null = no data at all). */
export interface AirportSources {
  name: FieldSource;
  position: FieldSource;
  elevation: FieldSource | null;
  runway: FieldSource | null;
  surface: FieldSource | null;
}

export interface MergedAirport {
  airport: EconomyAirport;
  sources: AirportSources;
  /** The MSFS record used, when there is one. */
  msfs: MsfsAirport | null;
}

const OURAIRPORTS_ONLY = (a: EconomyAirport): AirportSources => ({
  name: "ourairports",
  position: "ourairports",
  elevation: a.elevFt !== undefined ? "ourairports" : null,
  runway: a.longestRwyFt !== undefined ? "ourairports" : null,
  surface: a.surface !== undefined ? "ourairports" : null,
});

/** Merge one MSFS record over a bundled airport (either may be missing). */
export function mergeFacility(
  base: EconomyAirport | null,
  msfs: MsfsAirport | null,
): MergedAirport | null {
  if (!msfs) return base ? { airport: base, sources: OURAIRPORTS_ONLY(base), msfs: null } : null;
  const ident = base?.ident ?? msfs.icao.toUpperCase();
  const longest = longestMsfsRunway(msfs.runways);
  const msfsSurface = longest ? MSFS_SURFACES[longest.surfaceCode] : undefined;
  const airport: EconomyAirport = {
    ...(base ?? {}),
    ident,
    name: base?.name ?? msfs.name ?? ident,
    type: base?.type ?? "small",
    lat: msfs.lat,
    lon: msfs.lon,
    elevFt: msfs.elevFt,
  };
  const sources: AirportSources = {
    name: base ? "ourairports" : "msfs",
    position: "msfs",
    elevation: "msfs",
    runway: base?.longestRwyFt !== undefined ? "ourairports" : null,
    surface: base?.surface !== undefined ? "ourairports" : null,
  };
  if (longest) {
    airport.longestRwyFt = longest.lengthFt;
    sources.runway = "msfs";
    if (msfsSurface) {
      airport.surface = msfsSurface.code;
      sources.surface = "msfs";
    }
  }
  return { airport, sources, msfs };
}

/** An AirportLookup that also says where each field came from. */
export interface FacilityLookup extends AirportLookup {
  sourcesOf(ident: string | null | undefined): AirportSources | null;
  msfsOf(ident: string | null | undefined): MsfsAirport | null;
}

/** Bundled airports with the MSFS records merged over them (sorted by ident). */
export function facilityLookup(
  base: readonly EconomyAirport[],
  facilities: Iterable<MsfsAirport>,
): FacilityLookup {
  const byIdent = new Map<string, MsfsAirport>();
  for (const f of facilities) byIdent.set(f.icao.trim().toUpperCase(), f);
  const merged = new Map<string, MergedAirport>();
  const list: EconomyAirport[] = [];
  for (const a of base) {
    const key = a.ident.toUpperCase();
    const m = mergeFacility(a, byIdent.get(key) ?? null);
    if (!m) continue;
    merged.set(key, m);
    list.push(m.airport);
  }
  for (const [key, f] of byIdent) {
    if (merged.has(key)) continue;
    const m = mergeFacility(null, f);
    if (!m) continue;
    merged.set(key, m);
    list.push(m.airport);
  }
  const lookup = airportLookup(list);
  const key = (ident: string | null | undefined) => (ident ? ident.trim().toUpperCase() : "");
  return {
    list: lookup.list,
    get: lookup.get,
    sourcesOf: (ident) => merged.get(key(ident))?.sources ?? null,
    msfsOf: (ident) => merged.get(key(ident))?.msfs ?? null,
  };
}

/** Label shown next to a field: "MSFS" or "OurAirports". */
export function fieldSourceLabel(source: FieldSource): string {
  return source === "msfs" ? "MSFS" : "OurAirports";
}
