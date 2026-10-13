// FBO economics (plan §7.3): airport size, purchase/build quotes, module costs and
// effects, the price elasticity curve and the deterministic modelled traffic stream.
// Pure and seeded: the same inputs always give the same hour of traffic.

import {
  FBO_MODULE_KINDS,
  FBO_MODULE_LABELS,
  type FboModuleKind,
  type FboQuote,
} from "../../protocol/src/fbo";
import type { DefectSeverity } from "../../protocol/src/maintenance";
import type { EconomyAirport } from "./airports";
import {
  CARGO_TERMINAL,
  CLASS_FEE_FACTOR,
  CLASS_MIX,
  CLASS_UPLIFT_KG,
  ELASTICITY,
  FBO_BASE_PRICE_USD,
  FBO_BUILD_DAYS,
  FBO_CONSTRUCTION_SHARE,
  FBO_LEASE_MONTHLY_SHARE,
  FBO_MODULES,
  FBO_SALE_SHARE,
  FBO_SIZE,
  FBO_VALUE_SHARE,
  FUEL_FARM,
  HANGAR,
  HOUR_PROFILE,
  MAINT_SHOP,
  MODULE_SCALE,
  RAMP,
  REFERENCE_HANDLING_USD,
  TRAFFIC_CLASSES,
  TRAFFIC_EXPONENT,
  TRAFFIC_PER_DAY,
  type TrafficClass,
} from "./fbo-constants";
import { round2 } from "./geo";
import { Rng, seedFrom } from "./prng";

export type ModuleLevels = Record<FboModuleKind, number>;

export function emptyLevels(): ModuleLevels {
  return Object.fromEntries(FBO_MODULE_KINDS.map((k) => [k, 0])) as ModuleLevels;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

// ---- airport size and quotes ----

export interface AirportSize {
  /** s = type × runway × service. */
  s: number;
  type: number;
  runway: number;
  service: number;
}

/** Airport size score (proxy for traffic), 4 decimals. */
export function airportSize(
  airport: Pick<EconomyAirport, "type" | "longestRwyFt" | "iata">,
): AirportSize {
  const type = FBO_SIZE.typeBase[airport.type];
  const runway =
    airport.longestRwyFt === undefined || airport.longestRwyFt <= 0
      ? FBO_SIZE.runwayMin
      : clamp(airport.longestRwyFt / FBO_SIZE.runwayRefFt, FBO_SIZE.runwayMin, FBO_SIZE.runwayMax);
  const service = airport.iata ? 1 : FBO_SIZE.unscheduled;
  return { s: round4(type * runway * service), type, runway: round4(runway), service };
}

/** Modelled movements per in-game day: 60 × s^1.5, 0.1. */
export function movementsPerDay(s: number): number {
  return Math.round(TRAFFIC_PER_DAY * Math.max(0, s) ** TRAFFIC_EXPONENT * 10) / 10;
}

export function buildDays(s: number): number {
  const t = clamp((s - FBO_BUILD_DAYS.sFrom) / FBO_BUILD_DAYS.sSpan, 0, 1);
  return Math.round(FBO_BUILD_DAYS.min + (FBO_BUILD_DAYS.max - FBO_BUILD_DAYS.min) * t);
}

/** Buy price, build cost, land lease and build time at an airport. */
export function fboQuote(airport: EconomyAirport): FboQuote {
  const { s } = airportSize(airport);
  const buyPrice = Math.round((FBO_BASE_PRICE_USD * s) / 1_000) * 1_000;
  return {
    icao: airport.ident,
    sizeFactor: s,
    buyPrice,
    buildCost: round2(buyPrice * FBO_CONSTRUCTION_SHARE),
    landLeaseMonthly: round2(buyPrice * FBO_LEASE_MONTHLY_SHARE),
    buildDays: buildDays(s),
    movementsPerDay: movementsPerDay(s),
  };
}

export function moduleScale(s: number): number {
  return round4(clamp(s, MODULE_SCALE.min, MODULE_SCALE.max));
}

/** Cost of reaching `toLevel` (1 = purchase), dollars. */
export function moduleCost(kind: FboModuleKind, toLevel: number, s: number): number {
  const base = FBO_MODULES[kind].cost[toLevel - 1];
  return base === undefined ? 0 : round2(base * moduleScale(s));
}

/** Monthly upkeep at `level` (0 = none), dollars. */
export function moduleUpkeep(kind: FboModuleKind, level: number, s: number): number {
  const base = level > 0 ? FBO_MODULES[kind].upkeep[level - 1] : 0;
  return round2((base ?? 0) * moduleScale(s));
}

export function moduleDays(kind: FboModuleKind, toLevel: number): number {
  return FBO_MODULES[kind].days[toLevel - 1] ?? 0;
}

export function fboValue(invested: number): number {
  return round2(invested * FBO_VALUE_SHARE);
}

export function fboSalePrice(invested: number): number {
  return round2(invested * FBO_SALE_SHARE);
}

/** One sentence per module level for the UI. */
export function moduleEffect(kind: FboModuleKind, level: number): string {
  const i = Math.max(0, level - 1);
  if (level === 0) return `${FBO_MODULE_LABELS[kind]} not installed`;
  switch (kind) {
    case "fuel":
      return `Cost ${Math.round((FUEL_FARM.margin[i] ?? 0) * 100)} % under the regional price; sells up to ${(FUEL_FARM.capacityKg[i] ?? 0).toLocaleString("en-US")} kg/day; own aircraft fuel at cost`;
    case "hangar":
      return `${HANGAR.bays[i]} bays; own aircraft parked inside lose ${Math.round((HANGAR.weatherWearCut[i] ?? 0) * 100)} % less to weather; spare bays rented`;
    case "maintenance":
      return `Own repairs × 0.75 cost, × 0.7 time up to ${MAINT_SHOP.maxSeverity[i]} defects; services traffic`;
    case "cargo":
      return `+${CARGO_TERMINAL.extraJobs[i]} jobs, +${Math.round((CARGO_TERMINAL.payoutBonus[i] ?? 0) * 100)} % payouts from here; cargo handling fees`;
    case "ramp":
      return `${Math.round((RAMP.capture[i] ?? 0) * 100)} % of the airport's traffic; landing/parking and handling fees${level >= RAMP.loungeMinLevel ? "; crew lounge +1 reputation per own arrival (once a day)" : ""}`;
  }
}

/** Can an own maintenance shop of `level` fix this severity at own rates? */
export function ownShopCovers(level: number, severity: DefectSeverity): boolean {
  if (level <= 0) return false;
  const order: DefectSeverity[] = ["cosmetic", "minor", "major", "grounding"];
  const max = MAINT_SHOP.maxSeverity[Math.min(3, level) - 1] ?? "minor";
  return order.indexOf(severity) <= order.indexOf(max);
}

// ---- pricing ----

/** Demand multiplier at a price ratio r: clamp(1 − 3 × (r − 1), 0, 1.3). */
export function elasticity(r: number): number {
  return round4(clamp(1 - ELASTICITY.slope * (r - 1), 0, ELASTICITY.max));
}

export interface FuelPricing {
  regional: number;
  ratio: number;
  /** Player price, $/kg (3 decimals). */
  price: number;
  /** Farm cost price (own aircraft pay this), $/kg (3 decimals). */
  cost: number;
}

export function fuelPricing(
  regionalUsdPerKg: number,
  ratio: number,
  farmLevel: number,
): FuelPricing {
  const margin = farmLevel > 0 ? (FUEL_FARM.margin[farmLevel - 1] ?? 0) : 0;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  return {
    regional: regionalUsdPerKg,
    ratio,
    price: r3(regionalUsdPerKg * ratio),
    cost: r3(regionalUsdPerKg * (1 - margin)),
  };
}

// ---- modelled traffic ----

export interface TrafficInput {
  companySeed: number;
  icao: string;
  airportType: "large" | "medium" | "small";
  s: number;
  levels: ModuleLevels;
  fuel: FuelPricing;
  handlingFeeUsd: number;
  /** Fuel the farm already sold today, kg (daily capacity). */
  fuelSoldTodayKg: number;
}

export type TrafficKind = "ramp" | "handling" | "fuel" | "cargo" | "maintenance" | "hangar";

export interface TrafficHour {
  /** Movements at the airport this hour and those the FBO captured. */
  movements: number;
  captured: number;
  /** Revenue (fuel: margin) by kind, dollars. */
  byKind: Record<TrafficKind, number>;
  fuelKg: number;
  total: number;
}

function emptyKinds(): Record<TrafficKind, number> {
  return { ramp: 0, handling: 0, fuel: 0, cargo: 0, maintenance: 0, hangar: 0 };
}

/** Expected movements in hour-of-day h: M × w_h / 24. */
export function hourlyRate(s: number, hourOfDay: number): number {
  return (movementsPerDay(s) * (HOUR_PROFILE[hourOfDay] ?? 1)) / 24;
}

function pickClass(rng: Rng, type: TrafficInput["airportType"]): TrafficClass {
  const mix = CLASS_MIX[type];
  return rng.weighted(TRAFFIC_CLASSES, (c) => mix[c]) ?? "turboprop";
}

/**
 * One in-game hour of modelled traffic at an FBO (`hour` = absolute hour index of the
 * company clock). Seed = FNV-1a(company seed, "traffic", ICAO, hour). Movements n =
 * ⌊λ⌋ + Bernoulli(λ − ⌊λ⌋), λ = M × w_h / 24; each is captured with the ramp level's
 * share, then buys (each with its own probability × the price elasticity):
 * landing/parking (always), handling, fuel (margin = price − farm cost, within the daily
 * capacity), cargo handling, maintenance.
 */
export function trafficHour(input: TrafficInput, hour: number): TrafficHour {
  const rng = new Rng(seedFrom(input.companySeed, "traffic", input.icao, hour));
  const lambda = hourlyRate(input.s, ((hour % 24) + 24) % 24);
  const movements = Math.floor(lambda) + (rng.next() < lambda - Math.floor(lambda) ? 1 : 0);
  const byKind = emptyKinds();
  const ramp = Math.max(1, input.levels.ramp);
  const fuelLevel = input.levels.fuel;
  const cargo = input.levels.cargo;
  const shop = input.levels.maintenance;
  const handlingRatio = input.handlingFeeUsd / REFERENCE_HANDLING_USD;
  const eHandling = elasticity(handlingRatio);
  const eFuel = elasticity(input.fuel.ratio);
  const margin = Math.max(0, input.fuel.price - input.fuel.cost);
  const capacity = fuelLevel > 0 ? (FUEL_FARM.capacityKg[fuelLevel - 1] ?? 0) : 0;
  let soldKg = input.fuelSoldTodayKg;
  let fuelKg = 0;
  let captured = 0;
  for (let i = 0; i < movements; i++) {
    // Draw every number for every movement so a module change never shifts the stream.
    const rCapture = rng.next();
    const cls = pickClass(rng, input.airportType);
    const rHandling = rng.next();
    const rFuel = rng.next();
    const rCargo = rng.next();
    const rShop = rng.next();
    if (rCapture >= (RAMP.capture[ramp - 1] ?? 0)) continue;
    captured++;
    const ff = CLASS_FEE_FACTOR[cls];
    byKind.ramp += RAMP.feeUsd * ff * (RAMP.levelFactor[ramp - 1] ?? 1);
    if (rHandling < (RAMP.handlingChance[ramp - 1] ?? 0) * eHandling) {
      byKind.handling += input.handlingFeeUsd * ff;
    }
    if (fuelLevel > 0 && rFuel < (FUEL_FARM.buyChance[fuelLevel - 1] ?? 0) * eFuel) {
      const kg = Math.min(CLASS_UPLIFT_KG[cls], Math.max(0, capacity - soldKg));
      if (kg > 0) {
        soldKg += kg;
        fuelKg += kg;
        byKind.fuel += kg * margin;
      }
    }
    if (cargo > 0 && rCargo < (CARGO_TERMINAL.trafficChance[cargo - 1] ?? 0) * eHandling) {
      byKind.cargo += CARGO_TERMINAL.feeShare * input.handlingFeeUsd * ff;
    }
    if (shop > 0 && rShop < (MAINT_SHOP.trafficChance[shop - 1] ?? 0)) {
      byKind.maintenance += MAINT_SHOP.trafficMarginUsd * ff;
    }
  }
  for (const k of Object.keys(byKind) as TrafficKind[]) byKind[k] = round2(byKind[k]);
  const total = round2(Object.values(byKind).reduce((a, b) => a + b, 0));
  return { movements, captured, byKind, fuelKg, total };
}

/**
 * Hangar bays rented overnight (day boundary): every spare bay (bays − own aircraft
 * parked there) is rented with the level's chance. Seed = FNV-1a(seed, "hangar", ICAO, day).
 */
export function hangarNight(
  companySeed: number,
  icao: string,
  day: number,
  level: number,
  ownedParked: number,
  s: number,
): { bays: number; rented: number; income: number } {
  if (level <= 0) return { bays: 0, rented: 0, income: 0 };
  const bays = HANGAR.bays[level - 1] ?? 0;
  const spare = Math.max(0, bays - ownedParked);
  const rng = new Rng(seedFrom(companySeed, "hangar", icao, day));
  let rented = 0;
  for (let i = 0; i < spare; i++) if (rng.next() < (HANGAR.rentChance[level - 1] ?? 0)) rented++;
  return { bays, rented, income: round2(rented * HANGAR.bayNightUsd * moduleScale(s)) };
}

/**
 * Expected modelled income per in-game day at reference prices (no capacity limit):
 * M × capture × (ramp fee + handling + fuel + cargo + maintenance) per class mix, plus the
 * expected hangar rent. Used for the docs' worked example and the UI estimate.
 */
export function expectedDailyIncome(
  input: Omit<TrafficInput, "fuelSoldTodayKg" | "companySeed" | "icao">,
): number {
  const M = movementsPerDay(input.s);
  const ramp = Math.max(1, input.levels.ramp);
  const mix = CLASS_MIX[input.airportType];
  const eH = elasticity(input.handlingFeeUsd / REFERENCE_HANDLING_USD);
  const eF = elasticity(input.fuel.ratio);
  const margin = Math.max(0, input.fuel.price - input.fuel.cost);
  let perMovement = 0;
  for (const cls of TRAFFIC_CLASSES) {
    const ff = CLASS_FEE_FACTOR[cls];
    let v = RAMP.feeUsd * ff * (RAMP.levelFactor[ramp - 1] ?? 1);
    v += (RAMP.handlingChance[ramp - 1] ?? 0) * eH * input.handlingFeeUsd * ff;
    if (input.levels.fuel > 0)
      v += (FUEL_FARM.buyChance[input.levels.fuel - 1] ?? 0) * eF * CLASS_UPLIFT_KG[cls] * margin;
    if (input.levels.cargo > 0)
      v +=
        (CARGO_TERMINAL.trafficChance[input.levels.cargo - 1] ?? 0) *
        eH *
        CARGO_TERMINAL.feeShare *
        input.handlingFeeUsd *
        ff;
    if (input.levels.maintenance > 0)
      v +=
        (MAINT_SHOP.trafficChance[input.levels.maintenance - 1] ?? 0) *
        MAINT_SHOP.trafficMarginUsd *
        ff;
    perMovement += mix[cls] * v;
  }
  const hangar =
    input.levels.hangar > 0
      ? (HANGAR.bays[input.levels.hangar - 1] ?? 0) *
        (HANGAR.rentChance[input.levels.hangar - 1] ?? 0) *
        HANGAR.bayNightUsd *
        moduleScale(input.s)
      : 0;
  return round2(M * (RAMP.capture[ramp - 1] ?? 0) * perMovement + hangar);
}

// ---- records (book state, persisted by the connector) ----

export interface FboModuleRecord {
  level: number;
  pending: { toLevel: number; cost: number; readyAtGameMs: number } | null;
}

export interface FboToday {
  day: number;
  own: number;
  modelled: number;
  simAi: number;
  movements: number;
  fuelKg: number;
  byKind: Record<TrafficKind, number>;
}

export interface FboDayRecord {
  day: number;
  own: number;
  modelled: number;
  simAi: number;
  movements: number;
}

export interface FboPnlRecord {
  month: number;
  income: number;
  upkeep: number;
  savings: number;
  net: number;
}

export interface FboRecord {
  id: string;
  icao: string;
  status: "building" | "active" | "sold" | "repossessed";
  origin: "bought" | "built";
  acquiredGameMs: number;
  /** Wall clock, ms. */
  acquiredAt: number;
  /** Construction completes (building). */
  readyAtGameMs: number | null;
  /** Wall clock when it became active, ms. */
  builtAt: number | null;
  price: number;
  invested: number;
  landLeaseMonthly: number;
  modules: Record<FboModuleKind, FboModuleRecord>;
  fuelPriceRatio: number;
  handlingFeeUsd: number;
  loanId: string | null;
  /** Next absolute company-clock hour to accrue modelled traffic for. */
  nextHour: number;
  today: FboToday;
  daily: FboDayRecord[];
  pnl: FboPnlRecord[];
  /** Hangar bays rented last night. */
  rented: number;
  aiArrivals: number;
  /** Last in-game day the crew lounge gave reputation (−1 = never). */
  loungeDay: number;
}

export interface FboTransactionRecord {
  fboId: string;
  /** Wall clock, ms. */
  at: number;
  gameMs: number;
  kind: string;
  /** Dollars: cash income (modelled, sim_ai) or savings (own). */
  amount: number;
  source: "own" | "modelled" | "sim_ai";
  memo: string | null;
}

export function emptyToday(day: number): FboToday {
  return { day, own: 0, modelled: 0, simAi: 0, movements: 0, fuelKg: 0, byKind: emptyKinds() };
}

export function newFboRecord(args: {
  id: string;
  icao: string;
  origin: "bought" | "built";
  gameMs: number;
  at: number;
  price: number;
  landLeaseMonthly: number;
  readyAtGameMs: number | null;
  levels: Partial<Record<FboModuleKind, number>>;
}): FboRecord {
  const modules = Object.fromEntries(
    FBO_MODULE_KINDS.map((k) => [k, { level: args.levels[k] ?? 0, pending: null }]),
  ) as Record<FboModuleKind, FboModuleRecord>;
  const active = args.readyAtGameMs === null;
  return {
    id: args.id,
    icao: args.icao,
    status: active ? "active" : "building",
    origin: args.origin,
    acquiredGameMs: Math.floor(args.gameMs),
    acquiredAt: args.at,
    readyAtGameMs: args.readyAtGameMs,
    builtAt: active ? args.at : null,
    price: round2(args.price),
    invested: round2(args.price),
    landLeaseMonthly: args.landLeaseMonthly,
    modules,
    fuelPriceRatio: 1,
    handlingFeeUsd: REFERENCE_HANDLING_USD,
    loanId: null,
    nextHour: Math.ceil(args.gameMs / 3_600_000),
    today: emptyToday(Math.floor(args.gameMs / 86_400_000)),
    daily: [],
    pnl: [],
    rented: 0,
    aiArrivals: 0,
    loungeDay: -1,
  };
}

export function levelsOf(f: Pick<FboRecord, "modules">): ModuleLevels {
  return Object.fromEntries(
    FBO_MODULE_KINDS.map((k) => [k, f.modules[k]?.level ?? 0]),
  ) as ModuleLevels;
}
