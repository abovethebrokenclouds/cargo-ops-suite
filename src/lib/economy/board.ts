// Job board state for the web app. Live/replay: the connector's `jobs`, `company`
// and `mission` domains (authoritative). Demo (no connector): the SAME pure generator
// from packages/economy runs in the browser on the bundled airports, every value is
// tagged DEMO, and nothing can be accepted or loaded.

import { useEffect, useMemo, useState } from "react";
import {
  AIRCRAFT_TYPES,
  aircraftTypeByKey,
  resolveAircraftType,
  type AircraftType,
  type CompanyState,
  type Job,
  type JobsState,
  type Mission,
  type Source,
} from "@cargo-ops/protocol";
import {
  airportLookup,
  boardSeed,
  generateJobs,
  maxJobDistanceNm,
  payloadLimitKg,
  reputationTier,
  runwaySuitability,
  type AirportLookup,
  type EconomyAirport,
} from "@cargo-ops/economy";
import { isFacilityLookup, sourceSuffix } from "@/lib/economy/facilities";
import { loadAirports } from "@/lib/map/airports";
import type { ClientSimState } from "@/lib/sim-state";

export { AIRCRAFT_TYPES, aircraftTypeByKey };

/** Fixed demo company: clearly a demo seed, never shown as a live balance. */
export const DEMO_COMPANY: CompanyState = {
  name: "Cargo Ops Logistics",
  base: "KMEM",
  cash: 250_000,
  reputation: 50,
  reputationTier: reputationTier(50),
};
export const DEMO_SEED = 20_261_013;

let lookupPromise: Promise<AirportLookup> | null = null;

/** Bundled airports as an economy lookup (lazy, ~1.1 MB, cached). */
export function loadAirportLookup(): Promise<AirportLookup> {
  lookupPromise ??= loadAirports()
    .then((index) => airportLookup(index.list))
    .catch((err: unknown) => {
      lookupPromise = null;
      throw err;
    });
  return lookupPromise;
}

export function useAirportLookup(): AirportLookup | null {
  const [lookup, setLookup] = useState<AirportLookup | null>(null);
  useEffect(() => {
    let alive = true;
    loadAirportLookup()
      .then((l) => alive && setLookup(l))
      .catch(() => alive && setLookup(null));
    return () => {
      alive = false;
    };
  }, []);
  return lookup;
}

/** Demo boards: the base plus the first three destinations (so the route finder has hops). */
export function demoJobsState(
  lookup: AirportLookup,
  type: AircraftType,
  nowMs: number,
  base = DEMO_COMPANY.base,
): JobsState {
  const origin = lookup.get(base);
  if (!origin) {
    return {
      boards: [],
      available: [],
      accepted: [],
      aircraft: { typeKey: type.key, name: type.name, source: "default" },
    };
  }
  const boards: JobsState["boards"] = [];
  const available: Job[] = [];
  const make = (airport: string, n: number) => {
    const at = lookup.get(airport);
    if (!at) return [];
    const seed = boardSeed(DEMO_SEED, at.ident, type.key, n);
    const jobs = generateJobs({
      origin: at,
      airports: lookup.list,
      aircraft: type,
      seed,
      nowMs,
      reputation: DEMO_COMPANY.reputation,
      count: n === 1 ? 24 : 10,
    });
    boards.push({
      origin: at.ident,
      generatedAt: new Date(nowMs).toISOString(),
      seed,
      aircraftKey: type.key,
    });
    available.push(...jobs);
    return jobs;
  };
  const first = make(origin.ident, 1);
  const hops = [...new Set(first.map((j) => j.destination))].slice(0, 3);
  hops.forEach((ident, i) => make(ident, i + 2));
  return {
    boards,
    available,
    accepted: [],
    aircraft: { typeKey: type.key, name: type.name, source: "default" },
  };
}

export interface BoardView {
  /** Where the data comes from: the connector (sim/replay) or the in-browser demo. */
  source: Source | null;
  jobs: JobsState | null;
  company: CompanyState | null;
  mission: Mission | null;
  /** True when commands go to a real connector (accept/load enabled). */
  connector: boolean;
}

/** Live/replay board from state, or a generated DEMO board when no connector exists. */
export function useJobBoard(
  state: ClientSimState,
  options: { demoTypeKey?: string | null; lookup: AirportLookup | null },
): BoardView {
  const demo = state.connection === "demo";
  const title = state.sim.aircraft?.title ?? null;
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (demo) setNow(Date.now());
  }, [demo]);
  const demoType = resolveAircraftType(title, options.demoTypeKey ?? null).type;
  const demoJobs = useMemo(
    () =>
      demo && options.lookup && now !== null ? demoJobsState(options.lookup, demoType, now) : null,
    [demo, options.lookup, now, demoType],
  );
  if (demo) {
    return {
      source: "demo",
      jobs: demoJobs
        ? {
            ...demoJobs,
            aircraft: {
              ...demoJobs.aircraft,
              source: options.demoTypeKey ? "override" : title ? "title" : "default",
              ...(title ? { title } : {}),
            },
          }
        : null,
      company: DEMO_COMPANY,
      mission: null,
      connector: false,
    };
  }
  const connected = state.connection === "live" || state.connection === "replay";
  return {
    source: connected ? (state.source ?? (state.connection === "replay" ? "replay" : "sim")) : null,
    jobs: state.sim.jobs ?? null,
    company: state.sim.company ?? null,
    mission: state.sim.mission ?? null,
    connector: connected,
  };
}

export type SuitabilityKey = "runway" | "range" | "payload";

export interface SuitabilityBadge {
  key: SuitabilityKey;
  ok: boolean | null;
  label: string;
  detail: string;
}

/** "11,120 ft (MSFS) paved (OurAirports)": each runway field with its source when known. */
function runwayDetail(dest: EconomyAirport, surface: string, lookup: AirportLookup | null): string {
  const sources = isFacilityLookup(lookup) ? lookup.sourcesOf(dest.ident) : null;
  const length = dest.longestRwyFt
    ? `${dest.longestRwyFt.toLocaleString("en-US")} ft`
    : "unknown length";
  if (!sources) return `${length} ${surface}`;
  if (sources.runway && sources.runway === sources.surface) {
    return `${length} ${surface}${sourceSuffix(sources.runway)}`;
  }
  return `${length}${sourceSuffix(sources.runway)} ${surface}${sourceSuffix(sources.surface)}`;
}

/** Runway/range/payload checks of a job against an aircraft type (null = unknown). */
export function jobSuitability(
  job: Job,
  type: AircraftType,
  lookup: AirportLookup | null,
): SuitabilityBadge[] {
  const dest = lookup?.get(job.destination) ?? null;
  const rwy = dest ? runwaySuitability(dest, type) : null;
  const maxNm = maxJobDistanceNm(type);
  // Transit cargo: a long-haul job is flown in (at least) two legs; judge it per half.
  const longHaul = job.longHaul === true && job.distanceNm > maxNm;
  const limit = payloadLimitKg(type, longHaul ? job.distanceNm / 2 : job.distanceNm);
  return [
    {
      key: "runway",
      ok: rwy ? rwy.ok : null,
      label: "Runway",
      detail: dest
        ? `${runwayDetail(dest, rwy?.surface ?? "", lookup)} · needs ${type.minRunwayFt.toLocaleString("en-US")} ft`
        : "Airport data loading",
    },
    longHaul
      ? {
          key: "range",
          ok: job.distanceNm <= maxNm * 2,
          label: "Range (stop)",
          detail: `${job.distanceNm} nm: beyond ${Math.round(maxNm)} nm, needs a transit stop`,
        }
      : {
          key: "range",
          ok: job.distanceNm <= maxNm,
          label: "Range",
          detail: `${job.distanceNm} nm of ${Math.round(maxNm)} nm (80 % of range)`,
        },
    {
      key: "payload",
      ok: job.weightKg <= limit,
      label: "Payload",
      detail: longHaul
        ? `${job.weightKg} kg of ${limit} kg per leg if split in two (max payload − leg fuel)`
        : `${job.weightKg} kg of ${limit} kg (max payload − leg fuel)`,
    },
  ];
}

export function activeType(jobs: JobsState | null): AircraftType {
  return aircraftTypeByKey(jobs?.aircraft.typeKey) ?? resolveAircraftType(null, null).type;
}
