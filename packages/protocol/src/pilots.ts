import { z } from "zod";

// Hired pilots (plan §7.4, P6 optional). A hired pilot flies one of the company's owned
// aircraft back and forth on a fixed route in in-game time, for a monthly wage. This is a
// SIMULATED economy model, not telemetry: nothing here is a flight frame, nothing enters the
// logbook, and nothing counts toward the player's own flying (hours, landing streak, grades).
// Every object carries `simulated: true` so the UI can label it "Hired pilot (simulated)".
// Everything is additive: frames without the `pilots` domain still parse.
// Formulas: docs/ECONOMY.md ("Hired pilots").

const finite = () => z.number().finite();
const icao = () => z.string().min(2).max(8);

/**
 * Type ratings a pilot is hired with: turboprop covers the single, twin and regional
 * turboprops, jet the narrowbody and widebody jets (the catalogue has no pistons).
 */
export const PILOT_RATINGS = ["turboprop", "jet"] as const;
export const pilotRatingSchema = z.enum(PILOT_RATINGS);
export type PilotRating = z.infer<typeof pilotRatingSchema>;

export const PILOT_RATING_LABELS: Record<PilotRating, string> = {
  turboprop: "Turboprop",
  jet: "Jet",
};

/** One simulated leg (booked when it completes). */
export const pilotLegSchema = z.object({
  /** Leg number for this pilot (1-based). */
  n: z.number().int().positive(),
  aircraftId: z.string().min(1),
  registration: z.string(),
  from: icao(),
  to: icao(),
  departGameMs: finite().nonnegative(),
  arriveGameMs: finite().nonnegative(),
  distanceNm: finite().nonnegative(),
  /** Simulated cargo load, kg (seeded share of the leg's payload limit). */
  loadKg: finite().nonnegative(),
  /** What the job board would pay the player for that load on that leg, dollars. */
  boardPayout: finite().nonnegative(),
  /** What the company earns from the hired leg (a share of the board payout), dollars. */
  income: finite().nonnegative(),
  fuel: finite().nonnegative(),
  landingFee: finite().nonnegative(),
  /** Condition points the aircraft lost. */
  wear: finite().nonnegative(),
  /** Defects found after the leg. */
  defects: z.number().int().nonnegative(),
});
export type PilotLeg = z.infer<typeof pilotLegSchema>;

/** Monthly P&L of one pilot (cash lines; wear is shown as its repair value, not cash). */
export const pilotPnlMonthSchema = z.object({
  month: z.number().int().nonnegative(),
  income: finite().nonnegative(),
  wages: finite().nonnegative(),
  fuel: finite().nonnegative(),
  fees: finite().nonnegative(),
  /** income − wages − fuel − fees (cash). */
  net: finite(),
  legs: z.number().int().nonnegative(),
  /** Condition points the assigned aircraft lost (not cash). */
  wear: finite().nonnegative(),
  /** Repair cost equivalent of that wear (not cash; repairs are ordered as usual). */
  wearValue: finite().nonnegative(),
});
export type PilotPnlMonth = z.infer<typeof pilotPnlMonthSchema>;

export const pilotAssignmentSchema = z.object({
  aircraftId: z.string().min(1),
  registration: z.string(),
  typeName: z.string(),
  /** The route's two ends; the pilot flies origin → destination → origin → … */
  origin: icao(),
  destination: icao(),
  distanceNm: finite().nonnegative(),
  sinceGameMs: finite().nonnegative(),
  /** Legs completed on this assignment. */
  legs: z.number().int().nonnegative(),
  /** Next scheduled departure (when no leg is in progress), company-clock ms. */
  nextDepartureGameMs: finite().nonnegative().optional(),
  /** The leg in progress (simulated). */
  leg: z
    .object({
      from: icao(),
      to: icao(),
      departGameMs: finite().nonnegative(),
      arriveGameMs: finite().nonnegative(),
    })
    .optional(),
});
export type PilotAssignment = z.infer<typeof pilotAssignmentSchema>;

export const PILOT_STATUSES = ["unassigned", "scheduled", "flying"] as const;

export const hiredPilotSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  rating: pilotRatingSchema,
  wageMonthly: finite().nonnegative(),
  hiredGameMs: finite().nonnegative(),
  status: z.enum(PILOT_STATUSES),
  assignment: pilotAssignmentSchema.nullable(),
  /** Why the last route stopped (grounded aircraft, defect found, …). */
  stopped: z
    .object({ code: z.string(), message: z.string(), gameMs: finite().nonnegative() })
    .optional(),
  legsFlown: z.number().int().nonnegative(),
  /** Last 12 in-game months, oldest first. */
  pnl: z.array(pilotPnlMonthSchema),
  /** Last legs, newest first. */
  recent: z.array(pilotLegSchema),
  /** Always true: a modelled operation, never telemetry. */
  simulated: z.literal(true),
});
export type HiredPilot = z.infer<typeof hiredPilotSchema>;

/** A destination an aircraft could be assigned to, with its estimated leg economics. */
export const pilotRouteOptionSchema = z.object({
  aircraftId: z.string().min(1),
  registration: z.string(),
  typeName: z.string(),
  rating: pilotRatingSchema,
  origin: icao(),
  destinations: z.array(
    z.object({
      icao: icao(),
      distanceNm: finite().nonnegative(),
      blockMin: finite().nonnegative(),
      /** Board payout for an average simulated load, dollars. */
      boardPayout: finite().nonnegative(),
      /** Hired income per leg at that load, dollars. */
      income: finite().nonnegative(),
      /** Fuel + landing fee per leg at today's prices, dollars. */
      costs: finite().nonnegative(),
    }),
  ),
});
export type PilotRouteOption = z.infer<typeof pilotRouteOptionSchema>;

/** `pilots` state domain. */
export const pilotsDomainSchema = z.object({
  /** Always true: hired pilot operations are simulated economy, not telemetry. */
  simulated: z.literal(true),
  pilots: z.array(hiredPilotSchema),
  /** Airports the company serves (route ends come from here). */
  servedAirports: z.array(icao()),
  /** Owned, available, airworthy aircraft and the routes each could fly. */
  options: z.array(pilotRouteOptionSchema),
  /** Monthly wage by rating, dollars. */
  wages: z.record(pilotRatingSchema, finite().nonnegative()),
  /** Share of the board payout a hired leg earns. */
  payoutShare: finite().min(0).max(1),
  maxPilots: z.number().int().positive(),
  /** This in-game month, every pilot: cash income and costs (wages, fuel, fees). */
  monthIncome: finite().nonnegative(),
  monthCosts: finite().nonnegative(),
});
export type PilotsState = z.infer<typeof pilotsDomainSchema>;

// ---- command arguments ----

export const pilotHireArgsSchema = z.object({ rating: pilotRatingSchema }).strict();
export const pilotFireArgsSchema = z.object({ pilotId: z.string().min(1) }).strict();
export const pilotAssignArgsSchema = z
  .object({
    pilotId: z.string().min(1),
    aircraftId: z.string().min(1),
    /** Optional: must be where the aircraft is parked (the route starts there). */
    origin: icao().optional(),
    destination: icao(),
  })
  .strict();
export const pilotUnassignArgsSchema = pilotFireArgsSchema;
