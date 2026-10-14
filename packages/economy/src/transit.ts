// Transit cargo (docs/ECONOMY.md "Transit cargo"): a job whose final destination lies beyond
// the next leg is flown to an intermediate airport, unloaded there "in transit", and picked
// up later for the onward leg. Pure rules shared by the connector (authoritative) and the UI.
//
// Rules (the plan is silent, so the simplest consistent ones):
// - payout: the full job payout on the FINAL delivery only (origin → destination great
//   circle, kind, units, demand factor as on the board), landing grade of the final leg;
//   intermediate legs pay nothing and there is never partial credit;
// - deadline: the job's time limit covers the whole chain = block minutes of every leg +
//   ground time between legs on the company clock (minus free storage hours in an own cargo
//   terminal); late minutes at the final delivery use the normal late penalty;
// - bonuses and damage carry over: a leg flown above 1× or departed underloaded removes the
//   bonuses of the final payout; a fragile touchdown above 1.5 G on any leg damages it;
// - progress: a transit leg must end strictly closer (great circle) to the job's final
//   destination than where the cargo is now;
// - a failed or crashed leg fails every job on board (no partial credit); an aborted leg puts
//   transit cargo back where it was stored.

import type { Job, JobTransit, TransitStorage } from "../../protocol/src/economy";
import type { LandingGrade } from "../../protocol/src/landing";
import { REPUTATION } from "./constants";
import { CARGO_TERMINAL } from "./fbo-constants";
import { greatCircleNm, round1, type LatLon } from "./geo";
import { deliveryReputationDelta, type RuleResult } from "./rules";

const MIN = 60_000;

/** Airport where the job's cargo is now: its transit location, else its origin. */
export function jobLocation(job: Pick<Job, "origin" | "transit">): string {
  return job.transit?.location ?? job.origin;
}

/**
 * Storage for transit cargo at an airport: an own operating FBO with a cargo terminal of
 * level L keeps 4 / 8 / 12 ground hours off the deadline; an own FBO without a terminal or a
 * public ramp keeps none.
 */
export function transitStorage(own: { fbo: boolean; terminalLevel: number }): {
  storage: TransitStorage;
  freeStorageMin: number;
} {
  if (!own.fbo) return { storage: "airport", freeStorageMin: 0 };
  const level = Math.max(0, Math.min(3, Math.floor(own.terminalLevel)));
  if (level === 0) return { storage: "own_fbo", freeStorageMin: 0 };
  return {
    storage: "own_terminal",
    freeStorageMin: (CARGO_TERMINAL.transitFreeStorageHours[level - 1] ?? 0) * 60,
  };
}

/** Ground minutes at the current stop that count against the deadline up to `atGameMs`. */
export function countedGroundMin(transit: JobTransit, atGameMs: number): number {
  const ground = Math.max(0, (atGameMs - transit.arrivedGameMs) / MIN);
  return round1(Math.max(0, ground - transit.freeStorageMin));
}

/** Chain minutes used by the job up to `atGameMs` (0 before its first leg). */
export function chainElapsedMin(job: Pick<Job, "transit">, atGameMs: number): number {
  if (!job.transit) return 0;
  return round1(job.transit.elapsedMin + countedGroundMin(job.transit, atGameMs));
}

/** Minutes left of the job's time limit at `atGameMs` (negative = already late). */
export function transitRemainingMin(
  job: Pick<Job, "transit" | "timeLimitMin">,
  atGameMs: number,
): number {
  return round1(job.timeLimitMin - chainElapsedMin(job, atGameMs));
}

/** Company clock at which the time limit runs out while the cargo waits at its stop. */
export function transitDeadlineGameMs(
  timeLimitMin: number,
  elapsedMin: number,
  arrivedGameMs: number,
  freeStorageMin: number,
): number {
  return Math.round(arrivedGameMs + (timeLimitMin - elapsedMin + freeStorageMin) * MIN);
}

/**
 * A transit leg must bring the cargo strictly closer to its final destination
 * (great circle from the leg destination < from where the cargo is now).
 */
export function checkTransitProgress(
  job: Pick<Job, "id" | "destination">,
  from: LatLon & { ident: string },
  legDestination: LatLon & { ident: string },
  finalDestination: LatLon & { ident: string },
): RuleResult {
  if (legDestination.ident === finalDestination.ident) return { ok: true };
  const now = greatCircleNm(from, finalDestination);
  const after = greatCircleNm(legDestination, finalDestination);
  if (after >= now) {
    return {
      ok: false,
      code: "no_progress",
      message: `${legDestination.ident} is not closer to ${job.destination} (${round1(after)} nm) than ${from.ident} (${round1(now)} nm): a transit leg must make progress`,
    };
  }
  return { ok: true };
}

export interface FlownLeg {
  missionId: string;
  flightId?: string;
  origin: string;
  destination: string;
  /** Company clock at block-out (absent: no ground time is counted). */
  startedGameMs?: number;
  blockMin: number;
  landingGrade: LandingGrade | null;
  peakG: number | null;
  noBonus: boolean;
  payloadMismatch: boolean;
}

/** Ground minutes counted before `leg` for a job (0 for a job on its first leg). */
function groundBefore(job: Pick<Job, "transit">, leg: FlownLeg): number {
  return job.transit && leg.startedGameMs !== undefined
    ? countedGroundMin(job.transit, leg.startedGameMs)
    : 0;
}

/** The job after `leg` delivered it to an intermediate airport: in transit there. */
export function arriveInTransit(
  job: Job,
  leg: FlownLeg,
  at: {
    arrivedAt: string;
    arrivedGameMs: number;
    locationName?: string;
    storage: TransitStorage;
    freeStorageMin: number;
  },
): Job {
  const groundMin = groundBefore(job, leg);
  const elapsedMin = round1((job.transit?.elapsedMin ?? 0) + groundMin + leg.blockMin);
  const transit: JobTransit = {
    location: leg.destination,
    ...(at.locationName ? { locationName: at.locationName } : {}),
    arrivedAt: at.arrivedAt,
    arrivedGameMs: Math.round(at.arrivedGameMs),
    elapsedMin,
    storage: at.storage,
    freeStorageMin: at.freeStorageMin,
    deadlineGameMs: transitDeadlineGameMs(
      job.timeLimitMin,
      elapsedMin,
      at.arrivedGameMs,
      at.freeStorageMin,
    ),
    legs: [
      ...(job.transit?.legs ?? []),
      {
        missionId: leg.missionId,
        ...(leg.flightId ? { flightId: leg.flightId } : {}),
        origin: leg.origin,
        destination: leg.destination,
        blockMin: round1(leg.blockMin),
        groundMin,
        ...(leg.landingGrade ? { landingGrade: leg.landingGrade } : {}),
        ...(leg.peakG !== null && Number.isFinite(leg.peakG) ? { peakG: leg.peakG } : {}),
        ...(leg.noBonus ? { noBonus: true } : {}),
        ...(leg.payloadMismatch ? { payloadMismatch: true } : {}),
        arrivedAt: at.arrivedAt,
      },
    ],
  };
  const { missionId: _m, ...rest } = job;
  return { ...rest, status: "in_transit", transit };
}

/**
 * Payout inputs of the final delivery over the whole chain: late minutes against the time
 * limit, the worst touchdown, and bonuses removed when any leg lost them.
 */
export function finalDeliveryTerms(
  job: Pick<Job, "transit" | "timeLimitMin">,
  leg: FlownLeg,
): {
  lateMin: number;
  chainMin: number;
  peakG: number | null;
  noBonus: boolean;
  payloadMismatch: boolean;
  legs: number;
} {
  const prior = job.transit?.legs ?? [];
  const chainMin = round1((job.transit?.elapsedMin ?? 0) + groundBefore(job, leg) + leg.blockMin);
  const peaks = [leg.peakG, ...prior.map((l) => l.peakG ?? null)].filter(
    (g): g is number => typeof g === "number" && Number.isFinite(g),
  );
  return {
    lateMin: round1(chainMin - job.timeLimitMin),
    chainMin,
    peakG: peaks.length ? Math.max(...peaks) : null,
    noBonus: leg.noBonus || prior.some((l) => l.noBonus === true),
    payloadMismatch: leg.payloadMismatch || prior.some((l) => l.payloadMismatch === true),
    legs: prior.length + 1,
  };
}

/**
 * Reputation for a verified leg: the normal delivery rule over the jobs delivered on it
 * (latest late minutes); a leg that only carried transit cargo earns nothing but still
 * costs the hard-landing penalty.
 */
export function legReputationDelta(grade: LandingGrade | null, finalLateMin: number[]): number {
  if (finalLateMin.length === 0) {
    return grade && (grade === "D" || grade === "E" || grade === "F") ? REPUTATION.hardLanding : 0;
  }
  return deliveryReputationDelta(grade, Math.max(0, ...finalLateMin));
}
