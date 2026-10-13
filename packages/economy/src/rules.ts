// Mission rules (plan §6.4, §7): dispatch limits, start and leg verification, time
// limits and reputation. Pure functions; the connector feeds them real telemetry.

import type { AircraftType } from "../../protocol/src/aircraft-types";
import type { CargoKind } from "../../protocol/src/economy";
import type { LandingGrade } from "../../protocol/src/landing";
import {
  ARRIVAL_RADIUS_NM,
  EXPRESS_SLACK_MIN,
  MEDICAL_FACTOR,
  MEDICAL_SLACK_MIN,
  MIN_DISTANCE_SHARE,
  RANGE_SHARE,
  REPUTATION,
  RESERVE_MIN,
  STANDARD_FACTOR,
  STANDARD_SLACK_MIN,
  START_RADIUS_NM,
} from "./constants";
import { greatCircleNm, round1, type LatLon } from "./geo";

/** Fuel for a leg at cruise plus the 45-minute reserve, kg. */
export function legFuelKg(aircraft: AircraftType, distanceNm: number): number {
  return aircraft.fuelBurnKgH * (distanceNm / aircraft.cruiseKt + RESERVE_MIN / 60);
}

/** Payload limit for a leg: max payload − leg fuel (plan §7), kg, never below 0. */
export function payloadLimitKg(aircraft: AircraftType, distanceNm: number): number {
  return Math.max(0, Math.floor(aircraft.maxPayloadKg - legFuelKg(aircraft, distanceNm)));
}

export function maxJobDistanceNm(aircraft: AircraftType): number {
  return aircraft.rangeNm * RANGE_SHARE;
}

/** Minutes allowed from block-out to delivery for a job. */
export function timeLimitMin(kind: CargoKind, distanceNm: number, cruiseKt: number): number {
  const flightMin = (distanceNm / cruiseKt) * 60;
  let limit: number;
  if (kind === "express") limit = flightMin + EXPRESS_SLACK_MIN;
  else if (kind === "medical") limit = flightMin * MEDICAL_FACTOR + MEDICAL_SLACK_MIN;
  else limit = flightMin * STANDARD_FACTOR + STANDARD_SLACK_MIN;
  return Math.ceil(limit / 5) * 5;
}

export type RuleResult = { ok: true } | { ok: false; code: string; message: string };

/** Start rule: within 3 nm of the origin airport. */
export function checkAtOrigin(
  position: LatLon | null,
  origin: LatLon & { ident: string },
): RuleResult {
  if (!position) return { ok: false, code: "no_data", message: "No aircraft position yet" };
  const d = greatCircleNm(position, origin);
  if (d > START_RADIUS_NM) {
    return {
      ok: false,
      code: "not_at_origin",
      message: `The aircraft is ${round1(d)} nm from ${origin.ident}; start within ${START_RADIUS_NM} nm of the origin`,
    };
  }
  return { ok: true };
}

export interface LegInput {
  origin: LatLon;
  destination: LatLon & { ident: string };
  flownNm: number;
  /** Position when the flight ended (parked), or null when unknown. */
  arrival: LatLon | null;
  flags: { teleport: boolean; invalidated: boolean; crashed: boolean };
}

/** Leg verification (plan §6.4): first failing rule wins. */
export function verifyLeg(input: LegInput): RuleResult {
  if (input.flags.crashed) {
    return { ok: false, code: "crashed", message: "The aircraft crashed" };
  }
  if (input.flags.invalidated) {
    return {
      ok: false,
      code: "invalidated",
      message: "The sim rate went above 8×: the flight does not count",
    };
  }
  if (input.flags.teleport) {
    return {
      ok: false,
      code: "teleport",
      message: "The position jumped further than the ground speed allows (slew or teleport)",
    };
  }
  const route = greatCircleNm(input.origin, input.destination);
  if (input.flownNm < route * MIN_DISTANCE_SHARE) {
    return {
      ok: false,
      code: "short_distance",
      message: `Flown ${round1(input.flownNm)} nm is less than 90 % of the ${round1(route)} nm route`,
    };
  }
  if (!input.arrival) {
    return { ok: false, code: "no_position", message: "No arrival position" };
  }
  const off = greatCircleNm(input.arrival, input.destination);
  if (off > ARRIVAL_RADIUS_NM) {
    return {
      ok: false,
      code: "not_at_destination",
      message: `Parked ${round1(off)} nm from ${input.destination.ident}; arrival must be within ${ARRIVAL_RADIUS_NM} nm`,
    };
  }
  return { ok: true };
}

const HARD: ReadonlySet<LandingGrade> = new Set<LandingGrade>(["D", "E", "F"]);
const TOP: ReadonlySet<LandingGrade> = new Set<LandingGrade>(["A+", "A"]);

/**
 * Reputation change for a delivery: a hard landing (D/E/F) costs 5; otherwise an on-time
 * delivery earns +3 (A+/A), +2 (B) or +1 (C or no grade); late deliveries earn nothing and
 * lose 3 per started late hour.
 */
export function deliveryReputationDelta(grade: LandingGrade | null, lateMin: number): number {
  const lateHours = lateMin > 0 ? Math.ceil(lateMin / 60) : 0;
  let delta = 0;
  if (grade && HARD.has(grade)) delta += REPUTATION.hardLanding;
  else if (lateHours === 0) {
    if (grade && TOP.has(grade)) delta += REPUTATION.cleanTop;
    else if (grade === "B") delta += REPUTATION.cleanGood;
    else delta += REPUTATION.cleanFirm;
  }
  delta += REPUTATION.perLateHour * lateHours;
  return delta;
}

export function clampReputation(r: number): number {
  return Math.max(0, Math.min(100, r));
}
