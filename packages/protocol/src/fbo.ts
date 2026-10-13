import { z } from "zod";

// P5 part 2 (plan §7.3, §7.4): FBO ownership, dynamic demand, hull insurance and
// milestones. Everything here is additive: P5-part-1 frames without these domains or
// fields still parse. Formulas: docs/ECONOMY.md ("P5 — FBOs, demand, insurance, milestones").

const finite = () => z.number().finite();
const icao = () => z.string().min(2).max(8);

// ---- FBOs ----

/** Module kinds in display order. */
export const FBO_MODULE_KINDS = ["fuel", "hangar", "maintenance", "cargo", "ramp"] as const;
export const fboModuleKindSchema = z.enum(FBO_MODULE_KINDS);
export type FboModuleKind = z.infer<typeof fboModuleKindSchema>;

export const FBO_MODULE_LABELS: Record<FboModuleKind, string> = {
  fuel: "Fuel farm",
  hangar: "Hangar",
  maintenance: "Maintenance shop",
  cargo: "Cargo terminal",
  ramp: "Ramp & services",
};

export const FBO_STATUSES = ["building", "active"] as const;
export const FBO_ORIGINS = ["bought", "built"] as const;
/** Where an FBO transaction came from: the player's own flights, the modelled traffic
 * stream, or AI aircraft observed in the connected simulator (a bonus). */
export const FBO_SOURCES = ["own", "modelled", "sim_ai"] as const;
export const fboSourceSchema = z.enum(FBO_SOURCES);
export type FboSource = z.infer<typeof fboSourceSchema>;

export const fboModuleSchema = z.object({
  kind: fboModuleKindSchema,
  label: z.string(),
  /** 0 = not installed, 1–3. */
  level: z.number().int().min(0).max(3),
  /** Monthly upkeep at the current level, dollars. */
  upkeepMonthly: finite().nonnegative(),
  /** Cost of the next level (purchase at level 0), null at level 3. */
  nextCost: finite().nonnegative().nullable(),
  /** In-game days the next level takes to install. */
  nextDays: finite().nonnegative().nullable(),
  /** Install/upgrade in progress. */
  pending: z
    .object({
      toLevel: z.number().int().min(1).max(3),
      cost: finite().nonnegative(),
      readyAtGameMs: finite().nonnegative(),
    })
    .optional(),
  /** What the current level does, in words. */
  effect: z.string(),
});
export type FboModule = z.infer<typeof fboModuleSchema>;

export const fboDaySchema = z.object({
  /** In-game day index (0 = founding day). */
  day: z.number().int().nonnegative(),
  own: finite(),
  modelled: finite(),
  simAi: finite(),
  /** Modelled movements handled that day. */
  movements: z.number().int().nonnegative(),
});
export type FboDay = z.infer<typeof fboDaySchema>;

export const fboPnlMonthSchema = z.object({
  month: z.number().int().nonnegative(),
  /** Cash income (modelled traffic + sim AI bonuses), dollars. */
  income: finite(),
  /** Module upkeep + land lease, dollars (positive). */
  upkeep: finite().nonnegative(),
  /** Savings on the player's own flights (fuel at cost, waived fees); not cash. */
  savings: finite().nonnegative(),
  /** income − upkeep. */
  net: finite(),
});
export type FboPnlMonth = z.infer<typeof fboPnlMonthSchema>;

export const fboQueueItemSchema = z.object({
  kind: z.enum(["construction", "module"]),
  module: fboModuleKindSchema.optional(),
  toLevel: z.number().int().min(1).max(3).optional(),
  label: z.string(),
  readyAtGameMs: finite().nonnegative(),
});

export const fboSchema = z.object({
  id: z.string().min(1),
  icao: icao(),
  name: z.string(),
  airportType: z.enum(["large", "medium", "small"]),
  lat: finite(),
  lon: finite(),
  status: z.enum(FBO_STATUSES),
  origin: z.enum(FBO_ORIGINS),
  acquiredGameMs: finite().nonnegative(),
  /** Construction completes at this company-clock time (building only). */
  readyAtGameMs: finite().nonnegative().optional(),
  /** Purchase price or construction cost, dollars. */
  price: finite().nonnegative(),
  /** Price + every module purchase and upgrade, dollars. */
  invested: finite().nonnegative(),
  /** Book value (collateral, net worth), dollars. */
  value: finite().nonnegative(),
  financed: z.boolean(),
  loanId: z.string().optional(),
  /** Built FBOs pay a monthly land lease. */
  landLeaseMonthly: finite().nonnegative(),
  /** Module upkeep + land lease per in-game month, dollars. */
  upkeepMonthly: finite().nonnegative(),
  /** Airport size score (type × runway × scheduled service). */
  sizeFactor: finite().nonnegative(),
  /** Modelled movements per in-game day at this airport. */
  movementsPerDay: finite().nonnegative(),
  modules: z.array(fboModuleSchema),
  pricing: z.object({
    /** Player price ÷ the airport's regional fuel price. */
    fuelPriceRatio: finite().positive(),
    fuelUsdPerKg: finite().nonnegative(),
    regionalUsdPerKg: finite().nonnegative(),
    /** The fuel farm's cost (own aircraft are fuelled at this price). */
    costUsdPerKg: finite().nonnegative(),
    handlingFeeUsd: finite().nonnegative(),
    referenceHandlingUsd: finite().positive(),
    /** Elasticity multipliers at the current prices (1 = reference demand). */
    fuelDemand: finite().nonnegative(),
    handlingDemand: finite().nonnegative(),
  }),
  occupancy: z.object({
    bays: z.number().int().nonnegative(),
    owned: z.number().int().nonnegative(),
    rented: z.number().int().nonnegative(),
    /** (owned + rented) / bays, 0–1 (0 without a hangar). */
    ratio: finite().min(0).max(1),
  }),
  /** Accrued today (modelled income is posted to the ledger at the day boundary). */
  today: z.object({
    own: finite(),
    modelled: finite(),
    simAi: finite(),
    movements: z.number().int().nonnegative(),
  }),
  /** Last 30 in-game days, oldest first. */
  daily: z.array(fboDaySchema),
  /** Last 12 in-game months, oldest first. */
  pnl: z.array(fboPnlMonthSchema),
  queue: z.array(fboQueueItemSchema),
  /** AI arrivals credited from the connected simulator so far. */
  aiArrivals: z.number().int().nonnegative(),
});
export type FboState = z.infer<typeof fboSchema>;

/** `fbos` state domain. */
export const fbosDomainSchema = z.object({
  fbos: z.array(fboSchema),
  /** This in-game month, every FBO: cash income and upkeep, dollars. */
  monthIncome: finite(),
  monthUpkeep: finite().nonnegative(),
  /** Σ FBO book value, dollars. */
  value: finite().nonnegative(),
});
export type FbosState = z.infer<typeof fbosDomainSchema>;

/** Purchase/build quote for an airport (the buy/build flow; pure, also computed in the browser). */
export const fboQuoteSchema = z.object({
  icao: icao(),
  sizeFactor: finite().nonnegative(),
  buyPrice: finite().nonnegative(),
  buildCost: finite().nonnegative(),
  landLeaseMonthly: finite().nonnegative(),
  buildDays: z.number().int().positive(),
  movementsPerDay: finite().nonnegative(),
});
export type FboQuote = z.infer<typeof fboQuoteSchema>;

// ---- dynamic demand ----

export const DEMAND_EVENT_KINDS = ["storm", "festival", "strike"] as const;
export const demandEventKindSchema = z.enum(DEMAND_EVENT_KINDS);
export type DemandEventKind = z.infer<typeof demandEventKindSchema>;

export const demandEventSchema = z.object({
  id: z.string().min(1),
  icao: icao(),
  kind: demandEventKindSchema,
  label: z.string(),
  startGameMs: finite().nonnegative(),
  endGameMs: finite().nonnegative(),
  /** Job payout uplift at the airport, percent. */
  payoutPct: finite(),
  /** Fuel price uplift at the airport, percent. */
  fuelPct: finite(),
});
export type DemandEvent = z.infer<typeof demandEventSchema>;

export const demandIndexSchema = z.object({
  icao: icao(),
  /** 1 = normal; > 1 pays more (events), < 1 saturated by the player's deliveries. */
  index: finite().positive(),
  /** Activity part (decays back to 0). */
  activity: finite(),
  eventId: z.string().optional(),
});
export type DemandIndex = z.infer<typeof demandIndexSchema>;

/** `demand` state domain: airports whose index differs from 1, and active events. */
export const demandDomainSchema = z.object({
  indices: z.array(demandIndexSchema),
  events: z.array(demandEventSchema),
});
export type DemandState = z.infer<typeof demandDomainSchema>;

// ---- insurance ----

export const insuranceStateSchema = z.object({
  insured: z.boolean(),
  /** Monthly premium (current policy, or the quote when uninsured), dollars. */
  premiumMonthly: finite().nonnegative(),
  /** Risk multiplier from recent hard landings and crashes (1–3). */
  riskFactor: finite().positive(),
  /** Share of a write-off or an incident repair the policy pays. */
  coverageShare: finite().min(0).max(1),
  /** Per repair claim, dollars. */
  deductible: finite().nonnegative(),
  sinceGameMs: finite().nonnegative().optional(),
  claims: z.number().int().nonnegative(),
  claimsPaid: finite().nonnegative(),
});
export type InsuranceState = z.infer<typeof insuranceStateSchema>;

// ---- milestones ----

export const MILESTONE_IDS = [
  "first_delivery",
  "hours_100",
  "first_fbo",
  "debt_free",
  "landing_streak",
  "first_restoration",
  "fleet_three",
  "fbo_network",
] as const;
export const milestoneIdSchema = z.enum(MILESTONE_IDS);
export type MilestoneId = z.infer<typeof milestoneIdSchema>;

export const milestoneSchema = z.object({
  id: milestoneIdSchema,
  title: z.string(),
  description: z.string(),
  reached: z.boolean(),
  /** Company-clock time it was reached, ms. */
  gameMs: finite().nonnegative().optional(),
  /** Wall clock, ISO 8601. */
  at: z.string().optional(),
});
export type Milestone = z.infer<typeof milestoneSchema>;

// ---- command arguments ----

const financingSchema = z
  .object({
    lenderId: z.string().min(1),
    termMonths: z.number().int().positive(),
    principal: z.number().finite().positive(),
  })
  .strict();

export const fboBuyArgsSchema = z
  .object({ icao: icao(), financing: financingSchema.optional() })
  .strict();
export const fboBuildArgsSchema = fboBuyArgsSchema;
export const fboSellArgsSchema = z.object({ fboId: z.string().min(1) }).strict();
export const fboModuleArgsSchema = z
  .object({ fboId: z.string().min(1), module: fboModuleKindSchema })
  .strict();
export const fboModuleBuyArgsSchema = fboModuleArgsSchema;
export const fboModuleUpgradeArgsSchema = fboModuleArgsSchema;
export const fboPricingArgsSchema = z
  .object({
    fboId: z.string().min(1),
    /** 0.7–1.5 × the regional fuel price. */
    fuelPriceRatio: z.number().finite().min(0.7).max(1.5).optional(),
    /** $20–$300 per turboprop-equivalent movement. */
    handlingFeeUsd: z.number().finite().min(20).max(300).optional(),
  })
  .strict();
export const insuranceArgsSchema = z.object({ aircraftId: z.string().min(1) }).strict();
export const insuranceBuyArgsSchema = insuranceArgsSchema;
export const insuranceCancelArgsSchema = insuranceArgsSchema;
