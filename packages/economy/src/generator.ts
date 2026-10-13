// Seeded job generator (plan §7). Pure: the same inputs always give the same board.
//
// Destinations: airports other than the origin whose longest runway is known, long
// enough and of a surface the aircraft accepts, between 20 nm and 80 % of the range,
// where max payload − leg fuel leaves at least 50 kg. 75 % of jobs come from the short
// band (≤ 35 % of the maximum distance, at least 60 nm), the rest from the long band;
// large airports are three times and medium airports twice as likely as small ones.

import type { AircraftType } from "../../protocol/src/aircraft-types";
import type { CargoKind, Job } from "../../protocol/src/economy";
import { isBushStrip, runwaySuitability, type EconomyAirport } from "./airports";
import {
  BOARD_LIFETIME_MIN,
  BOARD_SIZE,
  MIN_JOB_NM,
  SHORT_BAND_MIN_NM,
  SHORT_BAND_SHARE,
  SHORT_JOB_SHARE,
} from "./constants";
import { JOB_KIND_MIN_TIER } from "./company-constants";
import { greatCircleNm, round1 } from "./geo";
import { computePayout, reputationTier } from "./payout";
import { Rng, seedFrom } from "./prng";
import { maxJobDistanceNm, payloadLimitKg, timeLimitMin } from "./rules";

const MIN_JOB_KG = 50;

export interface Candidate {
  airport: EconomyAirport;
  distanceNm: number;
  payloadLimitKg: number;
  bush: boolean;
}

/** Destinations the aircraft can serve from `origin`, sorted by ident. */
export function destinationCandidates(
  origin: EconomyAirport,
  airports: readonly EconomyAirport[],
  aircraft: AircraftType,
): Candidate[] {
  const maxNm = maxJobDistanceNm(aircraft);
  const dLat = maxNm / 60 + 0.1;
  const out: Candidate[] = [];
  for (const airport of airports) {
    if (airport.ident === origin.ident) continue;
    if (Math.abs(airport.lat - origin.lat) > dLat) continue;
    const distanceNm = round1(greatCircleNm(origin, airport));
    if (distanceNm < MIN_JOB_NM || distanceNm > maxNm) continue;
    if (!runwaySuitability(airport, aircraft).ok) continue;
    const limit = payloadLimitKg(aircraft, distanceNm);
    if (limit < MIN_JOB_KG) continue;
    out.push({ airport, distanceNm, payloadLimitKg: limit, bush: isBushStrip(airport) });
  }
  return out.sort((a, b) =>
    a.airport.ident < b.airport.ident ? -1 : a.airport.ident > b.airport.ident ? 1 : 0,
  );
}

const KIND_WEIGHTS: Record<CargoKind, number> = {
  cargo: 40,
  express: 15,
  fragile: 12,
  medical: 10,
  hazmat: 8,
  bush: 40,
};

const UNITS: Record<CargoKind, [number, number]> = {
  cargo: [1, 6],
  fragile: [1, 3],
  express: [1, 2],
  medical: [1, 2],
  hazmat: [1, 4],
  bush: [1, 4],
};

/** Share of the leg's payload limit a job uses. */
const LOAD_SHARE: Record<CargoKind, [number, number]> = {
  cargo: [0.25, 1],
  fragile: [0.2, 0.7],
  express: [0.1, 0.45],
  medical: [0.1, 0.45],
  hazmat: [0.2, 0.8],
  bush: [0.25, 1],
};

const TYPE_WEIGHT = { large: 3, medium: 2, small: 1 } as const;

export interface GenerateOptions {
  origin: EconomyAirport;
  airports: readonly EconomyAirport[];
  aircraft: AircraftType;
  seed: number;
  nowMs: number;
  reputation: number;
  count?: number;
  /** Put the first few jobs on this destination when the aircraft can serve it. */
  focus?: EconomyAirport | null;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

/** Job id: J- + 7 base-36 characters from the board seed and index. */
export function jobId(seed: number, index: number): string {
  return `J-${seedFrom(seed, index, "job").toString(36).toUpperCase().padStart(7, "0")}`;
}

export function generateJobs(options: GenerateOptions): Job[] {
  const { origin, aircraft, nowMs } = options;
  const count = options.count ?? BOARD_SIZE;
  const rng = new Rng(options.seed);
  const candidates = destinationCandidates(origin, options.airports, aircraft);
  if (candidates.length === 0) return [];
  const maxNm = maxJobDistanceNm(aircraft);
  const shortLimit = Math.max(SHORT_BAND_MIN_NM, maxNm * SHORT_BAND_SHARE);
  const short = candidates.filter((c) => c.distanceNm <= shortLimit);
  const long = candidates.filter((c) => c.distanceNm > shortLimit);
  const bushCapable = aircraft.surfaces.some((s) => s !== "paved");
  const focus = options.focus
    ? (candidates.find((c) => c.airport.ident === options.focus?.ident) ?? null)
    : null;
  const focusCount = focus ? Math.min(3, count) : 0;

  const tier = reputationTier(options.reputation);
  const jobs: Job[] = [];
  for (let i = 0; i < count; i++) {
    let dest: Candidate | null;
    if (i < focusCount) dest = focus;
    else {
      const wantShort = rng.next() < SHORT_JOB_SHARE;
      const band = (wantShort ? short : long).length > 0 ? (wantShort ? short : long) : candidates;
      dest = rng.weighted(band, (c) => TYPE_WEIGHT[c.airport.type]);
    }
    if (!dest) continue;
    const bushOk = bushCapable && dest.bush;
    // Reputation gates job kinds (P4): a kind above the company's tier is never drawn.
    const kind =
      rng.weighted(Object.keys(KIND_WEIGHTS) as CargoKind[], (k) =>
        tier < JOB_KIND_MIN_TIER[k]
          ? 0
          : k === "bush"
            ? bushOk
              ? KIND_WEIGHTS.bush
              : 0
            : KIND_WEIGHTS[k],
      ) ?? "cargo";
    const [uMin, uMax] = UNITS[kind];
    const units = rng.int(uMin, uMax);
    const [sMin, sMax] = LOAD_SHARE[kind];
    const limit = dest.payloadLimitKg;
    const raw = limit * rng.range(sMin, sMax);
    const weightKg = Math.max(MIN_JOB_KG, Math.min(limit, Math.round(raw / 5) * 5));
    const id = jobId(options.seed, i);
    const breakdown = computePayout({
      jobId: id,
      kind,
      weightKg,
      distanceNm: dest.distanceNm,
      units,
      reputation: options.reputation,
      estimate: true,
    });
    jobs.push({
      id,
      status: "available",
      origin: origin.ident,
      destination: dest.airport.ident,
      originName: origin.name,
      destinationName: dest.airport.name,
      kind,
      weightKg,
      units,
      distanceNm: dest.distanceNm,
      timeLimitMin: timeLimitMin(kind, dest.distanceNm, aircraft.cruiseKt),
      aircraftKey: aircraft.key,
      createdAt: iso(nowMs),
      expiresAt: iso(nowMs + BOARD_LIFETIME_MIN * 60_000),
      payoutEstimate: breakdown.total,
      breakdown,
    });
  }
  return jobs;
}

/** Board seed: the company seed, the board airport, the aircraft type and a counter. */
export function boardSeed(companySeed: number, origin: string, aircraftKey: string, n: number) {
  return seedFrom(companySeed, origin, aircraftKey, n);
}
