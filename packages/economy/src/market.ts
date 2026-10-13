// P5 used aircraft market (plan §7.1): seeded listings per type with age, hours, cycles,
// a location from the bundled airports, per-system condition, disclosed and hidden
// defects, an asking price and a generated seller note; the pre-purchase inspection; the
// hidden grounding roll of an uninspected purchase; and the value formula shared by
// listings and resale. Pure and deterministic; docs/ECONOMY.md ("P5") has the examples.

import {
  AIRCRAFT_TYPES,
  aircraftTypeByKey,
  type AircraftType,
} from "../../protocol/src/aircraft-types";
import { SYSTEM_KEYS, type Defect, type MarketListing } from "../../protocol/src/maintenance";
import type { EconomyAirport } from "./airports";
import {
  derivedCondition,
  makeDefect,
  pickSeverity,
  pickSystem,
  type SystemConditions,
} from "./airworthiness";
import { AIRCRAFT_CLASS_MIN_TIER } from "./company-constants";
import { marketValue } from "./fleet-rules";
import { greatCircleNm, round1, round2 } from "./geo";
import {
  DEFECT_DISCOUNT_FACTOR,
  DEFECT_DISCOUNT_MAX,
  INSPECTION_FEE_SHARE,
  LISTING_HIDDEN_CHANCE,
  LISTING_SEVERITY_WEIGHT,
  MARKET_AGE_YEARS,
  MARKET_CATEGORY_WEIGHT,
  MARKET_CYCLES_PER_HOUR,
  MARKET_HOURS_PER_YEAR,
  MARKET_LISTINGS,
  MARKET_NEAR_NM,
  MARKET_NEAR_SHARE,
  MARKET_NOISE,
  MARKET_PRICE_STEP,
  PURCHASE_HIDDEN_BASE,
  PURCHASE_HIDDEN_MAX,
  PURCHASE_HIDDEN_PER_YEAR,
  VALUE_AGE_FLOOR,
  VALUE_LOSS_PER_YEAR,
} from "./maintenance-constants";
import { Rng, seedFrom } from "./prng";
import { runwaySuitability } from "./airports";

/** A listing as the book keeps it (hidden defects included; never sent to the browser). */
export interface ListingRecord {
  id: string;
  generation: number;
  typeKey: string;
  ageYears: number;
  hours: number;
  cycles: number;
  location: string;
  systems: SystemConditions;
  defects: Defect[];
  askingPrice: number;
  sellerNote: string;
  listedGameMs: number;
  inspection: {
    status: "none" | "pending" | "done";
    fee: number;
    readyAtGameMs?: number | undefined;
    found?: number | undefined;
  };
  /** Bought or expired listings leave the market. */
  status: "listed" | "sold" | "expired";
}

// ---- value (listings and resale share it) ----

/** Age factor: −3.5 % per completed year, floor 40 %. */
export function ageFactor(ageYears: number): number {
  return Math.max(VALUE_AGE_FLOOR, 1 - VALUE_LOSS_PER_YEAR * Math.floor(Math.max(0, ageYears)));
}

/** Sum of the known (not hidden) defects' repair costs at maintenance-capable rates. */
export function knownRepairBill(defects: readonly Defect[]): number {
  return round2(defects.filter((d) => !d.hidden).reduce((s, d) => s + d.repairCost, 0));
}

export interface UsedValue {
  /** P4 value (price × hours factor × condition factor) × age factor. */
  base: number;
  /** min(60 %, 2 × known repair bill / base). */
  defectDiscount: number;
  value: number;
}

/**
 * Value of a used airframe (listings, owned aircraft and resale):
 *   base     = price × max(0.4, 1 − 0.00002 × hours) × (0.7 + 0.3 × condition) × ageFactor
 *   discount = min(0.6, 2 × known repair bill / base)
 *   value    = base × (1 − discount)
 * A new aircraft (age 0, no defects) is worth exactly the P4 market value.
 */
export function usedValue(
  type: AircraftType,
  a: { ageYears: number; hours: number; condition: number; defects: readonly Defect[] },
): UsedValue {
  const base = round2(marketValue(type, a.hours, a.condition) * ageFactor(a.ageYears));
  const bill = knownRepairBill(a.defects);
  const defectDiscount =
    base > 0
      ? Math.round(Math.min(DEFECT_DISCOUNT_MAX, (DEFECT_DISCOUNT_FACTOR * bill) / base) * 10_000) /
        10_000
      : 0;
  return { base, defectDiscount, value: round2(base * (1 - defectDiscount)) };
}

/** Asking price = value × (1 + noise), noise ∈ [−8 %, +8 %), rounded to $500. */
export function askingPrice(value: number, noise: number): number {
  return Math.max(
    MARKET_PRICE_STEP,
    Math.round((value * (1 + noise)) / MARKET_PRICE_STEP) * MARKET_PRICE_STEP,
  );
}

/** Pre-purchase inspection fee: 0.5 % of the asking price. */
export function inspectionFee(asking: number): number {
  return round2(asking * INSPECTION_FEE_SHARE);
}

// ---- seller notes (short generated phrases; no real people or companies) ----

const OPENERS = [
  "Well maintained",
  "Fleet disposal sale",
  "Ex-freight operator airframe",
  "Hangared most of its life",
  "Priced to sell",
  "Low-time engine",
  "One owner, private use",
  "Recent avionics refresh",
  "Project aircraft",
  "Lease return",
  "Estate sale",
  "Upgrading, must sell",
] as const;
const TAILS_GOOD = ["logs complete", "ready to fly away", "no known damage history"] as const;
const TAILS_MID = ["minor squawks noted", "paint tired but honest", "some deferred items"] as const;
const TAILS_POOR = [
  "sold as seen",
  "ferry permit may be needed",
  "bring your own mechanic",
] as const;

export function sellerNote(rng: Rng, condition: number, knownGrounding: boolean): string {
  const opener = OPENERS[rng.int(0, OPENERS.length - 1)] ?? OPENERS[0];
  const tails = condition >= 80 ? TAILS_GOOD : condition >= 55 ? TAILS_MID : TAILS_POOR;
  const tail = tails[rng.int(0, tails.length - 1)] ?? tails[0];
  return knownGrounding ? `${opener}; grounded, ${tail}.` : `${opener}; ${tail}.`;
}

// ---- generation ----

export interface MarketInput {
  seed: number;
  generation: number;
  airports: readonly EconomyAirport[];
  base: EconomyAirport | null;
  gameMs: number;
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

/**
 * One market generation: 12 listings, seed = FNV-1a(company seed, "market", generation).
 * Type weights by category (single 3, twin 2, regional 1.5, narrowbody 1, widebody 0.5);
 * 65 % of the listings within 600 nm of the base, the rest anywhere; the airport's runway
 * must suit the type. Age 1–30 years; hours = age × category hours/year × 0.6–1.4; cycles =
 * hours × category cycles/hour. Systems: base = 95 − 1.1 × age − 8 × (utilisation − 1) ± 5 (35–98),
 * each system base −12…+8 (min 12). Defects: 0…1 + ⌊age / 8⌋ plus one more 25 % of the time;
 * severity cosmetic 30 / minor 34 / major 24 / grounding 12; hidden 10 / 25 / 35 / 50 %.
 */
export function generateMarket(input: MarketInput): ListingRecord[] {
  const rng = new Rng(seedFrom(input.seed, "market", input.generation));
  const out: ListingRecord[] = [];
  const near = input.base
    ? input.airports.filter((a) => greatCircleNm(a, input.base as EconomyAirport) <= MARKET_NEAR_NM)
    : [];
  for (let i = 0; i < MARKET_LISTINGS; i++) {
    const type = rng.weighted(AIRCRAFT_TYPES, (t) => MARKET_CATEGORY_WEIGHT[t.category]);
    if (!type) continue;
    const pool = near.length > 0 && rng.next() < MARKET_NEAR_SHARE ? near : input.airports;
    const suitable = pool.filter((a) => runwaySuitability(a, type).ok);
    const airport = suitable.length > 0 ? suitable[rng.int(0, suitable.length - 1)] : null;
    if (!airport) continue;
    const id = `UL-${input.generation}-${i + 1}`;
    out.push(makeListing(rng, id, type, airport, input));
  }
  return out;
}

function makeListing(
  rng: Rng,
  id: string,
  type: AircraftType,
  airport: EconomyAirport,
  input: MarketInput,
): ListingRecord {
  const ageYears = rng.int(MARKET_AGE_YEARS.min, MARKET_AGE_YEARS.max);
  const utilisation = rng.range(0.6, 1.4);
  const hours = Math.round(ageYears * MARKET_HOURS_PER_YEAR[type.category] * utilisation);
  const cycles = Math.round(hours * MARKET_CYCLES_PER_HOUR[type.category]);
  const base = clamp(95 - 1.1 * ageYears - 8 * (utilisation - 1) + rng.range(-5, 5), 35, 98);
  const systems = Object.fromEntries(
    SYSTEM_KEYS.map((k) => [k, round2(clamp(base + rng.range(-12, 8), 12, 100))]),
  ) as SystemConditions;
  const n = rng.int(0, 1 + Math.floor(ageYears / 8)) + (rng.next() < 0.25 ? 1 : 0);
  const defects: Defect[] = [];
  for (let j = 0; j < n; j++) {
    const severity = pickSeverity(rng, LISTING_SEVERITY_WEIGHT);
    const hidden = rng.next() < LISTING_HIDDEN_CHANCE[severity];
    defects.push(
      makeDefect(rng, {
        id: `${id}-D${j + 1}`,
        system: pickSystem(rng),
        severity,
        cause: "listing",
        hidden,
        type,
      }),
    );
  }
  const condition = derivedCondition(systems);
  const value = usedValue(type, { ageYears, hours, condition, defects }).value;
  const noise = rng.range(-MARKET_NOISE, MARKET_NOISE);
  const asking = askingPrice(value, noise);
  const knownGrounding = defects.some((d) => !d.hidden && d.severity === "grounding");
  return {
    id,
    generation: input.generation,
    typeKey: type.key,
    ageYears,
    hours,
    cycles,
    location: airport.ident,
    systems,
    defects,
    askingPrice: asking,
    sellerNote: sellerNote(rng, condition, knownGrounding),
    listedGameMs: Math.floor(input.gameMs),
    inspection: { status: "none", fee: inspectionFee(asking) },
    status: "listed",
  };
}

// ---- inspection and purchase ----

/** Complete a pre-purchase inspection: every hidden defect becomes known. */
export function completeInspection(listing: ListingRecord, gameMs: number): ListingRecord {
  const found = listing.defects.filter((d) => d.hidden).length;
  return {
    ...listing,
    defects: listing.defects.map((d) =>
      d.hidden ? { ...d, hidden: false, foundGameMs: Math.floor(gameMs) } : d,
    ),
    inspection: {
      status: "done",
      fee: listing.inspection.fee,
      ...(listing.inspection.readyAtGameMs !== undefined
        ? { readyAtGameMs: listing.inspection.readyAtGameMs }
        : {}),
      found,
    },
  };
}

/** Chance of an extra hidden grounding defect when buying uninspected: 8 % + 1.2 %/year, ≤ 45 %. */
export function purchaseHiddenChance(ageYears: number): number {
  return Math.min(PURCHASE_HIDDEN_MAX, PURCHASE_HIDDEN_BASE + PURCHASE_HIDDEN_PER_YEAR * ageYears);
}

/**
 * Buying without a completed inspection rolls (seed = FNV-1a(company seed, "purchase",
 * listing id)) for one extra hidden grounding defect; it surfaces on the first dispatch,
 * together with the listing's own hidden defects. Null when the roll misses or the
 * listing was inspected.
 */
export function purchaseHiddenRoll(
  companySeed: number,
  listing: ListingRecord,
  id: string,
): Defect | null {
  if (listing.inspection.status === "done") return null;
  const type = aircraftTypeByKey(listing.typeKey);
  if (!type) return null;
  const rng = new Rng(seedFrom(companySeed, "purchase", listing.id));
  if (rng.next() >= purchaseHiddenChance(listing.ageYears)) return null;
  return makeDefect(rng, {
    id,
    system: pickSystem(rng),
    severity: "grounding",
    cause: "purchase",
    hidden: true,
    type,
  });
}

/** True when buying `listing` uninspected leaves at least one hidden grounding defect. */
export function uninspectedHasHiddenGrounding(
  companySeed: number,
  listing: ListingRecord,
): boolean {
  if (listing.defects.some((d) => d.hidden && d.severity === "grounding")) return true;
  return purchaseHiddenRoll(companySeed, listing, "probe") !== null;
}

/** Browser view of a listing: hidden defects removed. */
export function listingState(
  l: ListingRecord,
  base: EconomyAirport | null,
  airport: EconomyAirport | null,
): MarketListing {
  const type = aircraftTypeByKey(l.typeKey);
  return {
    id: l.id,
    typeKey: l.typeKey,
    typeName: type?.name ?? l.typeKey,
    category: type?.category ?? "single-turboprop",
    ageYears: l.ageYears,
    hours: l.hours,
    cycles: l.cycles,
    location: l.location,
    distanceFromBaseNm: base && airport ? round1(greatCircleNm(base, airport)) : 0,
    askingPrice: l.askingPrice,
    catalogPrice: type?.priceUsd ?? l.askingPrice,
    condition: derivedCondition(l.systems),
    systems: SYSTEM_KEYS.map((k) => ({ key: k, condition: l.systems[k] })),
    knownDefects: l.defects.filter((d) => !d.hidden),
    sellerNote: l.sellerNote,
    inspection: { ...l.inspection },
    purchaseMinTier: type ? AIRCRAFT_CLASS_MIN_TIER[type.category] : 0,
    listedGameMs: l.listedGameMs,
  };
}
