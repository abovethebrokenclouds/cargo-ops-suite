// Pure view-model selectors for the Live Flight page. Every function returns null
// (or a null field) when the underlying data is missing — never a default number.

import {
  touchdownSchema,
  type EnginesState,
  type FlightState,
  type FuelState,
  type PlanBasis,
  type PositionState,
  type RateSource,
  type Source,
  type WeightsState,
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
  /** Where the destination comes from (plan frames without a basis are GPS plans). */
  basis: PlanBasis | null;
  origin: string | null;
  destination: string | null;
  distanceRemainingNm: number | null;
  eteMin: number | null;
  /** 0–1 along the planned distance, or null when it cannot be derived. */
  progress: number | null;
  flownNm: number | null;
}

const EMPTY_ROUTE: RouteView = {
  basis: null,
  origin: null,
  destination: null,
  distanceRemainingNm: null,
  eteMin: null,
  progress: null,
  flownNm: null,
};

/** Short label for the route source; the connector computes manual/mission figures. */
export const PLAN_BASIS_LABELS: Record<PlanBasis, string> = {
  gps: "GPS plan",
  manual: "Manual",
  mission: "Mission",
};

/**
 * Wall-clock ETA (ms, rounded to the minute) from the current time and the ETE the plan
 * domain reports; null when either is unknown. Used for the destination forecast marker.
 */
export function arrivalEtaMs(now: number | null, eteMinutes: number | null): number | null {
  if (now === null || !finite(eteMinutes) || eteMinutes < 0) return null;
  return Math.round((now + eteMinutes * 60_000) / 60_000) * 60_000;
}

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
  const basis = plan.basis ?? "gps";
  // The plan's own ETE (GPS ETE, or the connector's distance / ground speed) comes first.
  // Manual and mission plans have no ETE below taxi speeds and none is made up here; older
  // GPS plans without one keep the remaining distance / ground speed estimate.
  const ete = finite(plan.eteSec)
    ? plan.eteSec / 60
    : basis === "gps"
      ? eteMin(remaining, state.sim.motion?.gsKt)
      : null;
  return {
    basis,
    origin: plan.origin ?? null,
    destination: plan.destination ?? null,
    distanceRemainingNm: remaining,
    eteMin: ete,
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
  /**
   * True when the event carries the connector analyser's own result (touchdownSchema
   * with rateSource); false for older/authored payloads graded in the browser.
   */
  analysed: boolean;
  rateSource: RateSource | null;
  bounces: number | null;
}

function field(data: unknown, key: string): number | null {
  if (typeof data !== "object" || data === null) return null;
  const value = (data as Record<string, unknown>)[key];
  return finite(value) ? value : null;
}

/**
 * The most recent `touchdown` event of the current flight: a later `flight.started`
 * hides it so the card resets for the next leg. Connector events are parsed with the
 * protocol's touchdownSchema and keep the connector's grade; anything else (older
 * connectors, the authored demo fixture) is read defensively and graded here.
 */
export function latestTouchdown(events: readonly ReceivedEvent[]): TouchdownView | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i];
    if (!ev) continue;
    if (ev.msg.name === "flight.started") return null;
    if (ev.msg.name !== "touchdown") continue;
    const data = ev.msg.data;
    const base = { seq: ev.msg.seq, at: ev.at, source: ev.msg.source };
    const parsed = touchdownSchema.safeParse(data);
    if (parsed.success) {
      const td = parsed.data;
      return {
        ...base,
        rateFpm: td.rateFpm,
        gForce: td.peakG,
        gsKt: td.gsKt,
        bankDeg: td.bankDeg,
        pitchDeg: td.pitchDeg,
        lat: td.lat,
        lon: td.lon,
        grade: td.grade,
        analysed: true,
        rateSource: td.rateSource,
        bounces: td.bounces,
      };
    }
    const rateFpm = field(data, "rateFpm");
    const gForce = field(data, "peakG") ?? field(data, "gForce");
    return {
      ...base,
      rateFpm,
      gForce,
      gsKt: field(data, "gsKt"),
      bankDeg: field(data, "bankDeg"),
      pitchDeg: field(data, "pitchDeg"),
      lat: field(data, "lat"),
      lon: field(data, "lon"),
      grade: landingGrade(rateFpm, gForce),
      analysed: false,
      rateSource: null,
      bounces: field(data, "bounces"),
    };
  }
  return null;
}

export interface FlightSummaryView {
  status: FlightState["status"] | null;
  active: boolean;
  distanceNm: number | null;
  blockMin: number | null;
  airborneMin: number | null;
  fuelUsedLb: number | null;
  maxAltFt: number | null;
  flags: FlightState["flags"] | null;
}

/** Tracked-flight summary from the `flight` domain; null fields when not reported. */
export function flightSummary(flight: FlightState | null | undefined): FlightSummaryView | null {
  if (!flight) return null;
  const distance = finite(flight.distanceNm)
    ? flight.distanceNm
    : finite(flight.flownDistanceNm)
      ? flight.flownDistanceNm
      : null;
  const block = finite(flight.blockMin)
    ? flight.blockMin
    : finite(flight.elapsedSec)
      ? flight.elapsedSec / 60
      : null;
  return {
    status: flight.status ?? null,
    active: flight.active,
    distanceNm: distance,
    blockMin: block,
    airborneMin: finite(flight.airborneMin) ? flight.airborneMin : null,
    fuelUsedLb: finite(flight.fuelUsedLb) ? flight.fuelUsedLb : null,
    maxAltFt: finite(flight.maxAltFt) ? flight.maxAltFt : null,
    flags: flight.flags ?? null,
  };
}
