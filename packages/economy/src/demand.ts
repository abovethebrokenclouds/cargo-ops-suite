// Dynamic per-airport demand (plan §7.4): an index that drifts with the player's
// activity (deliveries saturate an airport, departures with cargo lift it; both decay
// back to normal) and seeded random events (storm, festival, strike) that raise job
// payouts and fuel prices locally for a few in-game days. Pure and seeded.

import { DEMAND_EVENT_KINDS, type DemandEvent, type DemandEventKind } from "../../protocol/src/fbo";
import type { EconomyAirport } from "./airports";
import { GAME_DAY_MS } from "./company-constants";
import { DEMAND, DEMAND_EVENTS } from "./fbo-constants";
import { greatCircleNm } from "./geo";
import { Rng, seedFrom } from "./prng";

export interface DemandEventRecord {
  id: string;
  icao: string;
  kind: DemandEventKind;
  startGameMs: number;
  endGameMs: number;
}

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export function eventState(e: DemandEventRecord): DemandEvent {
  const spec = DEMAND_EVENTS[e.kind];
  return {
    id: e.id,
    icao: e.icao,
    kind: e.kind,
    label: spec.label,
    startGameMs: e.startGameMs,
    endGameMs: e.endGameMs,
    payoutPct: spec.payoutPct,
    fuelPct: spec.fuelPct,
  };
}

/** The event active at `icao` at `gameMs` (start ≤ t < end), if any. */
export function activeEvent(
  icao: string,
  events: readonly DemandEventRecord[],
  gameMs: number,
): DemandEventRecord | null {
  for (const e of events) {
    if (e.icao === icao && e.startGameMs <= gameMs && gameMs < e.endGameMs) return e;
  }
  return null;
}

/** Demand index = 1 + activity + the active event's payout uplift (4 decimals, ≥ 0.5). */
export function demandIndex(
  icao: string,
  activity: Readonly<Record<string, number>>,
  events: readonly DemandEventRecord[],
  gameMs: number,
): number {
  const e = activeEvent(icao, events, gameMs);
  const uplift = e ? DEMAND_EVENTS[e.kind].payoutPct / 100 : 0;
  return round4(Math.max(0.5, 1 + (activity[icao] ?? 0) + uplift));
}

/** Job payout factor: clamp(mean of the origin and destination index, 0.8, 1.5), 2 decimals. */
export function demandFactor(originIndex: number, destinationIndex: number): number {
  const f = clamp((originIndex + destinationIndex) / 2, DEMAND.factorMin, DEMAND.factorMax);
  return Math.round(f * 100) / 100;
}

/** Fuel price multiplier at an airport: 1 + the active event's fuel uplift. */
export function fuelEventFactor(
  icao: string,
  events: readonly DemandEventRecord[],
  gameMs: number,
): number {
  const e = activeEvent(icao, events, gameMs);
  return e ? 1 + DEMAND_EVENTS[e.kind].fuelPct / 100 : 1;
}

/** Add player activity at an airport (clamped to −0.15…+0.10). */
export function addActivity(
  activity: Readonly<Record<string, number>>,
  icao: string,
  delta: number,
): Record<string, number> {
  const next = { ...activity };
  next[icao] = round4(clamp((next[icao] ?? 0) + delta, DEMAND.activityMin, DEMAND.activityMax));
  return next;
}

/** One in-game day of decay toward 0 (× 0.85); entries under 0.001 are dropped. */
export function decayActivity(activity: Readonly<Record<string, number>>): Record<string, number> {
  const next: Record<string, number> = {};
  for (const [icao, v] of Object.entries(activity)) {
    const d = round4(v * (1 - DEMAND.decayPerDay));
    if (Math.abs(d) >= 0.001) next[icao] = d;
  }
  return next;
}

/**
 * Airports events can hit: large airports within 600 nm of the base plus `extra` (the
 * player's FBO airports), sorted by ident.
 */
export function eventCandidates(
  base: EconomyAirport | null,
  list: readonly EconomyAirport[],
  extra: readonly string[],
): EconomyAirport[] {
  const want = new Set(extra.map((x) => x.toUpperCase()));
  const out = list.filter(
    (a) =>
      want.has(a.ident) ||
      (base !== null && a.type === "large" && greatCircleNm(base, a) <= DEMAND.candidateRadiusNm),
  );
  return out.sort((a, b) => (a.ident < b.ident ? -1 : a.ident > b.ident ? 1 : 0));
}

/**
 * The day roll (in-game day `day` ≥ 1, at its start): seed FNV-1a(company seed, "demand",
 * day); with 50 % chance one new event at a candidate airport without an active event
 * (weighted large 3 / medium 1); kind storm 45 / festival 30 / strike 25; it lasts a
 * uniform whole number of days in the kind's range.
 */
export function rollDemandEvent(
  companySeed: number,
  day: number,
  candidates: readonly EconomyAirport[],
  events: readonly DemandEventRecord[],
): DemandEventRecord | null {
  if (day < 1 || candidates.length === 0) return null;
  const rng = new Rng(seedFrom(companySeed, "demand", day));
  if (rng.next() >= DEMAND.eventChance) return null;
  const t = day * GAME_DAY_MS;
  const free = candidates.filter((a) => !activeEvent(a.ident, events, t));
  const airport = rng.weighted(free, (a) => (a.type === "large" ? 3 : 1));
  const kind = rng.weighted(DEMAND_EVENT_KINDS, (k) => DEMAND_EVENTS[k].weight);
  if (!airport || !kind) return null;
  const [lo, hi] = DEMAND_EVENTS[kind].days;
  const days = rng.int(lo, hi);
  return {
    id: `EV-${day}-${airport.ident}`,
    icao: airport.ident,
    kind,
    startGameMs: t,
    endGameMs: t + days * GAME_DAY_MS,
  };
}
