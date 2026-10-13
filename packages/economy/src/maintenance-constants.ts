// P5 constants: systems, defects, the airworthiness gate, annual inspections, ferry
// permits, repairs and the used aircraft market. Documented in docs/ECONOMY.md ("P5 —
// used aircraft and airworthiness"); change them there and here together.

import type { DefectSeverity, SystemKey } from "../../protocol/src/maintenance";
import { GAME_DAY_MS, GAME_MONTH_MS } from "./company-constants";

/** Weight of each system in the overall condition (Σ = 1). */
export const SYSTEM_WEIGHTS: Record<SystemKey, number> = {
  engines: 0.2,
  propeller: 0.06,
  airframe: 0.2,
  gear: 0.12,
  avionics: 0.08,
  electrical: 0.07,
  fuel: 0.08,
  hydraulics: 0.07,
  cargo: 0.07,
  interior: 0.05,
};

/** Repair cost factor per system (engines and structure are the dear ones). */
export const SYSTEM_COST_FACTOR: Record<SystemKey, number> = {
  engines: 1.6,
  propeller: 1.0,
  airframe: 1.3,
  gear: 0.9,
  avionics: 1.0,
  electrical: 0.6,
  fuel: 0.7,
  hydraulics: 0.7,
  cargo: 0.5,
  interior: 0.4,
};

/** Downtime factor per system. */
export const SYSTEM_TIME_FACTOR: Record<SystemKey, number> = {
  engines: 1.5,
  propeller: 1.0,
  airframe: 1.3,
  gear: 1.0,
  avionics: 0.8,
  electrical: 0.8,
  fuel: 1.0,
  hydraulics: 1.0,
  cargo: 0.7,
  interior: 0.6,
};

/** Repair cost as a share of the catalogue price, by severity (× system factor × rarity). */
export const SEVERITY_COST_SHARE: Record<DefectSeverity, number> = {
  cosmetic: 0.0004,
  minor: 0.002,
  major: 0.008,
  grounding: 0.025,
};

/** Downtime in in-game hours at a maintenance-capable airport, by severity (× system factor). */
export const SEVERITY_HOURS: Record<DefectSeverity, number> = {
  cosmetic: 4,
  minor: 8,
  major: 24,
  grounding: 60,
};

/** Parts for rare types cost more (catalogue key → factor; absent = 1). */
export const PARTS_RARITY: Record<string, number> = {
  pc6: 1.25,
  kodiak100: 1.15,
  c208b: 1.0,
  dhc6: 1.2,
  pc12: 1.05,
  kingair350: 1.0,
  atr72f: 1.1,
  "dash8-400": 1.1,
  a320p2f: 1.0,
  b738bcf: 1.0,
  b748f: 1.2,
};

/** Shop rates: maintenance-capable airports are the reference; elsewhere is a field repair. */
export const SHOP_FACTORS = {
  maintenance: { cost: 1, time: 1 },
  field: { cost: 1.35, time: 1.5 },
} as const;

/** Dispatch needs every system at or above this condition, percent. */
export const MIN_SYSTEM_CONDITION = 20;
/** A ferry permit needs every system at or above this condition, percent. */
export const FERRY_MIN_SYSTEM_CONDITION = 10;
/** Minor defects may be deferred (MEL) for this many flight hours. */
export const DEFERRAL_LIMIT_HOURS = 30;
/** Minor defects add 1 % fuel burn each; majors roll 5–15 % fuel and 5–15 % payload. */
export const MINOR_FUEL_PCT = 1;
export const MAJOR_FUEL_PCT = { min: 5, max: 15 } as const;
export const MAJOR_PAYLOAD_PCT = { min: 5, max: 15 } as const;
/** Payload reduction from major defects is capped at this percentage. */
export const MAX_PAYLOAD_PENALTY_PCT = 30;
/** Chance per airborne hour that a major defect escalates to grounding (cap 50 % per flight). */
export const MAJOR_ESCALATION_PER_HOUR = 0.03;
export const MAJOR_ESCALATION_MAX = 0.5;

/** Annual inspection: every 12 in-game months or 100 flight hours, whichever first. */
export const ANNUAL_INTERVAL_MS = 12 * GAME_MONTH_MS;
export const ANNUAL_INTERVAL_HOURS = 100;
/** "Due soon" warning window. */
export const ANNUAL_SOON_MS = 30 * GAME_DAY_MS;
export const ANNUAL_SOON_HOURS = 10;
/** Annual cost = 0.4 % of the catalogue price × rarity × shop factor. */
export const ANNUAL_COST_SHARE = 0.004;
/** Annual downtime by category, in-game hours (× shop time factor). */
export const ANNUAL_HOURS_BY_CATEGORY = {
  "single-piston": 12,
  "single-turboprop": 16,
  "twin-turboprop": 24,
  "regional-turboprop": 36,
  "narrowbody-jet": 48,
  "widebody-jet": 72,
} as const;

/** Ferry permit: fee = $400 × landing-fee category factor; payload cap 10 % of max payload. */
export const FERRY_PERMIT_FEE_BASE = 400;
export const FERRY_PAYLOAD_SHARE = 0.1;

/** Wear distribution: share of the G / overspeed wear spread over every system. */
export const WEAR_UNIFORM_SHARE = 0.5;
/** Condition thresholds whose crossing rolls a new defect on that system. */
export const WEAR_THRESHOLDS = [75, 50, 30] as const;
export const WEAR_THRESHOLD_CHANCE = 0.5;
/** Severity weights of a threshold defect, by threshold. */
export const WEAR_THRESHOLD_SEVERITY: Record<
  (typeof WEAR_THRESHOLDS)[number],
  Partial<Record<DefectSeverity, number>>
> = {
  75: { cosmetic: 40, minor: 60 },
  50: { minor: 60, major: 40 },
  30: { major: 60, grounding: 40 },
};
/** Hard landing: peak G above this rolls a gear/airframe defect. */
export const HARD_LANDING_G = 1.6;
/** Overspeed: chance per event of an airframe defect (minor or major, 50/50). */
export const OVERSPEED_DEFECT_CHANCE = 0.5;
/** Fuel exhaustion: fuel at or below max(1 lb, 0.5 % of the fuel at block-out) in flight. */
export const TANKS_DRY_MIN_LB = 1;
export const TANKS_DRY_SHARE = 0.005;
/** A crash below this overall condition (after crash wear) writes the airframe off. */
export const WRITE_OFF_CONDITION = 25;

/** Used market. */
export const MARKET_REFRESH_MS = 7 * GAME_DAY_MS;
export const MARKET_LISTINGS = 12;
/** Share of listings within MARKET_NEAR_NM of the company base. */
export const MARKET_NEAR_SHARE = 0.65;
export const MARKET_NEAR_NM = 600;
export const MARKET_AGE_YEARS = { min: 1, max: 30 } as const;
/** Typical flight hours per year by category (× 0.6–1.4 per listing). */
export const MARKET_HOURS_PER_YEAR = {
  "single-piston": 250,
  "single-turboprop": 450,
  "twin-turboprop": 550,
  "regional-turboprop": 1_400,
  "narrowbody-jet": 2_400,
  "widebody-jet": 3_200,
} as const;
/** Landings per flight hour by category. */
export const MARKET_CYCLES_PER_HOUR = {
  "single-piston": 1.3,
  "single-turboprop": 1.1,
  "twin-turboprop": 1.0,
  "regional-turboprop": 0.9,
  "narrowbody-jet": 0.6,
  "widebody-jet": 0.2,
} as const;
/** Type weights in the market by category. */
export const MARKET_CATEGORY_WEIGHT = {
  "single-piston": 3,
  "single-turboprop": 3,
  "twin-turboprop": 2,
  "regional-turboprop": 1.5,
  "narrowbody-jet": 1,
  "widebody-jet": 0.5,
} as const;
/** Severity weights and hidden chance of listing defects. */
export const LISTING_SEVERITY_WEIGHT: Record<DefectSeverity, number> = {
  cosmetic: 30,
  minor: 34,
  major: 24,
  grounding: 12,
};
export const LISTING_HIDDEN_CHANCE: Record<DefectSeverity, number> = {
  cosmetic: 0.1,
  minor: 0.25,
  major: 0.35,
  grounding: 0.5,
};
/** Asking price noise, ± share. */
export const MARKET_NOISE = 0.08;
/** Asking prices round to $500. */
export const MARKET_PRICE_STEP = 500;
/** Value loses 3.5 % per completed year of age, floor 40 %. */
export const VALUE_LOSS_PER_YEAR = 0.035;
export const VALUE_AGE_FLOOR = 0.4;
/** Defect discount = 2 × known repair bill / value, capped at 60 %. */
export const DEFECT_DISCOUNT_FACTOR = 2;
export const DEFECT_DISCOUNT_MAX = 0.6;
/** Pre-purchase inspection: 0.5 % of the asking price, one in-game day. */
export const INSPECTION_FEE_SHARE = 0.005;
export const INSPECTION_HOURS = 24;
/** Buying uninspected: chance of an extra hidden grounding defect = 8 % + 1.2 %/year (≤ 45 %). */
export const PURCHASE_HIDDEN_BASE = 0.08;
export const PURCHASE_HIDDEN_PER_YEAR = 0.012;
export const PURCHASE_HIDDEN_MAX = 0.45;
/** One in-game year for ages (12 × 30-day months). */
export const GAME_YEAR_MS = 12 * GAME_MONTH_MS;
