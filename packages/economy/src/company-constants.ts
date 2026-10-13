// P4 constants: company clock, costs, wear, fleet and finance. Documented in
// docs/ECONOMY.md ("P4"); change them there and here together.

import type { CargoKind } from "../../protocol/src/economy";

/** Company clock: one in-game day, and the 30-day in-game month loans and leases bill on. */
export const GAME_DAY_MS = 86_400_000;
export const GAME_MONTH_DAYS = 30;
export const GAME_MONTH_MS = GAME_MONTH_DAYS * GAME_DAY_MS;
/**
 * Largest wall-clock step the company clock accepts in one tick: a longer gap (PC asleep,
 * connector stopped) counts as this much, so in-game time only runs while the connector does.
 */
export const CLOCK_MAX_WALL_STEP_MS = 60_000;

/** Jet-A base price, USD per kg (≈ $5.90 per US gallon at 0.8 kg/L). */
export const FUEL_BASE_USD_PER_KG = 1.95;
/** Price adjustment by airport size (busy hubs are cheaper). */
export const FUEL_SIZE_ADJUSTMENT = { large: -0.05, medium: 0.03, small: 0.08 } as const;
/** +2 % per 100 nm to the nearest other large airport, capped at +10 %. */
export const FUEL_REMOTE_PER_100NM = 0.02;
export const FUEL_REMOTE_MAX = 0.1;
/** Deterministic per-airport noise, ±5 % (FNV-1a of the ident). */
export const FUEL_NOISE = 0.05;
/** The airport price never leaves base ± 20 %. */
export const FUEL_MAX_DEVIATION = 0.2;

/** Landing fee by airport size, USD, for a single-turboprop; × the category factor. */
export const LANDING_FEE_BASE_USD = { large: 300, medium: 120, small: 40 } as const;
export const LANDING_FEE_CATEGORY_FACTOR = {
  "single-piston": 0.5,
  "single-turboprop": 1,
  "twin-turboprop": 1.5,
  "regional-turboprop": 3,
  "narrowbody-jet": 8,
  "widebody-jet": 20,
} as const;

/** Wear model (plan §7), percentage points of condition. */
export const WEAR = {
  perFlightHour: 0.5,
  /** 2 points per 0.3 G above 1.4 G at touchdown. */
  perGStep: 2,
  gThreshold: 1.4,
  gStep: 0.3,
  perOverspeed: 5,
  /** A crash takes 50 points (the airframe is usually grounded until repaired). */
  crash: 50,
} as const;
/** IAS above Vmo for this long (simulator time) is one overspeed event. */
export const OVERSPEED_SUSTAIN_MS = 3_000;
/** A new event needs IAS back below Vmo − 5 kt first. */
export const OVERSPEED_REARM_KT = 5;
/** Missions cannot be loaded below this condition, percent. */
export const MIN_DISPATCH_CONDITION = 20;

/** Repair cost = 8 % of the catalogue price per 100 points of wear (∝ price × wear). */
export const REPAIR_COST_SHARE = 0.08;
/** Repair time = 2 h + 1.5 h per point of wear, in-game hours. */
export const REPAIR_HOURS_BASE = 2;
export const REPAIR_HOURS_PER_POINT = 1.5;

/** Value = price × max(0.4, 1 − 0.002 % per flight hour) × (0.7 + 0.3 × condition). */
export const VALUE_LOSS_PER_FLIGHT_HOUR = 0.00002;
export const VALUE_FLOOR_SHARE = 0.4;
export const VALUE_CONDITION_WEIGHT = 0.3;
/** Selling to the dealer pays 90 % of the market value. */
export const SALE_SHARE = 0.9;
/** Leases also bill 0.25 % of the catalogue price per in-game month (first month up front). */
export const LEASE_MONTHLY_SHARE = 0.0025;

/** New company: one owned Cessna 208B at the base. */
export const STARTER_AIRCRAFT_KEY = "c208b";

/** Reputation tier gates (tier = floor(reputation / 20)). */
export const AIRCRAFT_CLASS_MIN_TIER = {
  "single-piston": 0,
  "single-turboprop": 0,
  "twin-turboprop": 1,
  "regional-turboprop": 2,
  "narrowbody-jet": 3,
  "widebody-jet": 4,
} as const;
/** Leasing is allowed one tier below the purchase gate. */
export const LEASE_TIER_DISCOUNT = 1;
export const JOB_KIND_MIN_TIER: Record<CargoKind, number> = {
  cargo: 0,
  express: 0,
  fragile: 0,
  bush: 0,
  medical: 1,
  hazmat: 2,
};

/** Loans (plan §7.2). */
export const ORIGINATION_FEE_SHARE = 0.01;
export const LATE_FEE_SHARE = 0.05;
export const LATE_FEE_MIN_USD = 100;
export const MISSED_PAYMENT_REPUTATION = -5;
export const REPOSSESS_AFTER_MISSES = 3;
export const DEFAULT_FLAG_MONTHS = 12;
export const MIN_LOAN_USD = 1_000;

/** Credit score 0–850 = 3 × reputation + 25 × positive months (≤ 12) + 250 × (1 − debt ratio). */
export const CREDIT = {
  perReputationPoint: 3,
  perPositiveMonth: 25,
  positiveMonthsCap: 12,
  debtWeight: 250,
  max: 850,
} as const;
