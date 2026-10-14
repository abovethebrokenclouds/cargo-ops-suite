// Every economy constant in one place (documented in docs/ECONOMY.md).

import type { CargoKind } from "../../protocol/src/economy";
import type { LandingGrade } from "../../protocol/src/landing";

/** Base rate, dollars per kg per nm (before the distance curve). */
export const RATE_USD_PER_KG_NM = 0.015;
/** Distance curve scale: atan(nm / 25) / atan(1) rises from 0 to 2. */
export const DISTANCE_SCALE_NM = 25;

/**
 * Kind multipliers. Plan §7 lists five values for six kinds (cargo 1.0, fragile 1.3,
 * express 1.5, medical 1.8, hazmat 1.6); bush is set to 1.4 here: above fragile
 * (short unpaved strips) and below the time- or hazard-critical kinds.
 */
export const KIND_MULTIPLIERS: Record<CargoKind, number> = {
  cargo: 1.0,
  fragile: 1.3,
  express: 1.5,
  medical: 1.8,
  hazmat: 1.6,
  bush: 1.4,
};

export const KIND_LABELS: Record<CargoKind, string> = {
  cargo: "General cargo",
  fragile: "Fragile",
  express: "Express",
  medical: "Medical",
  hazmat: "Hazmat",
  bush: "Bush",
};

/** Condition bonuses (plan §7). Not observable yet: IFR and weather need METAR (P5). */
export const CONDITION_BONUS = { ifr: 0.15, night: 0.15, weather: 0.2 } as const;

/** Reputation multiplier per tier: × (1 + 0.02 × tier), tier = floor(reputation / 20). */
export const REPUTATION_STEP = 0.02;
export const REPUTATION_TIER_SIZE = 20;

/**
 * Landing multiplier from the connector's grade. Plan §7 gives five values
 * {1.10, 1.05, 1.00, 0.85, 0.60} for seven grades: A+ → 1.10, A → 1.05,
 * B and C → 1.00, D → 0.85, E and F → 0.60.
 */
export const LANDING_MULTIPLIERS: Record<LandingGrade, number> = {
  "A+": 1.1,
  A: 1.05,
  B: 1.0,
  C: 1.0,
  D: 0.85,
  E: 0.6,
  F: 0.6,
};

/** Multi-unit jobs scale by n^-0.3 (bulk handling discount). */
export const LOAD_SCALING_EXPONENT = -0.3;

/** Late penalty: 10 % of gross per late hour (pro rata), capped at 100 %. */
export const LATE_PENALTY_PER_HOUR = 0.1;

/** Fragile cargo is damaged above this touchdown peak G (plan §7 "G cap 1.5"). */
export const FRAGILE_G_CAP = 1.5;
/** Share of gross deducted when fragile cargo is damaged. */
export const FRAGILE_DAMAGE_SHARE = 0.5;

/** Fuel reserve added to the leg fuel in dispatch checks and the payload limit, minutes. */
export const RESERVE_MIN = 45;
/** Destinations are offered up to this share of the aircraft's range. */
export const RANGE_SHARE = 0.8;
/** Shortest job leg, nm. */
export const MIN_JOB_NM = 20;

/** Express: time limit = flight time at cruise + 45 min (plan §7). */
export const EXPRESS_SLACK_MIN = 45;
/** Medical: flight time × 1.25 + 60 min. */
export const MEDICAL_FACTOR = 1.25;
export const MEDICAL_SLACK_MIN = 60;
/** Everything else: flight time × 2 + 240 min. */
export const STANDARD_FACTOR = 2;
export const STANDARD_SLACK_MIN = 240;

/** Verification (plan §6.4). */
export const START_RADIUS_NM = 3;
export const ARRIVAL_RADIUS_NM = 3;
export const MIN_DISTANCE_SHARE = 0.9;

/** Reputation changes (plan §7). */
export const REPUTATION = {
  cleanTop: 3, // on time, landing A+ or A
  cleanGood: 2, // on time, landing B
  cleanFirm: 1, // on time, landing C (or no grade recorded)
  hardLanding: -5, // landing D, E or F
  perLateHour: -3, // per started late hour
  crash: -20,
  start: 50,
} as const;

/**
 * Transit cargo (docs/ECONOMY.md "Transit cargo"). Long-haul jobs go beyond one leg's direct
 * range (80 % of the aircraft range) up to this multiple of it, so they need a transit stop.
 */
export const LONG_HAUL_MAX_FACTOR = 2;
/**
 * Long-haul chains are searched inside the corridor origin → stop → destination ≤ this
 * multiple of the direct distance (docs/ECONOMY.md "Transit cargo").
 */
export const LONG_HAUL_CORRIDOR = 2;
/** Long-haul jobs the connector adds to every board (drawn after the regular jobs). */
export const LONG_HAUL_JOBS_PER_BOARD = 2;
/** Extra time a long-haul job allows for the transit stop, minutes. */
export const TRANSIT_STOP_SLACK_MIN = 60;
/** Abandoning cargo in transit (job.release of an in-transit job), reputation. */
export const TRANSIT_ABANDON_REPUTATION = -3;

/** Board size and lifetime. */
export const BOARD_SIZE = 24;
export const BOARD_LIFETIME_MIN = 24 * 60;
/** Regenerate the board after this many simulator minutes (in-game time). */
export const BOARD_REFRESH_SIM_MIN = 6 * 60;
/** Share of jobs drawn from the short-leg band ("many short jobs plus a few long ones"). */
export const SHORT_JOB_SHARE = 0.75;
/** Short band: up to 35 % of the maximum job distance (at least 60 nm). */
export const SHORT_BAND_SHARE = 0.35;
export const SHORT_BAND_MIN_NM = 60;

export const STARTING_CASH = 250_000;

/**
 * Payload check (docs/ECONOMY.md "Payload check"): the sim payload may fall short of the
 * cargo by max(PAYLOAD_TOLERANCE_MIN_KG, PAYLOAD_TOLERANCE_SHARE × cargo) before the
 * flight is flagged underloaded.
 */
export const PAYLOAD_TOLERANCE_MIN_KG = 25;
export const PAYLOAD_TOLERANCE_SHARE = 0.1;
/**
 * Crew allowance when no payload station is named like a crew seat and the player has
 * not set one: 0 kg. The sim's pilot is almost always a payload station; a pilot that is
 * not reported is never assumed, so any doubt favours the player.
 */
export const DEFAULT_CREW_ALLOWANCE_KG = 0;
/**
 * Whole (trimmed) station names of pilot seats: only the FIRST matching station counts
 * as crew (a second seat such as "Copilot" may hold cargo or a passenger). Never matches
 * baggage, cargo or compartment stations ("Pilot Baggage" is cargo).
 */
export const PILOT_SEAT_PATTERN = /^(pilot|co-?pilot|captain|first officer)( seat)?( \d+)?$/i;
/** Whole station names of explicit crew seats ("Crew", "Crew Seat 2"): every one counts. */
export const CREW_SEAT_PATTERN = /^crew( seat)?( \d+)?$/i;
