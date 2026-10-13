// Pure view-model selectors for the Live Flight page. Every function returns null
// (or a null field) when the underlying data is missing — never a default number.

import type {
  EnginesState,
  FuelState,
  PositionState,
  Source,
  WeightsState,
} from "@cargo-ops/protocol";
import { eteMin, type ClientSimState, type ReceivedEvent } from "@/lib/sim-state";

import { landingGrade, type LandingGrade } from "./landing-grade";

/** AGL is shown next to indicated altitude below this height. */
export const AGL_DISPLAY_BELOW_FT = 2500;
/** Fuel reserve added to ETE before warning about endurance (plan §5 P3: fuel + 45 min). */
export const FUEL_RESERVE_MIN = 45;
/** Frames older than this (while a session is up) mark values as stale. */
export const STALE_AFTER_MS = 5000;
/** Sim rates above this are flagged (plan §6.4: > 4× is not allowed for missions). */
export const SIM_RATE_WARN_ABOVE = 4;

function finite(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** A session (live, demo or replay) is up: a welcome has been received. */
export function isSessionUp(state: ClientSimState): boolean {
  return (
    state.welcome !== null &&
    (state.connection === "live" || state.connection === "demo" || state.connection === "replay")
  );
}

/**
 * Values on screen are stale: we hold data but the last frame is older than
 * STALE_AFTER_MS, or the session that produced it has ended. `now` is null before the
 * clock starts (SSR / first render), which never reports stale.
 */
export function isStale(state: ClientSimState, now: number | null): boolean {
  if (state.lastFrameAt === null || now === null) return false;
  if (!isSessionUp(state)) return true;
  return now - state.lastFrameAt > STALE_AFTER_MS;
}

/** AGL to show alongside altitude, only when below AGL_DISPLAY_BELOW_FT. */
export function displayAglFt(position: PositionState | null | undefined): number | null {
  if (!position || !finite(position.aglFt)) return null;
  return position.aglFt < AGL_DISPLAY_BELOW_FT ? position.aglFt : null;
}

/** Sum of per-engine fuel flow (pph), or null without fuel data or flow readings. */
export function totalFuelFlowPph(fuel: FuelState | null | undefined): number | null {
  if (!fuel || fuel.flowPph.length === 0) return null;
  const values = fuel.flowPph.filter(finite);
  if (values.length === 0) return null;
  return values.reduce((sum, f) => sum + f, 0);
}

export interface EngineCount {
  running: number;
  total: number;
}

export function enginesRunning(engines: EnginesState | null | undefined): EngineCount | null {
  if (!engines || engines.running.length === 0) return null;
  return { running: engines.running.filter(Boolean).length, total: engines.running.length };
}

export type EnduranceStatus = "ok" | "low";

/**
 * Endurance against ETE plus the 45-minute reserve. Null when either side is unknown:
 * we only warn when the ETE is actually known.
 */
export function enduranceStatus(
  enduranceMin: number | null,
  eteMinutes: number | null,
): EnduranceStatus | null {
  if (!finite(enduranceMin) || !finite(eteMinutes)) return null;
  return enduranceMin < eteMinutes + FUEL_RESERVE_MIN ? "low" : "ok";
}

export interface SimRateBadge {
  label: string;
  level: "info" | "warning";
}

/** "×N" badge when the sim rate differs from real time; warning above 4×. */
export function simRateBadge(rate: number | null | undefined): SimRateBadge | null {
  if (!finite(rate) || rate === 1) return null;
  const text = Number.isInteger(rate) ? String(rate) : String(Number(rate.toFixed(2)));
  return { label: `×${text}`, level: rate > SIM_RATE_WARN_ABOVE ? "warning" : "info" };
}

export interface RouteView {
  origin: string | null;
  destination: string | null;
  distanceRemainingNm: number | null;
  eteMin: number | null;
  /** 0–1 along the planned distance, or null when it cannot be derived. */
  progress: number | null;
  flownNm: number | null;
}

const EMPTY_ROUTE: RouteView = {
  origin: null,
  destination: null,
  distanceRemainingNm: null,
  eteMin: null,
  progress: null,
  flownNm: null,
};

/** Route progress from the plan domain. Without a plan domain every field is null. */
export function routeView(state: ClientSimState): RouteView {
  const plan = state.sim.plan;
  if (!plan) return EMPTY_ROUTE;
  const remaining = finite(plan.destDistanceNm) ? plan.destDistanceNm : null;
  const planned = state.sim.flight?.plannedDistanceNm;
  const progress =
    remaining !== null && finite(planned) && planned > 0
      ? Math.min(1, Math.max(0, 1 - remaining / planned))
      : null;
  const flown = state.sim.flight?.flownDistanceNm;
  return {
    origin: plan.origin ?? null,
    destination: plan.destination ?? null,
    distanceRemainingNm: remaining,
    eteMin: eteMin(remaining, state.sim.motion?.gsKt),
    progress,
    flownNm: finite(flown) ? flown : null,
  };
}

export interface WeightsView {
  totalLb: number;
  emptyLb: number;
  payloadLb: number;
  /** Total minus empty minus payload (fuel and anything else), never negative. */
  fuelAndOtherLb: number;
  maxGrossLb: number;
  /** Max gross minus total; negative when overweight. */
  marginLb: number;
  overweight: boolean;
}

export function weightsView(weights: WeightsState | null | undefined): WeightsView | null {
  if (!weights) return null;
  const { totalLb, emptyLb, payloadLb, maxGrossLb } = weights;
  if (![totalLb, emptyLb, payloadLb, maxGrossLb].every(finite)) return null;
  return {
    totalLb,
    emptyLb,
    payloadLb,
    fuelAndOtherLb: Math.max(0, totalLb - emptyLb - payloadLb),
    maxGrossLb,
    marginLb: maxGrossLb - totalLb,
    overweight: maxGrossLb > 0 && totalLb > maxGrossLb,
  };
}

export interface TouchdownView {
  seq: number;
  /** Client clock when received, ms. */
  at: number;
  source: Source;
  rateFpm: number | null;
  gForce: number | null;
  gsKt: number | null;
  bankDeg: number | null;
  pitchDeg: number | null;
  lat: number | null;
  lon: number | null;
  grade: LandingGrade | null;
}

function field(data: unknown, key: string): number | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return finite(value) ? value : null;
}

/**
 * The most recent `touchdown` event of the current flight: a later `flight.started`
 * hides it so the card resets for the next leg.
 */
export function latestTouchdown(events: readonly ReceivedEvent[]): TouchdownView | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.msg.name === "flight.started") return null;
    if (ev.msg.name !== "touchdown") continue;
    const data = ev.msg.data;
    const rateFpm = field(data, "rateFpm");
    const gForce = field(data, "gForce");
    return {
      seq: ev.msg.seq,
      at: ev.at,
      source: ev.msg.source,
      rateFpm,
      gForce,
      gsKt: field(data, "gsKt"),
      bankDeg: field(data, "bankDeg"),
      pitchDeg: field(data, "pitchDeg"),
      lat: field(data, "lat"),
      lon: field(data, "lon"),
      grade: landingGrade(rateFpm, gForce),
    };
  }
  return null;
}
