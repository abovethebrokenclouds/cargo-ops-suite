// P5 part 2 constants: FBOs, the modelled traffic stream, dynamic demand, hull insurance
// and milestones. Documented in docs/ECONOMY.md ("P5 — FBOs, demand, insurance,
// milestones"); change them there and here together.

import type { DemandEventKind, FboModuleKind } from "../../protocol/src/fbo";

export const HOUR_MS = 3_600_000;

// ---- airport size and acquisition ----

/**
 * Airport size score s = type base × runway factor × service factor. The bundled
 * OurAirports subset has no runway count and no `scheduled_service`: the longest runway
 * stands in for runway capacity and an IATA code for scheduled service.
 */
export const FBO_SIZE = {
  typeBase: { large: 1, medium: 0.35, small: 0.15 },
  /** runway factor = clamp(longest runway / 8,000 ft, 0.4, 1.6); unknown → 0.4. */
  runwayRefFt: 8_000,
  runwayMin: 0.4,
  runwayMax: 1.6,
  /** No IATA code (proxy for no scheduled service): × 0.6. */
  unscheduled: 0.6,
} as const;

/** Buy an existing FBO: $500,000 × s, rounded to $1,000. */
export const FBO_BASE_PRICE_USD = 500_000;
/** Build: construction 55 % of the purchase price, land lease 0.4 % of it per month. */
export const FBO_CONSTRUCTION_SHARE = 0.55;
export const FBO_LEASE_MONTHLY_SHARE = 0.004;
/** Build time 3–14 in-game days: 3 + 11 × clamp((s − 0.15) / 1.45, 0, 1), rounded. */
export const FBO_BUILD_DAYS = { min: 3, max: 14, sFrom: 0.15, sSpan: 1.45 } as const;
/** Book value = 85 % of the money invested; selling pays 75 %. */
export const FBO_VALUE_SHARE = 0.85;
export const FBO_SALE_SHARE = 0.75;

/** Module cost/upkeep scale by airport size: clamp(s, 0.4, 1.2). */
export const MODULE_SCALE = { min: 0.4, max: 1.2 } as const;

export interface ModuleSpec {
  /** Cost of level 1, 2, 3 (purchase, then each upgrade), before the size scale. */
  cost: readonly [number, number, number];
  /** Monthly upkeep at level 1, 2, 3, before the size scale. */
  upkeep: readonly [number, number, number];
  /** In-game days to install level 1, 2, 3. */
  days: readonly [number, number, number];
}

export const FBO_MODULES: Record<FboModuleKind, ModuleSpec> = {
  fuel: { cost: [120_000, 180_000, 300_000], upkeep: [3_000, 5_000, 8_000], days: [1, 2, 4] },
  hangar: { cost: [150_000, 200_000, 300_000], upkeep: [2_500, 4_000, 6_000], days: [2, 3, 5] },
  maintenance: {
    cost: [200_000, 250_000, 400_000],
    upkeep: [5_000, 8_000, 12_000],
    days: [2, 3, 5],
  },
  cargo: { cost: [180_000, 220_000, 350_000], upkeep: [4_000, 6_000, 9_000], days: [2, 3, 4] },
  ramp: { cost: [60_000, 100_000, 160_000], upkeep: [1_500, 2_500, 4_000], days: [1, 1, 2] },
};

/** A bought FBO comes with ramp & services 1 and a fuel farm 1; a built one with ramp 1. */
export const BOUGHT_MODULES: Partial<Record<FboModuleKind, number>> = { ramp: 1, fuel: 1 };
export const BUILT_MODULES: Partial<Record<FboModuleKind, number>> = { ramp: 1 };

// ---- modules: effects ----

/** Fuel farm: cost price = regional price × (1 − margin); daily capacity in kg. */
export const FUEL_FARM = {
  margin: [0.06, 0.09, 0.12],
  capacityKg: [20_000, 60_000, 150_000],
  /** Purchase probability of a captured movement at the reference price. */
  buyChance: [0.45, 0.55, 0.65],
} as const;
/** Hangar: bays per level; nightly bay rent × size scale; chance a spare bay is rented. */
export const HANGAR = {
  bays: [2, 4, 8],
  bayNightUsd: 90,
  rentChance: [0.45, 0.6, 0.75],
  /** Weather wear while parked inside: −60 %, −80 %, −100 %. */
  weatherWearCut: [0.6, 0.8, 1],
} as const;
/** Maintenance shop: own repairs × 0.75 cost, × 0.7 time; traffic service chance × margin. */
export const MAINT_SHOP = {
  /** Highest defect severity each level fixes at own rates: 1 minor, 2 major, 3 grounding. */
  maxSeverity: ["minor", "major", "grounding"] as const,
  trafficChance: [0.025, 0.05, 0.075],
  trafficMarginUsd: 600,
} as const;
/** Cargo terminal: more and better-paying jobs at the airport; handling of traffic freight. */
export const CARGO_TERMINAL = {
  /** Extra jobs on the board at the airport. */
  extraJobs: [4, 8, 12],
  /** Payout factor of jobs from the airport. */
  payoutBonus: [0.05, 0.1, 0.15],
  trafficChance: [0.08, 0.16, 0.24],
  /**
   * Transit cargo stored in the terminal: ground hours that do not count against the
   * job's deadline (docs/ECONOMY.md "Transit cargo").
   */
  transitFreeStorageHours: [4, 8, 12],
  /** Cargo handling revenue = 1.2 × the handling fee × class factor. */
  feeShare: 1.2,
} as const;
/** Ramp & services: landing/parking fee per captured movement; handling; crew lounge. */
export const RAMP = {
  feeUsd: 15,
  levelFactor: [1, 1.15, 1.3],
  /** Share of the airport's movements that use the player's FBO. */
  capture: [0.3, 0.38, 0.46],
  handlingChance: [0.25, 0.32, 0.4],
  /** Crew lounge (level ≥ 2): +1 reputation per own arrival, at most once per in-game day. */
  loungeMinLevel: 2,
  loungeReputation: 1,
} as const;

// ---- modelled traffic ----

/** Movements per day M = 40 × s^1.5. */
export const TRAFFIC_PER_DAY = 40;
export const TRAFFIC_EXPONENT = 1.5;
/** Hour-of-day weights (local = UTC on the company clock), Σ = 24. */
export const HOUR_PROFILE: readonly number[] = [
  0.2, 0.15, 0.1, 0.1, 0.2, 0.5, 1.1, 1.6, 1.8, 1.7, 1.5, 1.4, 1.4, 1.4, 1.5, 1.6, 1.8, 1.8, 1.6,
  1.3, 1.0, 0.7, 0.5, 0.25,
];
export const TRAFFIC_CLASSES = ["piston", "turboprop", "jet"] as const;
export type TrafficClass = (typeof TRAFFIC_CLASSES)[number];
export const CLASS_MIX: Record<"large" | "medium" | "small", Record<TrafficClass, number>> = {
  large: { piston: 0.2, turboprop: 0.4, jet: 0.4 },
  medium: { piston: 0.5, turboprop: 0.4, jet: 0.1 },
  small: { piston: 0.8, turboprop: 0.2, jet: 0 },
};
/** Fee factor (turboprop = 1) and fuel uplift per class. */
export const CLASS_FEE_FACTOR: Record<TrafficClass, number> = {
  piston: 0.5,
  turboprop: 1,
  jet: 3,
};
export const CLASS_UPLIFT_KG: Record<TrafficClass, number> = {
  piston: 120,
  turboprop: 500,
  jet: 2_000,
};
/** Reference handling fee (turboprop movement); the player sets their own. */
export const REFERENCE_HANDLING_USD = 80;
/** Price elasticity: demand e(r) = clamp(1 − 3 × (r − 1), 0, 1.3), r = price ÷ reference. */
export const ELASTICITY = { slope: 3, max: 1.3 } as const;
export const DEFAULT_FUEL_RATIO = 1;
export const FUEL_RATIO_RANGE = { min: 0.7, max: 1.5 } as const;
export const HANDLING_RANGE = { min: 20, max: 300 } as const;

/** AI arrival bonus (sim_ai): ramp fee + handling at the player's price, turboprop class. */
export const AI_ARRIVAL = {
  /** Detection radius around the FBO airport (10 km). */
  radiusM: 10_000,
  /** On ground and slower than this. */
  maxGsKt: 30,
  /** Seen airborne or faster than this within the radius before (a landing, not a parked spawn). */
  movingKt: 40,
  /** An object id is credited once per airport for this long. */
  memoryMs: 6 * 3_600_000,
  /** Plus a fuel sale of this many kg when the FBO has a fuel farm. */
  fuelKg: 400,
} as const;

// ---- dynamic demand ----

export interface DemandEventSpec {
  label: string;
  weight: number;
  days: readonly [number, number];
  payoutPct: number;
  fuelPct: number;
}
export const DEMAND_EVENTS: Record<DemandEventKind, DemandEventSpec> = {
  storm: { label: "Storm", weight: 45, days: [1, 3], payoutPct: 20, fuelPct: 8 },
  festival: { label: "Festival", weight: 30, days: [2, 4], payoutPct: 12, fuelPct: 4 },
  strike: { label: "Strike", weight: 25, days: [2, 5], payoutPct: 30, fuelPct: 15 },
};
export const DEMAND = {
  /** One roll per in-game day (from day 1): chance of a new event. */
  eventChance: 0.5,
  /** Candidate airports: large airports within this distance of the base, plus FBO airports. */
  candidateRadiusNm: 600,
  /** Each delivery into an airport saturates it. */
  deliveryActivity: -0.03,
  /** Each departure with cargo from an airport raises it. */
  departureActivity: 0.01,
  activityMin: -0.15,
  activityMax: 0.1,
  /** Activity decays toward 0 by this share per in-game day. */
  decayPerDay: 0.15,
  /** Job payout factor = clamp(mean of origin and destination index, 0.8, 1.5). */
  factorMin: 0.8,
  factorMax: 1.5,
  /** Storm weather wear on aircraft parked outside, condition points per in-game day. */
  stormWearPerDay: 0.4,
} as const;

// ---- insurance ----

export const INSURANCE = {
  /** Monthly premium = 0.3 % of the hull value × risk. */
  monthlyShare: 0.003,
  /** risk = min(3, 1 + 0.25 × hard landings (180 days) + 1 × crashes (360 days)). */
  hardLandingRisk: 0.25,
  crashRisk: 1,
  hardLandingWindowDays: 180,
  crashWindowDays: 360,
  maxRisk: 3,
  /** A hard landing for risk and claims: peak touchdown G above this. */
  hardLandingG: 1.6,
  coverageShare: 0.8,
  /** Per repair claim. */
  deductible: 2_000,
} as const;

/**
 * Insurer repair loans (plan §7.4: "repossession-free repair loans"): an insured aircraft's
 * repair bill financed by the insurer. Fixed APR below the cheapest bank (Altocirrus 5.5 %),
 * a short term, no origination fee. Missed payments follow the bank rules (late fee,
 * −5 reputation, interest capitalised) but never repossess and never set the default flag;
 * the third consecutive miss cancels the policy and moves the balance to cash.
 */
export const REPAIR_LOAN = {
  lenderId: "insurer",
  lenderName: "Hull insurer",
  /** Percent, fixed. */
  apr: 4,
  minTermMonths: 6,
  maxTermMonths: 24,
  /** Smallest amount the insurer finances, dollars. */
  minAmount: 500,
  /** Consecutive misses that cancel the policy (the balance moves to cash). */
  cancelAfterMisses: 3,
} as const;

// ---- milestones ----

export const MILESTONES = {
  hours: 100,
  /** Consecutive deliveries landed A or better. */
  streak: 5,
  fleet: 3,
  fboNetwork: 3,
} as const;
