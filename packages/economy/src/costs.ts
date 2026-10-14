// Operating costs (plan §7 "Costs"): fuel billed at the landing airport's price and
// landing fees by airport size. Pure and deterministic per airport.

import type { AircraftType } from "../../protocol/src/aircraft-types";
import type { EconomyAirport } from "./airports";
import {
  FUEL_BASE_USD_PER_KG,
  FUEL_MAX_DEVIATION,
  FUEL_NOISE,
  FUEL_REMOTE_MAX,
  FUEL_REMOTE_PER_100NM,
  FUEL_SIZE_ADJUSTMENT,
  LANDING_FEE_BASE_USD,
  LANDING_FEE_CATEGORY_FACTOR,
} from "./company-constants";
import { EARTH_RADIUS_NM, greatCircleNm, round2 } from "./geo";
import { hashString } from "./prng";

export const KG_PER_LB = 0.45359237;

export interface FuelPrice {
  /** USD per kg, rounded to 0.001. */
  usdPerKg: number;
  /** Factor parts, each a fraction of the base price. */
  size: number;
  remoteness: number;
  noise: number;
  /** Nearest other large airport, nm (null when none is known). */
  nearestLargeNm: number | null;
}

/** Deterministic noise in [−1, 1) from the airport ident. */
export function airportNoise(ident: string): number {
  return (hashString(`fuel|${ident.toUpperCase()}`) / 4294967296) * 2 - 1;
}

/** Large airports of a list sorted by latitude, built once per list (see below). */
const largeByLat = new WeakMap<readonly EconomyAirport[], EconomyAirport[]>();

function largeAirportsByLat(list: readonly EconomyAirport[]): EconomyAirport[] {
  let index = largeByLat.get(list);
  if (!index) {
    index = list.filter((a) => a.type === "large").sort((a, b) => a.lat - b.lat);
    largeByLat.set(list, index);
  }
  return index;
}

// Haversine distances can come out a hair under the exact latitude bound in floating point;
// only skip a candidate when its bound beats the best by more than this, nm.
const PRUNE_SLACK_NM = 1e-6;

/**
 * Distance to the nearest other large airport in `list`, nm.
 *
 * Exact, not approximate: the great-circle distance is never shorter than the latitude
 * difference alone (R × |Δlat|), so walking the large airports outwards in latitude from
 * `airport` can stop once that bound exceeds the best distance found. Same result as scanning
 * every large airport, at a fraction of the cost (pricing all ~5 000 bundled airports went
 * from ~6 M haversines to a small fraction of that). The per-list index is cached by list
 * identity, so lists are treated as immutable (they are `readonly`).
 */
export function nearestLargeAirportNm(
  airport: EconomyAirport,
  list: readonly EconomyAirport[],
): number | null {
  const large = largeAirportsByLat(list);
  // First index with lat >= airport.lat.
  let lo = 0;
  let hi = large.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((large[mid] as EconomyAirport).lat < airport.lat) lo = mid + 1;
    else hi = mid;
  }
  let best: number | null = null;
  // Visits one candidate; false once it (and everything beyond it) is provably farther.
  const visit = (other: EconomyAirport): boolean => {
    const bound = EARTH_RADIUS_NM * Math.abs(((other.lat - airport.lat) * Math.PI) / 180);
    if (best !== null && bound > best + PRUNE_SLACK_NM) return false;
    if (other.ident !== airport.ident) {
      const d = greatCircleNm(airport, other);
      if (best === null || d < best) best = d;
    }
    return true;
  };
  let up = lo;
  let down = lo - 1;
  while (up < large.length || down >= 0) {
    if (up < large.length) up = visit(large[up] as EconomyAirport) ? up + 1 : large.length;
    if (down >= 0) down = visit(large[down] as EconomyAirport) ? down - 1 : -1;
  }
  return best;
}

/**
 * Fuel price at an airport: base × (1 + size + remoteness + noise), the sum clamped to
 * ±20 %. size: large −5 %, medium +3 %, small +8 %; remoteness +2 % per 100 nm to the
 * nearest other large airport (≤ +10 %); noise ±5 % from FNV-1a(ident).
 */
export function fuelPrice(airport: EconomyAirport, list: readonly EconomyAirport[]): FuelPrice {
  const size = FUEL_SIZE_ADJUSTMENT[airport.type];
  const nearestLargeNm = nearestLargeAirportNm(airport, list);
  const remoteness =
    nearestLargeNm === null
      ? FUEL_REMOTE_MAX
      : Math.min(FUEL_REMOTE_MAX, (nearestLargeNm / 100) * FUEL_REMOTE_PER_100NM);
  const noise = airportNoise(airport.ident) * FUEL_NOISE;
  const adj = Math.max(
    -FUEL_MAX_DEVIATION,
    Math.min(FUEL_MAX_DEVIATION, size + remoteness + noise),
  );
  return {
    usdPerKg: Math.round(FUEL_BASE_USD_PER_KG * (1 + adj) * 1000) / 1000,
    size,
    remoteness: Math.round(remoteness * 10_000) / 10_000,
    noise: Math.round(noise * 10_000) / 10_000,
    nearestLargeNm: nearestLargeNm === null ? null : Math.round(nearestLargeNm * 10) / 10,
  };
}

/** Fuel bill, dollars: kg burned × the airport's price per kg. */
export function fuelCost(fuelKg: number, price: FuelPrice): number {
  return round2(Math.max(0, fuelKg) * price.usdPerKg);
}

/** Landing fee, dollars: size base (large $300, medium $120, small $40) × category factor. */
export function landingFee(airport: Pick<EconomyAirport, "type">, aircraft: AircraftType): number {
  return round2(
    LANDING_FEE_BASE_USD[airport.type] * LANDING_FEE_CATEGORY_FACTOR[aircraft.category],
  );
}
