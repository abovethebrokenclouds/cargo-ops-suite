// Inputs shared by the flight core (phase FSM, landing analyser, flight tracker):
// one FlightSample per received motion update, built only from real domain values,
// plus the simulation clock and the on-ground debouncer.

import type {
  ControlsState,
  EnginesState,
  FuelState,
  MotionState,
  PositionState,
  SimDomainState,
} from "../protocol";

export interface FlightSample {
  /** Simulation clock, ms (see SimClock). */
  tMs: number;
  /** Raw IS ON GROUND (or SIM ON GROUND) as reported; debounce before use. */
  onGround: boolean;
  lat: number;
  lon: number;
  altFt: number;
  aglFt: number;
  iasKt: number;
  gsKt: number;
  vsFpm: number;
  hdgTrueDeg: number;
  gForce: number;
  /** Null when the controls domain is missing. */
  parkingBrake: boolean | null;
  /** True when any engine runs; null when the engines domain is missing or empty. */
  enginesRunning: boolean | null;
  /** Null when the fuel domain is missing. */
  fuelLb: number | null;
  paused: boolean;
  simRate: number;
  touchdownVelocityFpm?: number;
  touchdownBankDeg?: number;
  touchdownPitchDeg?: number;
}

export interface SampleDomains {
  position?: PositionState | null | undefined;
  motion?: MotionState | null | undefined;
  controls?: ControlsState | null | undefined;
  engines?: EnginesState | null | undefined;
  fuel?: FuelState | null | undefined;
  sim?: SimDomainState | null | undefined;
}

/** Build a sample from the current domains, or null when position or motion is missing. */
export function sampleFrom(domains: SampleDomains, tMs: number): FlightSample | null {
  const { position, motion } = domains;
  if (!position || !motion) return null;
  const running = domains.engines?.running;
  const sample: FlightSample = {
    tMs,
    onGround: motion.onGround,
    lat: position.lat,
    lon: position.lon,
    altFt: position.altFt,
    aglFt: position.aglFt,
    iasKt: motion.iasKt,
    gsKt: motion.gsKt,
    vsFpm: motion.vsFpm,
    hdgTrueDeg: motion.hdgTrueDeg,
    gForce: motion.gForce,
    parkingBrake: domains.controls ? domains.controls.parkingBrake : null,
    enginesRunning: running && running.length > 0 ? running.some(Boolean) : null,
    fuelLb: domains.fuel ? domains.fuel.totalLb : null,
    paused: domains.sim?.paused ?? false,
    simRate: domains.sim?.simRate ?? 1,
  };
  if (motion.touchdownVelocityFpm !== undefined) {
    sample.touchdownVelocityFpm = motion.touchdownVelocityFpm;
  }
  if (motion.touchdownBankDeg !== undefined) sample.touchdownBankDeg = motion.touchdownBankDeg;
  if (motion.touchdownPitchDeg !== undefined) sample.touchdownPitchDeg = motion.touchdownPitchDeg;
  return sample;
}

/**
 * Simulation clock in ms. Frames carry no sim time unless a replay states it
 * (`sim.simTimeSec`), so by default it advances by the receive clock × sim rate
 * and stops while paused. When `simTimeSec` is present its increments are used
 * instead (still stopped while paused). Never goes backwards.
 */
export class SimClock {
  private simMs = 0;
  private lastRecvMs: number | null = null;
  private lastSimTimeSec: number | null = null;

  get nowMs(): number {
    return this.simMs;
  }

  advance(recvMs: number, sim: { paused: boolean; simRate: number; simTimeSec?: number }): number {
    let delta = 0;
    if (sim.simTimeSec !== undefined && this.lastSimTimeSec !== null) {
      delta = (sim.simTimeSec - this.lastSimTimeSec) * 1000;
    } else if (this.lastRecvMs !== null) {
      const rate = Number.isFinite(sim.simRate) && sim.simRate > 0 ? sim.simRate : 1;
      delta = (recvMs - this.lastRecvMs) * rate;
    }
    if (!sim.paused && Number.isFinite(delta) && delta > 0) this.simMs += delta;
    this.lastRecvMs = recvMs;
    this.lastSimTimeSec = sim.simTimeSec ?? null;
    return this.simMs;
  }

  reset(): void {
    this.simMs = 0;
    this.lastRecvMs = null;
    this.lastSimTimeSec = null;
  }
}

/**
 * On-ground debounce (idea from MSFS-Landing-Inspector, MIT: require several
 * consecutive samples before believing a ground/air change). The first sample is
 * taken as is.
 */
export class GroundDebouncer {
  private stable: boolean | null = null;
  private pending: boolean | null = null;
  private count = 0;

  constructor(private readonly samples: number) {}

  get value(): boolean | null {
    return this.stable;
  }

  update(raw: boolean): boolean {
    if (this.stable === null) {
      this.stable = raw;
      return raw;
    }
    if (raw === this.stable) {
      this.pending = null;
      this.count = 0;
      return this.stable;
    }
    if (this.pending !== raw) {
      this.pending = raw;
      this.count = 0;
    }
    this.count++;
    if (this.count >= this.samples) {
      this.stable = raw;
      this.pending = null;
      this.count = 0;
    }
    return this.stable;
  }

  reset(): void {
    this.stable = null;
    this.pending = null;
    this.count = 0;
  }
}

/** How long (sim ms) a condition has held continuously; 0 when false. */
export class Sustain {
  private since: number | null = null;

  update(condition: boolean, tMs: number): number {
    if (!condition) {
      this.since = null;
      return 0;
    }
    if (this.since === null) this.since = tMs;
    return tMs - this.since;
  }

  reset(): void {
    this.since = null;
  }
}

const EARTH_RADIUS_NM = 3440.065;
const rad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle (haversine) distance in nautical miles. */
export function greatCircleNm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}
