// Hired pilots (plan §7.4, P6 optional): pure rules. A hired pilot flies one owned aircraft
// back and forth on a fixed route in in-game time (the company clock), for a monthly wage.
// It is a SIMULATED economy model: no flight frames, no logbook flights, no landing grades,
// and nothing that counts toward the player's own flying. The book (book.ts, "hired
// pilots" section) schedules the legs and books their money; this file holds the numbers.
// Deterministic: a leg's load comes from mulberry32 seeded with the company seed, the
// pilot and the leg number. Formulas and worked examples: docs/ECONOMY.md ("Hired pilots").

import type { AircraftType } from "../../protocol/src/aircraft-types";
import type { PilotRating } from "../../protocol/src/pilots";
import type { PilotLeg, PilotPnlMonth } from "../../protocol/src/pilots";
import { GAME_DAY_MS } from "./company-constants";
import { round2 } from "./geo";
import { computePayout } from "./payout";
import { Rng, seedFrom } from "./prng";
import { payloadLimitKg } from "./rules";

export const HIRED_PILOTS = {
  /** Monthly wage by rating, dollars (billed at hire for the first month, then monthly). */
  wages: { turboprop: 7_500, jet: 14_000 } as Record<PilotRating, number>,
  /** Share of the job board payout a hired leg earns (the player would earn 100 %). */
  payoutShare: 0.5,
  /** Simulated load: uniform share of the leg's payload limit (max payload − leg fuel). */
  loadShare: [0.5, 0.9] as const,
  /** Climb/descent allowance added to the cruise time, minutes. */
  airborneAllowanceMin: 10,
  /** Taxi out + taxi in, minutes (block = airborne + taxi). */
  taxiMin: 20,
  /** Ground time between two legs, minutes. */
  turnaroundMin: 120,
  /** Departures only between these company-clock hours (duty window). */
  dutyStartHour: 6,
  dutyEndHour: 20,
  /** At most this many pilots on the payroll. */
  maxPilots: 10,
  /** Legs kept on the pilot record (newest first). */
  recentLegs: 10,
} as const;

/** Rating that covers an aircraft category (null: none of the ratings). */
export function ratingFor(category: AircraftType["category"]): PilotRating | null {
  switch (category) {
    case "single-turboprop":
    case "twin-turboprop":
    case "regional-turboprop":
      return "turboprop";
    case "narrowbody-jet":
    case "widebody-jet":
      return "jet";
    default:
      return null;
  }
}

export function pilotWage(rating: PilotRating): number {
  return HIRED_PILOTS.wages[rating];
}

const FIRST = [
  "Avery",
  "Blake",
  "Casey",
  "Dana",
  "Elliot",
  "Frankie",
  "Harper",
  "Jordan",
  "Kendall",
  "Logan",
  "Morgan",
  "Parker",
  "Quinn",
  "Reese",
  "Rowan",
  "Sawyer",
] as const;
const LAST = [
  "Alvarez",
  "Brennan",
  "Castillo",
  "Doyle",
  "Eriksen",
  "Fischer",
  "Garner",
  "Hale",
  "Ibarra",
  "Jansen",
  "Keller",
  "Lindqvist",
  "Moreau",
  "Novak",
  "Okafor",
  "Petrov",
  "Rahman",
  "Tremblay",
  "Vance",
  "Whitfield",
] as const;

/** Fictional pilot name, deterministic from the company seed and the hire counter. */
export function pilotName(seed: number, n: number): string {
  const rng = new Rng(seedFrom(seed, "pilot-name", n));
  return `${FIRST[rng.int(0, FIRST.length - 1)]} ${LAST[rng.int(0, LAST.length - 1)]}`;
}

export interface LegTimes {
  airborneMin: number;
  blockMin: number;
}

/** airborne = distance / cruise + 10 min (whole minutes); block = airborne + 20 min. */
export function legTimes(type: AircraftType, distanceNm: number): LegTimes {
  const airborneMin = Math.round(
    (distanceNm / type.cruiseKt) * 60 + HIRED_PILOTS.airborneAllowanceMin,
  );
  return { airborneMin, blockMin: airborneMin + HIRED_PILOTS.taxiMin };
}

/** Fuel burned on a leg: cruise burn × block hours, kg (whole kg). */
export function legFuelBurnKg(type: AircraftType, blockMin: number): number {
  return Math.round(type.fuelBurnKgH * (blockMin / 60));
}

export interface LegIncome {
  loadKg: number;
  /** The job board's estimate for that cargo on that leg (what the player would be paid). */
  boardPayout: number;
  /** payoutShare × boardPayout, cents. */
  income: number;
}

/**
 * Income of one leg: a cargo load of `share` × the payload limit (whole kg), priced like a
 * board job (`computePayout`, cargo, one unit, estimate: on time, landing 1.00, no bonuses
 * beyond reputation), times the hired payout share.
 */
export function legIncome(args: {
  type: AircraftType;
  distanceNm: number;
  reputation: number;
  /** Share of the payload limit carried (seeded per leg, see `legLoadShare`). */
  share: number;
  /** Major defects cut the payload limit (percent). */
  payloadPenaltyPct?: number;
}): LegIncome {
  const limit = Math.floor(
    payloadLimitKg(args.type, args.distanceNm) * (1 - (args.payloadPenaltyPct ?? 0) / 100),
  );
  const loadKg = Math.max(0, Math.round(limit * args.share));
  const boardPayout =
    loadKg > 0
      ? computePayout({
          kind: "cargo",
          weightKg: loadKg,
          distanceNm: args.distanceNm,
          units: 1,
          reputation: args.reputation,
          estimate: true,
        }).total
      : 0;
  return { loadKg, boardPayout, income: round2(boardPayout * HIRED_PILOTS.payoutShare) };
}

/** Seeded load share of leg `n` of a pilot (uniform in loadShare). */
export function legLoadShare(companySeed: number, pilotId: string, n: number): number {
  const [lo, hi] = HIRED_PILOTS.loadShare;
  return new Rng(seedFrom(companySeed, "pilot-leg", pilotId, n)).range(lo, hi);
}

/** Average load share (the route preview). */
export const AVERAGE_LOAD_SHARE = (HIRED_PILOTS.loadShare[0] + HIRED_PILOTS.loadShare[1]) / 2;

/**
 * Earliest departure at or after `t` inside the duty window [06:00, 20:00) of the company
 * clock; outside it the pilot waits for 06:00.
 */
export function nextDutyDeparture(t: number): number {
  const day = Math.floor(t / GAME_DAY_MS);
  const inDay = t - day * GAME_DAY_MS;
  const start = HIRED_PILOTS.dutyStartHour * 3_600_000;
  const end = HIRED_PILOTS.dutyEndHour * 3_600_000;
  if (inDay < start) return day * GAME_DAY_MS + start;
  if (inDay >= end) return (day + 1) * GAME_DAY_MS + start;
  return Math.floor(t);
}

// ---- the pilot record (persisted) ----

export interface PilotAssignmentRecord {
  aircraftId: string;
  origin: string;
  destination: string;
  sinceGameMs: number;
  legs: number;
  nextDepartureGameMs: number;
  leg: { from: string; to: string; departGameMs: number; arriveGameMs: number } | null;
}

export interface HiredPilotRecord {
  id: string;
  name: string;
  rating: PilotRating;
  wageMonthly: number;
  status: "hired" | "fired";
  hiredGameMs: number;
  /** Wall clock, ms. */
  hiredAt: number;
  firedGameMs: number | null;
  assignment: PilotAssignmentRecord | null;
  stopped: { code: string; message: string; gameMs: number } | null;
  legsFlown: number;
  pnl: PilotPnlMonth[];
  recent: PilotLeg[];
}

export function emptyPilotMonth(month: number): PilotPnlMonth {
  return { month, income: 0, wages: 0, fuel: 0, fees: 0, net: 0, legs: 0, wear: 0, wearValue: 0 };
}

/** Add to a pilot's P&L row for `month` (keeps the last 12 months, oldest first). */
export function addPilotPnl(
  pnl: readonly PilotPnlMonth[],
  month: number,
  d: Partial<Omit<PilotPnlMonth, "month" | "net">>,
): PilotPnlMonth[] {
  const rows = [...pnl];
  const i = rows.findIndex((m) => m.month === month);
  const row = { ...(i >= 0 && rows[i] ? rows[i] : emptyPilotMonth(month)) };
  row.income = round2(row.income + (d.income ?? 0));
  row.wages = round2(row.wages + (d.wages ?? 0));
  row.fuel = round2(row.fuel + (d.fuel ?? 0));
  row.fees = round2(row.fees + (d.fees ?? 0));
  row.legs += d.legs ?? 0;
  row.wear = round2(row.wear + (d.wear ?? 0));
  row.wearValue = round2(row.wearValue + (d.wearValue ?? 0));
  // Net in integer cents so the four cash lines and the net agree exactly.
  row.net =
    (Math.round(row.income * 100) -
      Math.round(row.wages * 100) -
      Math.round(row.fuel * 100) -
      Math.round(row.fees * 100)) /
    100;
  if (i >= 0) rows[i] = row;
  else rows.push(row);
  rows.sort((a, b) => a.month - b.month);
  return rows.slice(-12);
}
