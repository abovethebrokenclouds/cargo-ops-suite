import { z } from "zod";
import { AIRCRAFT_TYPE_SOURCES } from "./aircraft-types";
import { companyClockSchema } from "./company";
import { milestoneSchema } from "./fbo";
import { landingGradeSchema } from "./landing";

// Cargo operations (plan §5 P3, §7): jobs, missions, the minimal company and the
// command argument schemas. These domains are produced only by the connector's
// economy engine (or, in the browser-only demo, by the same pure generator with
// every value tagged DEMO). See docs/ECONOMY.md for every formula.

const finite = () => z.number().finite();
const icao = () => z.string().min(2).max(8);

export const CARGO_KINDS = ["cargo", "fragile", "express", "medical", "hazmat", "bush"] as const;
export const cargoKindSchema = z.enum(CARGO_KINDS);
export type CargoKind = z.infer<typeof cargoKindSchema>;

/** One line of a payout breakdown: the factor, its value and a human label. */
export const payoutFactorSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  /** `multiplier` lines multiply the running amount; `deduction` lines are dollars subtracted. */
  kind: z.enum(["base", "multiplier", "deduction"]),
  value: finite(),
  note: z.string().optional(),
});
export type PayoutFactor = z.infer<typeof payoutFactorSchema>;

export const payoutBreakdownSchema = z.object({
  jobId: z.string().optional(),
  /** rate × kg × nm × atan(nm/25)/atan(1), dollars. */
  base: finite(),
  factors: z.array(payoutFactorSchema),
  /** base × every multiplier, dollars. */
  gross: finite(),
  /** Late penalty + damage, dollars. */
  deductions: finite().nonnegative(),
  /** max(0, gross − deductions), rounded to whole dollars. */
  total: finite().nonnegative(),
  /** True for a board estimate (landing 1.00, on time); false for an actual payout. */
  estimate: z.boolean(),
  /** Bonuses removed (sim rate above 1×, or the departure payload check found too little payload). */
  noBonus: z.boolean(),
  /** The departure payload check found the sim payload clearly below the cargo (no bonuses). */
  payloadMismatch: z.boolean().optional(),
  /** Weather bonus included in the conditions line (0.05 IFR, 0.10 LIFR); absent = none. */
  weatherBonus: finite().nonnegative().optional(),
});
export type PayoutBreakdown = z.infer<typeof payoutBreakdownSchema>;

export const JOB_STATUSES = [
  "available",
  "accepted",
  "loaded",
  "delivered",
  "failed",
  "expired",
] as const;
export const jobStatusSchema = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof jobStatusSchema>;

export const jobSchema = z.object({
  id: z.string().min(1),
  status: jobStatusSchema,
  origin: icao(),
  destination: icao(),
  originName: z.string().optional(),
  destinationName: z.string().optional(),
  kind: cargoKindSchema,
  weightKg: finite().positive(),
  /** Number of handling units (pallets, crates); drives the n^-0.3 load scaling. */
  units: z.number().int().positive(),
  /** Great-circle distance origin → destination, nm. */
  distanceNm: finite().positive(),
  /** Time allowed from block-out to delivery, minutes of simulator time. */
  timeLimitMin: finite().positive(),
  /** Aircraft type the job was generated for. */
  aircraftKey: z.string().min(1),
  /** Wall clock, ISO 8601. */
  createdAt: z.string(),
  /** The job leaves the board after this wall-clock time unless accepted. */
  expiresAt: z.string(),
  acceptedAt: z.string().optional(),
  missionId: z.string().optional(),
  /** Board estimate (landing 1.00, on time, current reputation). */
  payoutEstimate: finite().nonnegative(),
  breakdown: payoutBreakdownSchema,
  /**
   * P5 part 2: local demand × own cargo terminal multiplier fixed when the job was
   * generated (absent = 1.00); the delivered payout uses the same factor.
   */
  demandFactor: finite().positive().optional(),
});
export type Job = z.infer<typeof jobSchema>;

export const activeAircraftSchema = z.object({
  typeKey: z.string().min(1),
  name: z.string(),
  source: z.enum(AIRCRAFT_TYPE_SOURCES),
  /** Sim TITLE the type was matched from, when known. */
  title: z.string().optional(),
});
export type ActiveAircraft = z.infer<typeof activeAircraftSchema>;

export const jobBoardSchema = z.object({
  origin: icao(),
  generatedAt: z.string(),
  seed: z.number().int().nonnegative(),
  aircraftKey: z.string().min(1),
  /** Destination the board was asked to include, if any. */
  focus: icao().optional(),
});
export type JobBoard = z.infer<typeof jobBoardSchema>;

/** `jobs` state domain. */
export const jobsDomainSchema = z.object({
  /** Boards whose jobs are on offer, newest first (at most four airports). */
  boards: z.array(jobBoardSchema),
  available: z.array(jobSchema),
  accepted: z.array(jobSchema),
  aircraft: activeAircraftSchema,
});
export type JobsState = z.infer<typeof jobsDomainSchema>;

export const MISSION_STATUSES = [
  "loaded",
  "in_progress",
  "delivered",
  "failed",
  "aborted",
] as const;
export const missionStatusSchema = z.enum(MISSION_STATUSES);
export type MissionStatus = z.infer<typeof missionStatusSchema>;

const reasonSchema = z.object({ code: z.string().min(1), message: z.string() });

/** One operating cost of a flown mission (P4): fuel, landing fee, lease hours. */
export const missionCostSchema = z.object({
  key: z.enum(["fuel", "landing_fee", "lease"]),
  label: z.string(),
  /** Dollars charged (positive number; booked as a negative ledger entry). */
  amount: finite().nonnegative(),
  note: z.string().optional(),
});
export type MissionCost = z.infer<typeof missionCostSchema>;

export const missionPayoutSchema = z.object({
  /** Sum of the job payouts (revenue), dollars. */
  total: finite().nonnegative(),
  jobs: z.array(payoutBreakdownSchema),
  /** Operating costs of the flight (P4; absent in P3 records). */
  costs: z.array(missionCostSchema).optional(),
  /** total − costs (P4), dollars. */
  net: finite().optional(),
});
export type MissionPayout = z.infer<typeof missionPayoutSchema>;

export const PAYLOAD_CHECK_STATUSES = ["ok", "underloaded", "overloaded", "unknown"] as const;
export const payloadCheckStatusSchema = z.enum(PAYLOAD_CHECK_STATUSES);
export type PayloadCheckStatus = z.infer<typeof payloadCheckStatusSchema>;

/**
 * Cargo weight of a mission compared with the payload stations the simulator reports
 * (docs/ECONOMY.md, "Payload check"). `unknown` whenever the sim did not report payload
 * stations: it never penalises. Optional numbers are absent when the sim did not report
 * them; nothing is estimated in their place.
 */
export const payloadCheckSchema = z.object({
  status: payloadCheckStatusSchema,
  /** `preview` while the mission waits for departure; `departure` is frozen at the start. */
  stage: z.enum(["preview", "departure"]),
  /** Where the compared telemetry came from (live simulator, replay or demo). */
  source: z.enum(["sim", "replay", "demo"]),
  /** Cargo the mission requires, kg. */
  cargoKg: finite().nonnegative(),
  /** Sum of every payload station the sim reports, kg. */
  simPayloadKg: finite().nonnegative().optional(),
  /** Pilot/crew allowance subtracted from the station sum, kg. */
  crewKg: finite().nonnegative().optional(),
  /** stations: first pilot seat + crew seats; setting: the company setting; default: none (0 kg). */
  crewBasis: z.enum(["stations", "setting", "default"]).optional(),
  /** simPayloadKg − crewKg (never below 0), kg. */
  loadedKg: finite().nonnegative().optional(),
  /** Allowed shortfall below the cargo weight, kg. */
  toleranceKg: finite().nonnegative(),
  /** TOTAL WEIGHT and MAX GROSS WEIGHT when the sim reports them, pounds. */
  totalLb: finite().nonnegative().optional(),
  maxGrossLb: finite().nonnegative().optional(),
  message: z.string(),
  /** Wall clock of the check, ISO 8601. */
  checkedAt: z.string(),
});
export type PayloadCheck = z.infer<typeof payloadCheckSchema>;

export const WEATHER_FLIGHT_CATEGORIES = ["VFR", "MVFR", "IFR", "LIFR"] as const;

/**
 * METAR flight category at one end of a mission, frozen when it happened: the origin at
 * departure, the destination at arrival (docs/ECONOMY.md, "Weather bonus"). Only a live,
 * current report under simulator telemetry is `eligible`; sample reports, replay/demo
 * telemetry, stale or missing reports never earn a bonus (and never cost anything).
 */
export const weatherCheckSchema = z.object({
  stage: z.enum(["departure", "arrival"]),
  station: icao(),
  /** FAA flight category of the report; null = unknown (no report or not decodable). */
  category: z.enum(WEATHER_FLIGHT_CATEGORIES).nullable(),
  /** live = aviationweather.gov; sample = built-in example (never real weather); null = none. */
  metarOrigin: z.enum(["live", "sample"]).nullable(),
  /** Telemetry source when the check was frozen (live simulator, replay or demo). */
  source: z.enum(["sim", "replay", "demo"]),
  /** Raw METAR text, observation time and fetch time of the report used (null = none). */
  rawText: z.string().nullable(),
  observedAt: z.string().nullable(),
  fetchedAt: z.string().nullable(),
  /** This end may count toward the weather bonus. */
  eligible: z.boolean(),
  message: z.string(),
  /** Wall clock of the check, ISO 8601. */
  checkedAt: z.string(),
});
export type WeatherCheck = z.infer<typeof weatherCheckSchema>;

export const missionWeatherSchema = z.object({
  departure: weatherCheckSchema.optional(),
  arrival: weatherCheckSchema.optional(),
  /** Bonus fraction actually applied to the payout at delivery (0 when bonuses were removed). */
  bonus: finite().nonnegative().optional(),
});
export type MissionWeather = z.infer<typeof missionWeatherSchema>;

export const missionSchema = z.object({
  id: z.string().min(1),
  status: missionStatusSchema,
  origin: icao(),
  destination: icao(),
  jobIds: z.array(z.string().min(1)).min(1),
  jobs: z.array(jobSchema),
  aircraftKey: z.string().min(1),
  payloadKg: finite().nonnegative(),
  /** Great-circle origin → destination, nm. */
  distanceNm: finite().positive(),
  /** Tightest time limit among the jobs, minutes from block-out. */
  timeLimitMin: finite().positive(),
  /** Sum of the board estimates. */
  expectedPayout: finite().nonnegative(),
  createdAt: z.string(),
  startedAt: z.string().optional(),
  endedAt: z.string().optional(),
  flightId: z.string().optional(),
  /** Distance flown so far / in total, nm. */
  flownNm: finite().nonnegative().optional(),
  /** Simulator minutes since block-out (pauses excluded). */
  elapsedMin: finite().nonnegative().optional(),
  /** Why the mission could not start at the last departure attempt. */
  startBlocked: reasonSchema.optional(),
  failure: reasonSchema.optional(),
  landingGrade: landingGradeSchema.optional(),
  payout: missionPayoutSchema.optional(),
  reputationDelta: finite().optional(),
  /** Fleet aircraft the mission is flown with (P4). */
  aircraftId: z.string().optional(),
  registration: z.string().optional(),
  /** Costs charged when the flight ended without a payout (P4). */
  costs: z.array(missionCostSchema).optional(),
  /** Condition lost on this flight, percentage points (P4). */
  wear: finite().nonnegative().optional(),
  /** Cargo vs sim payload: live preview while loaded, frozen at departure. */
  payloadCheck: payloadCheckSchema.optional(),
  /** METAR flight category at departure (origin) and arrival (destination); weather bonus. */
  weather: missionWeatherSchema.optional(),
});
export type Mission = z.infer<typeof missionSchema>;

/** `company` state domain. P4 fields are optional so P3 frames still parse. */
export const companyDomainSchema = z.object({
  name: z.string().min(1),
  base: icao(),
  cash: finite(),
  reputation: finite().min(0).max(100),
  /** floor(reputation / 20), 0–5. */
  reputationTier: z.number().int().min(0).max(5),
  /** Tier name (Startup … Elite). */
  tierName: z.string().optional(),
  /** Credit score 0–850. */
  creditScore: z.number().int().min(0).max(850).optional(),
  /** cash + owned aircraft value − debt. */
  netWorth: finite().optional(),
  /** Outstanding loan principal. */
  debt: finite().nonnegative().optional(),
  startingCash: finite().optional(),
  clock: companyClockSchema.optional(),
  /** P5 part 2: every milestone, reached or not, with the date it was reached. */
  milestones: z.array(milestoneSchema).optional(),
  /** Payload check crew allowance set by the player, kg; null = automatic. */
  crewAllowanceKg: finite().nonnegative().nullable().optional(),
});
export type CompanyState = z.infer<typeof companyDomainSchema>;

// ---- command arguments ----

export const jobsRefreshArgsSchema = z
  .object({
    /** Board airport; defaults to the aircraft's airport, else the company base. */
    airport: icao().optional(),
    /** Ask for jobs to this destination (when the aircraft can serve it). */
    destination: icao().optional(),
  })
  .strict();
export const jobIdArgsSchema = z.object({ jobId: z.string().min(1) }).strict();
export const missionLoadArgsSchema = z
  .object({ jobIds: z.array(z.string().min(1)).min(1).max(20) })
  .strict();
export const settingsUpdateArgsSchema = z
  .object({
    /** Aircraft type override key; null returns to TITLE auto-match. */
    aircraftType: z.string().min(1).nullable().optional(),
    /** Company base ICAO. */
    base: icao().optional(),
    /** Payload check pilot/crew allowance, kg; null returns to automatic. */
    crewAllowanceKg: finite().min(0).max(2000).nullable().optional(),
  })
  .strict();
