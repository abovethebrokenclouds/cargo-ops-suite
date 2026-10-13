import { z } from "zod";

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

/** Tracked flight (connector-side), not the sim's own flight plan. */
export const flightDomainSchema = z.object({
  active: z.boolean(),
  origin: z.string().optional(),
  destination: z.string().optional(),
  plannedDistanceNm: finite().nonnegative().optional(),
  flownDistanceNm: finite().nonnegative().optional(),
  /** Flight clock, seconds (pauses with the sim). */
  elapsedSec: finite().nonnegative().optional(),
});

export const phaseDomainSchema = z.object({
  current: flightPhaseSchema,
});

/** Placeholder until the economy/weather lanes define these. */
const looseDomain = z.unknown();

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
  company: looseDomain,
  jobs: looseDomain,
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
  company: looseDomain,
  jobs: looseDomain,
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
  company: looseDomain,
  jobs: looseDomain,
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
