// Route finder (plan §5 P3, idea from FSE-Planner's multi-hop search): chains of up
// to 3 legs from a start airport over the jobs on offer. Each leg stacks the jobs
// that share its origin → destination, best payout per kg first, up to the leg's
// payload limit (max payload − leg fuel). The search is exhaustive depth-first over
// the job graph (small: one board), never revisits an airport, and keeps the best
// chains by total payout.

import type { AircraftType } from "../../protocol/src/aircraft-types";
import type { Job } from "../../protocol/src/economy";
import { payloadLimitKg } from "./rules";

export interface RouteLeg {
  origin: string;
  destination: string;
  jobIds: string[];
  payloadKg: number;
  payout: number;
  distanceNm: number;
}

export interface RouteChain {
  legs: RouteLeg[];
  totalPayout: number;
  totalNm: number;
  payoutPerNm: number;
}

/** Stack jobs on one leg greedily by payout per kg within `limitKg`. */
export function stackJobs(jobs: readonly Job[], limitKg: number): Job[] {
  const sorted = [...jobs].sort(
    (a, b) =>
      b.payoutEstimate / b.weightKg - a.payoutEstimate / a.weightKg || (a.id < b.id ? -1 : 1),
  );
  const out: Job[] = [];
  let kg = 0;
  for (const job of sorted) {
    if (kg + job.weightKg > limitKg) continue;
    out.push(job);
    kg += job.weightKg;
  }
  return out;
}

export interface RouteOptions {
  start: string;
  jobs: readonly Job[];
  aircraft: AircraftType;
  maxHops?: number;
  limit?: number;
}

export function findRoutes(options: RouteOptions): RouteChain[] {
  const maxHops = Math.max(1, Math.min(3, options.maxHops ?? 3));
  const limit = options.limit ?? 5;
  // Legs by origin.
  const byOrigin = new Map<string, Map<string, Job[]>>();
  for (const job of options.jobs) {
    if (job.status !== "available" && job.status !== "accepted") continue;
    const dests = byOrigin.get(job.origin) ?? new Map<string, Job[]>();
    const list = dests.get(job.destination) ?? [];
    list.push(job);
    dests.set(job.destination, list);
    byOrigin.set(job.origin, dests);
  }
  const legCache = new Map<string, RouteLeg | null>();
  const legFor = (origin: string, destination: string): RouteLeg | null => {
    const key = `${origin}>${destination}`;
    if (legCache.has(key)) return legCache.get(key) ?? null;
    const jobs = byOrigin.get(origin)?.get(destination) ?? [];
    const distanceNm = jobs[0]?.distanceNm ?? 0;
    const stacked = stackJobs(jobs, payloadLimitKg(options.aircraft, distanceNm));
    const leg: RouteLeg | null =
      stacked.length === 0
        ? null
        : {
            origin,
            destination,
            jobIds: stacked.map((j) => j.id),
            payloadKg: stacked.reduce((s, j) => s + j.weightKg, 0),
            payout: stacked.reduce((s, j) => s + j.payoutEstimate, 0),
            distanceNm,
          };
    legCache.set(key, leg);
    return leg;
  };

  const chains: RouteChain[] = [];
  const walk = (at: string, legs: RouteLeg[], visited: Set<string>) => {
    if (legs.length > 0) {
      const totalPayout = legs.reduce((s, l) => s + l.payout, 0);
      const totalNm = legs.reduce((s, l) => s + l.distanceNm, 0);
      chains.push({
        legs: [...legs],
        totalPayout,
        totalNm: Math.round(totalNm * 10) / 10,
        payoutPerNm: totalNm > 0 ? Math.round((totalPayout / totalNm) * 100) / 100 : 0,
      });
    }
    if (legs.length >= maxHops) return;
    const dests = [...(byOrigin.get(at)?.keys() ?? [])].sort();
    for (const dest of dests) {
      if (visited.has(dest)) continue;
      const leg = legFor(at, dest);
      if (!leg) continue;
      visited.add(dest);
      legs.push(leg);
      walk(dest, legs, visited);
      legs.pop();
      visited.delete(dest);
    }
  };
  walk(options.start, [], new Set([options.start]));
  return chains
    .sort(
      (a, b) =>
        b.totalPayout - a.totalPayout || a.legs.length - b.legs.length || a.totalNm - b.totalNm,
    )
    .slice(0, limit);
}
