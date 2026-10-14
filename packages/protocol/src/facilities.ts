import { z } from "zod";

// MSFS facilities override (plan §6.1 "Facilities", §8, §14.3). Airport data the connected
// simulator returned for one ICAO through SimConnect's facility API (requestFacilityData),
// converted to the units the app uses. These are NOT telemetry frames: they describe the
// sim's scenery database, are cached by the connector (SQLite `msfs_airports`) and reach the
// web in the `facilities` domain of a live connector only (frame source "sim"). Every field
// is one the simulator returned; nothing is filled in from other data (docs/SIMVARS.md
// "Facility definition").

export const msfsRunwaySchema = z.object({
  /** "09L/27R" from PRIMARY_/SECONDARY_NUMBER + _DESIGNATOR; "" when the sim gave neither. */
  ident: z.string(),
  /** HEADING, degrees true. */
  headingTrueDeg: z.number(),
  /** LENGTH, converted from metres, ft (rounded). */
  lengthFt: z.number().nonnegative(),
  /** WIDTH, converted from metres, ft (rounded). */
  widthFt: z.number().nonnegative(),
  /** SURFACE enum value as the sim returned it. */
  surfaceCode: z.number().int(),
  /** Name of that enum value ("asphalt"), or null when the value is not in the table. */
  surface: z.string().nullable(),
});
export type MsfsRunway = z.infer<typeof msfsRunwaySchema>;

export const msfsAirportSchema = z.object({
  icao: z.string().min(1).max(8),
  /** NAME64; absent when the sim returned an empty name. */
  name: z.string().optional(),
  /** LATITUDE / LONGITUDE, degrees. */
  lat: z.number().min(-90).max(90),
  lon: z.number().min(-180).max(180),
  /** ALTITUDE, converted from metres, ft (rounded). */
  elevFt: z.number(),
  runways: z.array(msfsRunwaySchema),
  /** When the connector received it from the sim (ISO time). */
  fetchedAt: z.string(),
  /** Simulator that answered, e.g. "MSFS 2024". */
  sim: z.string().optional(),
});
export type MsfsAirport = z.infer<typeof msfsAirportSchema>;

/**
 * `facilities` domain: MSFS facility data for the airports the job board, the jobs and the
 * mission refer to (only those the sim returned data for). `source` is always "sim": a
 * replay or the browser demo never has facility data.
 */
export const facilitiesDomainSchema = z.object({
  source: z.literal("sim"),
  airports: z.record(z.string(), msfsAirportSchema),
});
export type FacilitiesState = z.infer<typeof facilitiesDomainSchema>;
