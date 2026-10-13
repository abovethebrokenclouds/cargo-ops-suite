import { z } from "zod";

// P5 used aircraft and airworthiness (plan §7.1): per-airframe systems with a condition
// and defects, the airworthiness gate, annual inspections, ferry permits, the maintenance
// queue and the used aircraft market. Everything here is additive: P4 fleet frames without
// these fields still parse, and the P4 `condition` stays (it is now the weighted mean of
// the systems). Formulas: docs/ECONOMY.md ("P5 — used aircraft and airworthiness").

const finite = () => z.number().finite();
const icao = () => z.string().min(2).max(8);

/** Tracked systems of every airframe, in display order. */
export const SYSTEM_KEYS = [
  "engines",
  "propeller",
  "airframe",
  "gear",
  "avionics",
  "electrical",
  "fuel",
  "hydraulics",
  "cargo",
  "interior",
] as const;
export const systemKeySchema = z.enum(SYSTEM_KEYS);
export type SystemKey = z.infer<typeof systemKeySchema>;

export const SYSTEM_LABELS: Record<SystemKey, string> = {
  engines: "Engine(s)",
  propeller: "Propeller / thrust reversers",
  airframe: "Airframe / structure",
  gear: "Landing gear & brakes",
  avionics: "Avionics",
  electrical: "Electrical",
  fuel: "Fuel system",
  hydraulics: "Hydraulics",
  cargo: "Cargo hold / door",
  interior: "Interior / paint",
};

export const DEFECT_SEVERITIES = ["cosmetic", "minor", "major", "grounding"] as const;
export const defectSeveritySchema = z.enum(DEFECT_SEVERITIES);
export type DefectSeverity = z.infer<typeof defectSeveritySchema>;

/** How a defect came to exist. */
export const DEFECT_CAUSES = [
  "listing",
  "purchase",
  "wear",
  "hard_landing",
  "overspeed",
  "fuel_exhaustion",
  "crash",
  "escalation",
] as const;
export const defectCauseSchema = z.enum(DEFECT_CAUSES);
export type DefectCause = z.infer<typeof defectCauseSchema>;

export const defectSchema = z.object({
  id: z.string().min(1),
  system: systemKeySchema,
  severity: defectSeveritySchema,
  title: z.string(),
  /** Repair cost at a maintenance-capable airport, dollars (field repairs cost more). */
  repairCost: finite().nonnegative(),
  /** Downtime at a maintenance-capable airport, in-game hours (field repairs take longer). */
  downtimeHours: finite().nonnegative(),
  /** Not yet discovered. Hidden defects are never sent to the browser. */
  hidden: z.boolean(),
  cause: defectCauseSchema,
  /** Company-clock time it was found, ms. */
  foundGameMs: finite().nonnegative().optional(),
  /** Extra fuel burn, percent (minor 1 %, major 5–15 %). */
  fuelBurnPct: finite().nonnegative().optional(),
  /** Max payload reduction, percent (major only). */
  payloadPct: finite().nonnegative().optional(),
  /** Minor defects only: deferred (MEL) at this airframe-hours reading. */
  deferredAtHours: finite().nonnegative().optional(),
  /** Flight hours left on the deferral (negative = expired). */
  deferralHoursLeft: finite().optional(),
});
export type Defect = z.infer<typeof defectSchema>;

export const systemStateSchema = z.object({
  key: systemKeySchema,
  label: z.string(),
  /** 0–100 %; dispatch needs every system ≥ 20 %. */
  condition: finite().min(0).max(100),
  /** Known defects (hidden ones are not listed). */
  defects: z.array(defectSchema),
});
export type SystemState = z.infer<typeof systemStateSchema>;

export const AIRWORTHINESS_STATUSES = [
  "airworthy",
  "grounded",
  "ferry_only",
  "annual_due",
] as const;
export const airworthinessStatusSchema = z.enum(AIRWORTHINESS_STATUSES);
export type AirworthinessStatus = z.infer<typeof airworthinessStatusSchema>;

/** Why an aircraft may not be dispatched. */
export const GATE_REASON_CODES = [
  "grounding_defect",
  "minor_not_deferred",
  "deferral_expired",
  "system_below_minimum",
  "annual_due",
] as const;
export const gateReasonSchema = z.object({
  code: z.enum(GATE_REASON_CODES),
  message: z.string(),
  system: systemKeySchema.optional(),
  defectId: z.string().optional(),
});
export type GateReason = z.infer<typeof gateReasonSchema>;

export const annualStateSchema = z.object({
  lastGameMs: finite().nonnegative(),
  lastHours: finite().nonnegative(),
  /** Due at this company-clock time (12 in-game months after the last one). */
  dueGameMs: finite().nonnegative(),
  /** Due at this airframe-hours reading (100 flight hours after the last one). */
  dueHours: finite().nonnegative(),
  due: z.boolean(),
  /** Due within 30 in-game days or 10 flight hours. */
  soon: z.boolean(),
  /** Cost and in-game hours of the inspection where the aircraft is parked. */
  cost: finite().nonnegative(),
  hours: finite().nonnegative(),
});
export type AnnualState = z.infer<typeof annualStateSchema>;

export const ferryPermitSchema = z.object({
  origin: icao(),
  destination: icao(),
  distanceNm: finite().nonnegative(),
  /** Payload the ferry flight may carry, kg (crew and baggage, no cargo). */
  payloadCapKg: finite().nonnegative(),
  issuedGameMs: finite().nonnegative(),
  fee: finite().nonnegative(),
});
export type FerryPermit = z.infer<typeof ferryPermitSchema>;

export const MAINTENANCE_KINDS = ["overhaul", "defect", "annual"] as const;
export const maintenanceOrderSchema = z.object({
  id: z.string().min(1),
  aircraftId: z.string().min(1),
  registration: z.string().optional(),
  kind: z.enum(MAINTENANCE_KINDS),
  /** Defects repaired by this order. */
  defectIds: z.array(z.string()),
  label: z.string(),
  airport: icao(),
  /** maintenance = maintenance-capable airport rates; field = elsewhere (dearer, slower). */
  shop: z.enum(["maintenance", "field"]),
  cost: finite().nonnegative(),
  hours: finite().nonnegative(),
  startGameMs: finite().nonnegative(),
  readyAtGameMs: finite().nonnegative(),
});
export type MaintenanceOrder = z.infer<typeof maintenanceOrderSchema>;

/** P5 fields of a fleet aircraft (all optional in the fleet schema for P4 compatibility). */
export const airworthinessSchema = z.object({
  status: airworthinessStatusSchema,
  /** Every reason the aircraft may not be dispatched now (empty when airworthy). */
  reasons: z.array(gateReasonSchema),
  /** A ferry permit can be issued (no grounding defect and a reason to ferry). */
  ferryEligible: z.boolean(),
  /** Payload reduction from major defects, percent. */
  payloadPenaltyPct: finite().nonnegative(),
  /** Extra fuel burn from minor and major defects, percent. */
  fuelPenaltyPct: finite().nonnegative(),
});
export type Airworthiness = z.infer<typeof airworthinessSchema>;

// ---- used market ----

export const INSPECTION_STATUSES = ["none", "pending", "done"] as const;

export const marketListingSchema = z.object({
  id: z.string().min(1),
  typeKey: z.string().min(1),
  typeName: z.string(),
  category: z.string(),
  ageYears: finite().nonnegative(),
  hours: finite().nonnegative(),
  cycles: z.number().int().nonnegative(),
  location: icao(),
  /** Great circle from the company base, nm. */
  distanceFromBaseNm: finite().nonnegative(),
  askingPrice: finite().positive(),
  catalogPrice: finite().positive(),
  /** Weighted mean of the system conditions, percent. */
  condition: finite().min(0).max(100),
  systems: z.array(z.object({ key: systemKeySchema, condition: finite().min(0).max(100) })),
  /** Defects the seller disclosed or the inspection found (hidden ones are not listed). */
  knownDefects: z.array(defectSchema),
  sellerNote: z.string(),
  inspection: z.object({
    status: z.enum(INSPECTION_STATUSES),
    /** ≈ 0.5 % of the asking price. */
    fee: finite().nonnegative(),
    readyAtGameMs: finite().nonnegative().optional(),
    /** Defects the completed inspection revealed. */
    found: z.number().int().nonnegative().optional(),
  }),
  /** Reputation tier needed to buy this type. */
  purchaseMinTier: z.number().int().min(0).max(5),
  listedGameMs: finite().nonnegative(),
});
export type MarketListing = z.infer<typeof marketListingSchema>;

/** `market` state domain (used aircraft listings). */
export const marketDomainSchema = z.object({
  listings: z.array(marketListingSchema),
  /** Generation counter (part of the listing seed). */
  generation: z.number().int().nonnegative(),
  refreshedGameMs: finite().nonnegative(),
  nextRefreshGameMs: finite().nonnegative(),
});
export type MarketState = z.infer<typeof marketDomainSchema>;

// ---- command arguments ----

const financingSchema = z
  .object({
    lenderId: z.string().min(1),
    termMonths: z.number().int().positive(),
    principal: z.number().finite().positive(),
  })
  .strict();

export const marketRefreshArgsSchema = z.object({}).strict();
export const marketInspectArgsSchema = z.object({ listingId: z.string().min(1) }).strict();
export const marketBuyArgsSchema = z
  .object({ listingId: z.string().min(1), financing: financingSchema.optional() })
  .strict();
export const fleetDefectArgsSchema = z
  .object({ aircraftId: z.string().min(1), defectId: z.string().min(1) })
  .strict();
export const fleetRepairDefectArgsSchema = fleetDefectArgsSchema;
export const fleetDeferArgsSchema = fleetDefectArgsSchema;
export const fleetAircraftArgsSchema = z.object({ aircraftId: z.string().min(1) }).strict();
export const fleetRepairAllArgsSchema = fleetAircraftArgsSchema;
export const fleetAnnualArgsSchema = fleetAircraftArgsSchema;
export const fleetFerryPermitArgsSchema = fleetAircraftArgsSchema;
