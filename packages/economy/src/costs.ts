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
import { greatCircleNm, round2 } from "./geo";
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

/** Distance to the nearest other large airport in `list`, nm. */
export function nearestLargeAirportNm(
  airport: EconomyAirport,
  list: readonly EconomyAirport[],
): number | null {
  let best: number | null = null;
  for (const other of list) {
    if (other.type !== "large" || other.ident === airport.ident) continue;
    const d = greatCircleNm(airport, other);
    if (best === null || d < best) best = d;
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
