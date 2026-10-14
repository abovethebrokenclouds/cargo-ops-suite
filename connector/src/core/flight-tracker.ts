// Flight tracker and verifier (plan §6.4). Pure and deterministic over
// FlightSamples + phase transitions; the wall clock is injected and only used for
// the startedAt/endedAt stamps.
//
// - A "leg" starts at block-out (entering TaxiOut), at takeoff when no leg exists,
//   or on an explicit flight.start. Distance, block time, fuel and max altitude
//   count from there.
// - The flight becomes active (flight.started) at takeoff or on flight.start, and
//   ends (flight.ended) on Arrived (completed), flight.end (completed when Arrived,
//   else aborted on request), a crash (failed) or a session reset (aborted).
// - Distance: great circle between fixes taken at most once per sim second (≤ 1 Hz).
//   A jump longer than max(GS) × Δt × 3 + 0.05 nm sets the teleport flag and is
//   not counted.
// - Pause stops the mission clock (the sim clock does not advance while paused).
// - Sim rate: > 1× sets noBonus, > 8× sets invalidated (both sticky for the flight).
//   Rates up to 4× are allowed; mission rules (P3) decide what 4–8× costs.

import type { FlightFlags, FlightPhase, FlightState, FlightStatus, Touchdown } from "../protocol";
import { greatCircleNm, type FlightSample } from "./flight-sample";
import type { PhaseTransition } from "./phase-fsm";

export interface TrackerConfig {
  distanceIntervalMs: number;
  teleportFactor: number;
  teleportEpsilonNm: number;
  noBonusAboveRate: number;
  invalidAboveRate: number;
}

export const DEFAULT_TRACKER_CONFIG: TrackerConfig = {
  distanceIntervalMs: 1_000,
  teleportFactor: 3,
  teleportEpsilonNm: 0.05,
  noBonusAboveRate: 1,
  invalidAboveRate: 8,
};

/** What the tracker knows about the route and aircraft, from the plan/aircraft domains. */
export interface TrackerContext {
  origin?: string | undefined;
  destination?: string | undefined;
  /** GPS distance to destination right now, nm. */
  destDistanceNm?: number | undefined;
  aircraftTitle?: string | undefined;
}

export interface FlightRecord {
  id: string;
  status: FlightStatus;
  startedAt: string;
  endedAt?: string;
  origin?: string;
  destination?: string;
  aircraftTitle?: string;
  plannedDistanceNm?: number;
  distanceNm: number;
  blockMin: number;
  airborneMin: number;
  maxAltFt: number;
  fuelUsedLb: number;
  flags: FlightFlags;
  landings: Touchdown[];
}

export type TrackerEvent =
  { name: "flight.started"; data: FlightRecord } | { name: "flight.ended"; data: FlightRecord };

export type TrackerResult =
  | { ok: true; record: FlightRecord; events: TrackerEvent[] }
  | { ok: false; code: string; message: string };

interface Leg {
  startWallMs: number;
  startTMs: number;
  lastTMs: number;
  wasAirborne: boolean;
  blockMs: number;
  airborneMs: number;
  distanceNm: number;
  fix: { tMs: number; lat: number; lon: number; gsKt: number };
  startFuelLb: number | null;
  fuelUsedLb: number;
  maxAltFt: number;
  flags: FlightFlags;
}

interface ActiveFlight {
  id: string;
  ctx: TrackerContext;
  plannedDistanceNm?: number;
  landings: Touchdown[];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export class FlightTracker {
  private readonly config: TrackerConfig;
  private leg: Leg | null = null;
  private flight: ActiveFlight | null = null;
  /** Last published domain (kept after the flight ends so the summary stays visible). */
  private last: FlightState | null = null;

  constructor(
    private readonly now: () => number,
    private readonly newId: () => string,
    config: Partial<TrackerConfig> = {},
  ) {
    this.config = { ...DEFAULT_TRACKER_CONFIG, ...config };
  }

  get active(): boolean {
    return this.flight !== null;
  }

  get legActive(): boolean {
    return this.leg !== null;
  }

  get flightId(): string | null {
    return this.flight?.id ?? null;
  }

  /** Current `flight` domain, or null before the first flight. */
  domain(): FlightState | null {
    if (this.flight && this.leg) this.last = this.buildDomain(this.flight, this.leg);
    return this.last;
  }

  /** Feed one sample after the FSM has seen it. */
  onSample(
    s: FlightSample,
    transition: PhaseTransition | null,
    airborne: boolean,
    ctx: TrackerContext,
  ): TrackerEvent[] {
    const events: TrackerEvent[] = [];
    if (transition?.to === "TaxiOut" && !this.flight) this.beginLeg(s);
    if (transition?.to === "Takeoff" && !this.flight) {
      if (!this.leg) this.beginLeg(s);
      events.push(this.startFlight(ctx));
    }
    if (this.leg) this.advance(this.leg, s, airborne);
    if (transition?.to === "Arrived" && this.flight) {
      events.push(this.finish("completed"));
    }
    return events;
  }

  onTouchdown(td: Touchdown): void {
    this.flight?.landings.push(td);
  }

  /** flight.start preconditions without starting: null when a start would be accepted. */
  precheck(
    s: FlightSample | null,
    onGround: boolean | null,
  ): { ok: false; code: string; message: string } | null {
    const r = this.check(s, onGround);
    return r.ok ? null : r;
  }

  private check(
    s: FlightSample | null,
    onGround: boolean | null,
  ): { ok: true; sample: FlightSample } | { ok: false; code: string; message: string } {
    if (this.flight) {
      return { ok: false, code: "flight_active", message: "A flight is already running" };
    }
    if (!s) return { ok: false, code: "no_data", message: "No position/motion data yet" };
    if (onGround !== true) {
      return {
        ok: false,
        code: "not_on_ground",
        message: "Start requires the aircraft on the ground",
      };
    }
    if (s.parkingBrake !== true) {
      return { ok: false, code: "brake_not_set", message: "Start requires the parking brake set" };
    }
    return { ok: true, sample: s };
  }

  /** flight.start: on the ground with the parking brake set, no flight running. */
  start(s: FlightSample | null, onGround: boolean | null, ctx: TrackerContext): TrackerResult {
    const check = this.check(s, onGround);
    if (!check.ok) return check;
    s = check.sample;
    this.beginLeg(s);
    const event = this.startFlight(ctx);
    return { ok: true, record: event.data, events: [event] };
  }

  /** flight.end: completed when Arrived; otherwise only with abort=true (status aborted). */
  end(phase: FlightPhase | null, abort: boolean): TrackerResult {
    if (!this.flight) return { ok: false, code: "no_flight", message: "No flight is running" };
    if (phase !== "Arrived" && !abort) {
      return {
        ok: false,
        code: "not_arrived",
        message:
          "The aircraft has not arrived (parked, engines off, brake set); pass abort to end it anyway",
      };
    }
    const event = this.finish(phase === "Arrived" ? "completed" : "aborted");
    return { ok: true, record: event.data, events: [event] };
  }

  /** Simulator crash: the flight fails. */
  crash(): TrackerEvent[] {
    if (this.leg) this.leg.flags.crashed = true;
    if (this.flight) return [this.finish("failed")];
    this.leg = null;
    return [];
  }

  /** The simulator link dropped with no flight running: a half-begun leg is forgotten. */
  dropPendingLeg(): void {
    if (!this.flight) this.leg = null;
  }

  /** Session reset (new snapshot, replay restart): a running flight is aborted. */
  reset(): TrackerEvent[] {
    const events = this.flight ? [this.finish("aborted")] : [];
    this.leg = null;
    this.last = null;
    return events;
  }

  private beginLeg(s: FlightSample): void {
    this.leg = {
      startWallMs: this.now(),
      startTMs: s.tMs,
      lastTMs: s.tMs,
      wasAirborne: false,
      blockMs: 0,
      airborneMs: 0,
      distanceNm: 0,
      fix: { tMs: s.tMs, lat: s.lat, lon: s.lon, gsKt: s.gsKt },
      startFuelLb: s.fuelLb,
      fuelUsedLb: 0,
      maxAltFt: s.altFt,
      flags: {
        teleport: false,
        noBonus: false,
        invalidated: false,
        crashed: false,
        paused: s.paused,
      },
    };
    this.applyRate(this.leg, s);
  }

  private startFlight(ctx: TrackerContext): { name: "flight.started"; data: FlightRecord } {
    const leg = this.leg;
    if (!leg) throw new Error("startFlight without a leg");
    const flight: ActiveFlight = { id: this.newId(), ctx: { ...ctx }, landings: [] };
    if (ctx.destDistanceNm !== undefined) {
      flight.plannedDistanceNm = round1(leg.distanceNm + ctx.destDistanceNm);
    }
    this.flight = flight;
    this.last = this.buildDomain(flight, leg);
    return { name: "flight.started", data: this.record(flight, leg, "active") };
  }

  private finish(status: FlightStatus): { name: "flight.ended"; data: FlightRecord } {
    const flight = this.flight;
    const leg = this.leg;
    if (!flight || !leg) throw new Error("finish without a flight");
    const endedAt = new Date(this.now()).toISOString();
    const record = { ...this.record(flight, leg, status), endedAt };
    this.last = { ...this.buildDomain(flight, leg), active: false, status, endedAt };
    this.flight = null;
    this.leg = null;
    return { name: "flight.ended", data: record };
  }

  private advance(leg: Leg, s: FlightSample, airborne: boolean): void {
    const c = this.config;
    const dt = Math.max(0, s.tMs - leg.lastTMs);
    leg.blockMs += dt;
    if (leg.wasAirborne) leg.airborneMs += dt;
    leg.wasAirborne = airborne;
    leg.lastTMs = s.tMs;
    leg.maxAltFt = Math.max(leg.maxAltFt, s.altFt);
    leg.flags.paused = s.paused;
    this.applyRate(leg, s);
    if (s.fuelLb !== null) {
      if (leg.startFuelLb === null) leg.startFuelLb = s.fuelLb;
      leg.fuelUsedLb = Math.max(0, leg.startFuelLb - s.fuelLb);
    }
    const fixDt = s.tMs - leg.fix.tMs;
    if (fixDt >= c.distanceIntervalMs) {
      const d = greatCircleNm(leg.fix, s);
      const allowed =
        Math.max(leg.fix.gsKt, s.gsKt) * (fixDt / 3_600_000) * c.teleportFactor +
        c.teleportEpsilonNm;
      if (d > allowed) leg.flags.teleport = true;
      else leg.distanceNm += d;
      leg.fix = { tMs: s.tMs, lat: s.lat, lon: s.lon, gsKt: s.gsKt };
    }
  }

  private applyRate(leg: Leg, s: FlightSample): void {
    if (s.simRate > this.config.noBonusAboveRate) leg.flags.noBonus = true;
    if (s.simRate > this.config.invalidAboveRate) leg.flags.invalidated = true;
  }

  private record(flight: ActiveFlight, leg: Leg, status: FlightStatus): FlightRecord {
    const r: FlightRecord = {
      id: flight.id,
      status,
      startedAt: new Date(leg.startWallMs).toISOString(),
      distanceNm: round1(leg.distanceNm),
      blockMin: round1(leg.blockMs / 60_000),
      airborneMin: round1(leg.airborneMs / 60_000),
      maxAltFt: Math.round(leg.maxAltFt),
      fuelUsedLb: round1(leg.fuelUsedLb),
      flags: { ...leg.flags },
      landings: [...flight.landings],
    };
    if (flight.ctx.origin) r.origin = flight.ctx.origin;
    if (flight.ctx.destination) r.destination = flight.ctx.destination;
    if (flight.ctx.aircraftTitle) r.aircraftTitle = flight.ctx.aircraftTitle;
    if (flight.plannedDistanceNm !== undefined) r.plannedDistanceNm = flight.plannedDistanceNm;
    return r;
  }

  private buildDomain(flight: ActiveFlight, leg: Leg): FlightState {
    const r = this.record(flight, leg, "active");
    const d: FlightState = {
      active: true,
      id: r.id,
      status: "active",
      startedAt: r.startedAt,
      distanceNm: r.distanceNm,
      flownDistanceNm: r.distanceNm,
      elapsedSec: Math.round(leg.blockMs / 1000),
      blockMin: r.blockMin,
      airborneMin: r.airborneMin,
      maxAltFt: r.maxAltFt,
      fuelUsedLb: r.fuelUsedLb,
      flags: r.flags,
    };
    if (r.origin) d.origin = r.origin;
    if (r.destination) d.destination = r.destination;
    if (r.plannedDistanceNm !== undefined) d.plannedDistanceNm = r.plannedDistanceNm;
    return d;
  }
}
