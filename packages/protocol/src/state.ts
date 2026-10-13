import { z } from "zod";
import { companyDomainSchema, jobsDomainSchema, missionSchema } from "./economy";

// Simulator state domains carried in `snapshot.state` and `delta.patch`.
// Units live in field names (Ft, Kt, Fpm, Deg, Lb, Gal, Pph, Nm, Sec) so no
// client-side conversion is needed. Every domain is optional and nullable in a
// snapshot: absent or null means "no data", never a default value.

const finite = () => z.number().finite();

/** Flight phases (plan §6.2), forward-only in the connector FSM. */
export const FLIGHT_PHASES = [
  "Boarding",
  "TaxiOut",
  "Takeoff",
  "Climb",
  "Cruise",
  "Descent",
  "Approach",
  "Landing",
  "TaxiIn",
  "Arrived",
] as const;
export const flightPhaseSchema = z.enum(FLIGHT_PHASES);
export type FlightPhase = z.infer<typeof flightPhaseSchema>;

/** Simulator link status as seen by the connector. */
export const simDomainSchema = z.object({
  connected: z.boolean(),
  paused: z.boolean(),
  /** SIMULATION RATE multiplier (1 = real time). */
  simRate: finite().positive(),
  /** e.g. "MSFS 2024". */
  name: z.string().optional(),
  /**
   * Simulation clock, seconds since the start of the session or recording: it
   * advances with the sim rate and stops while paused. Optional. Replays that
   * compress time (the synthetic demo fixture) carry it so the connector can time
   * phases and verify speeds honestly; without it the connector uses its receive
   * clock × simRate, stopped while paused.
   */
  simTimeSec: finite().nonnegative().optional(),
});

export const aircraftDomainSchema = z.object({
  /** TITLE simvar. */
  title: z.string(),
  /** ATC ID (tail number), when the aircraft defines one. */
  atcId: z.string().optional(),
});

export const positionDomainSchema = z.object({
  /** Degrees, WGS84. */
  lat: finite().min(-90).max(90),
  /** Degrees, WGS84. */
  lon: finite().min(-180).max(180),
  /** Indicated altitude, feet. */
  altFt: finite(),
  /** Height above ground, feet. */
  aglFt: finite(),
});

export const motionDomainSchema = z.object({
  iasKt: finite(),
  tasKt: finite(),
  gsKt: finite(),
  hdgMagDeg: finite(),
  hdgTrueDeg: finite(),
  vsFpm: finite(),
  gForce: finite(),
  onGround: z.boolean(),
  /**
   * Latched values of the last touchdown as the simulator reports them
   * (PLANE TOUCHDOWN NORMAL VELOCITY ×60, PLANE TOUCHDOWN BANK/PITCH DEGREES).
   * Optional: absent when the simulator does not provide them (and in replays
   * recorded without them). Sign conventions unverified on a real sim.
   */
  touchdownVelocityFpm: finite().optional(),
  touchdownBankDeg: finite().optional(),
  touchdownPitchDeg: finite().optional(),
});

export const fuelDomainSchema = z.object({
  totalGal: finite().nonnegative(),
  totalLb: finite().nonnegative(),
  /** Fuel flow per engine, pounds per hour. */
  flowPph: z.array(finite()),
});

export const weightsDomainSchema = z.object({
  totalLb: finite().nonnegative(),
  emptyLb: finite().nonnegative(),
  maxGrossLb: finite().nonnegative(),
  payloadLb: finite().nonnegative(),
});

export const payloadDomainSchema = z.object({
  stations: z.array(z.object({ name: z.string(), weightLb: finite().nonnegative() })),
});

export const enginesDomainSchema = z.object({
  /** GENERAL ENG COMBUSTION per engine. */
  running: z.array(z.boolean()),
});

export const controlsDomainSchema = z.object({
  parkingBrake: z.boolean(),
});

/** GPS flight plan, best effort (deprecated simvars in MSFS 2024). */
export const planDomainSchema = z.object({
  active: z.boolean(),
  origin: z.string().optional(),
  destination: z.string().optional(),
  wpIndex: z.number().int().nonnegative().optional(),
  wpCount: z.number().int().nonnegative().optional(),
  nextWpId: z.string().optional(),
  nextWpLat: finite().optional(),
  nextWpLon: finite().optional(),
  /** Distance to next waypoint, nautical miles. */
  nextWpDistanceNm: finite().nonnegative().optional(),
  /** Distance to destination, nautical miles. */
  destDistanceNm: finite().nonnegative().optional(),
  /** GPS ETE to destination, seconds. */
  eteSec: finite().nonnegative().optional(),
});

export const FLIGHT_STATUSES = ["active", "completed", "aborted", "failed"] as const;
export const flightStatusSchema = z.enum(FLIGHT_STATUSES);
export type FlightStatus = z.infer<typeof flightStatusSchema>;

/** Verification flags of a tracked flight (plan §6.4). */
export const flightFlagsSchema = z.object({
  /** Position jumped further than ground speed allows (slew, teleport, map move). */
  teleport: z.boolean(),
  /** Sim rate went above 1× at some point: no bonuses. */
  noBonus: z.boolean(),
  /** Sim rate went above 8× at some point: the flight does not count. */
  invalidated: z.boolean(),
  /** The simulator reported a crash. */
  crashed: z.boolean(),
  /** The simulator is paused right now (the mission clock is stopped). */
  paused: z.boolean(),
});
export type FlightFlags = z.infer<typeof flightFlagsSchema>;

/** Tracked flight (connector-side), not the sim's own flight plan. */
export const flightDomainSchema = z.object({
  active: z.boolean(),
  origin: z.string().optional(),
  destination: z.string().optional(),
  plannedDistanceNm: finite().nonnegative().optional(),
  flownDistanceNm: finite().nonnegative().optional(),
  /** Flight clock, seconds (pauses with the sim). */
  elapsedSec: finite().nonnegative().optional(),
  /** Connector-assigned flight id (also the logbook/database id). */
  id: z.string().min(1).optional(),
  status: flightStatusSchema.optional(),
  /** Wall clock at block-out (or at the explicit start), ISO 8601. */
  startedAt: z.string().optional(),
  /** Wall clock when the flight ended, ISO 8601. */
  endedAt: z.string().optional(),
  /** Great-circle distance flown since block-out, integrated at ≤ 1 Hz, nautical miles. */
  distanceNm: finite().nonnegative().optional(),
  /** Sim-time minutes between liftoff and touchdown (pauses excluded). */
  airborneMin: finite().nonnegative().optional(),
  /** Sim-time minutes since block-out (pauses excluded). */
  blockMin: finite().nonnegative().optional(),
  maxAltFt: finite().optional(),
  fuelUsedLb: finite().nonnegative().optional(),
  flags: flightFlagsSchema.optional(),
});

export const phaseDomainSchema = z.object({
  current: flightPhaseSchema,
});

/** Payload of the `phase.changed` event. */
export const phaseChangedSchema = z.object({
  from: flightPhaseSchema,
  to: flightPhaseSchema,
});

/** Placeholder until the weather (P5) and fleet (P4) lanes define these. */
const looseDomain = z.unknown();

/** Active or most recent mission (P3). */
export const missionDomainSchema = missionSchema;

export const simDomainSchemas = {
  sim: simDomainSchema,
  aircraft: aircraftDomainSchema,
  position: positionDomainSchema,
  motion: motionDomainSchema,
  fuel: fuelDomainSchema,
  weights: weightsDomainSchema,
  payload: payloadDomainSchema,
  engines: enginesDomainSchema,
  controls: controlsDomainSchema,
  plan: planDomainSchema,
  flight: flightDomainSchema,
  phase: phaseDomainSchema,
  weather: looseDomain,
  company: companyDomainSchema,
  jobs: jobsDomainSchema,
  mission: missionDomainSchema,
  fleet: looseDomain,
} as const;

export type SimDomain = keyof typeof simDomainSchemas;
export const SIM_DOMAINS = Object.keys(simDomainSchemas) as SimDomain[];

/** Full state carried by a snapshot. Every domain may be absent or null. */
export const simStateSchema = z.object({
  sim: simDomainSchema.nullable().optional(),
  aircraft: aircraftDomainSchema.nullable().optional(),
  position: positionDomainSchema.nullable().optional(),
  motion: motionDomainSchema.nullable().optional(),
  fuel: fuelDomainSchema.nullable().optional(),
  weights: weightsDomainSchema.nullable().optional(),
  payload: payloadDomainSchema.nullable().optional(),
  engines: enginesDomainSchema.nullable().optional(),
  controls: controlsDomainSchema.nullable().optional(),
  plan: planDomainSchema.nullable().optional(),
  flight: flightDomainSchema.nullable().optional(),
  phase: phaseDomainSchema.nullable().optional(),
  weather: looseDomain,
  company: companyDomainSchema.nullable().optional(),
  jobs: jobsDomainSchema.nullable().optional(),
  mission: missionDomainSchema.nullable().optional(),
  fleet: looseDomain,
});

/**
 * Delta patch: each present domain is shallow-merged into the current one.
 * `null` clears the domain; an object may carry only the changed fields.
 */
export const simStatePatchSchema = z.object({
  sim: simDomainSchema.partial().nullable().optional(),
  aircraft: aircraftDomainSchema.partial().nullable().optional(),
  position: positionDomainSchema.partial().nullable().optional(),
  motion: motionDomainSchema.partial().nullable().optional(),
  fuel: fuelDomainSchema.partial().nullable().optional(),
  weights: weightsDomainSchema.partial().nullable().optional(),
  payload: payloadDomainSchema.partial().nullable().optional(),
  engines: enginesDomainSchema.partial().nullable().optional(),
  controls: controlsDomainSchema.partial().nullable().optional(),
  plan: planDomainSchema.partial().nullable().optional(),
  flight: flightDomainSchema.partial().nullable().optional(),
  phase: phaseDomainSchema.partial().nullable().optional(),
  weather: looseDomain,
  company: companyDomainSchema.partial().nullable().optional(),
  jobs: jobsDomainSchema.partial().nullable().optional(),
  mission: missionDomainSchema.partial().nullable().optional(),
  fleet: looseDomain,
});

export type SimDomainState = z.infer<typeof simDomainSchema>;
export type AircraftState = z.infer<typeof aircraftDomainSchema>;
export type PositionState = z.infer<typeof positionDomainSchema>;
export type MotionState = z.infer<typeof motionDomainSchema>;
export type FuelState = z.infer<typeof fuelDomainSchema>;
export type WeightsState = z.infer<typeof weightsDomainSchema>;
export type PayloadState = z.infer<typeof payloadDomainSchema>;
export type EnginesState = z.infer<typeof enginesDomainSchema>;
export type ControlsState = z.infer<typeof controlsDomainSchema>;
export type PlanState = z.infer<typeof planDomainSchema>;
export type FlightState = z.infer<typeof flightDomainSchema>;
export type PhaseState = z.infer<typeof phaseDomainSchema>;
export type SimState = z.infer<typeof simStateSchema>;
export type SimStatePatch = z.infer<typeof simStatePatchSchema>;
