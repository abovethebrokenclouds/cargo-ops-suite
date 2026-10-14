// Flight phase FSM (plan §6.2). Pure and deterministic: it sees FlightSamples in
// order and times every "sustained" condition on the simulation clock, never on
// wall time.
//
//   Boarding ─GS>5 kt (3 s)─▶ TaxiOut ─airborne & GS>30─▶ Takeoff
//   Takeoff/Climb/Cruise/Descent: VS>+300 (30 s) → Climb, |VS|<300 (30 s) → Cruise,
//     VS<−300 (30 s) → Descent, AGL<3,000 & VS<−100 (10 s) → Approach
//   any airborne phase ─ground contact (debounced)─▶ Landing ─GS<30─▶ TaxiIn
//   TaxiIn ─engines off & brake set─▶ Arrived ─GS>5 kt (3 s)─▶ TaxiOut (next leg)
//   Approach ─VS>+300 (30 s)─▶ Climb (go-around)
//   Landing/TaxiIn ─airborne & VS>+300 (30 s)─▶ Climb (touch-and-go)
//
// Forward-only: airborne phases may move among Climb/Cruise/Descent (step climbs
// and descents) but nothing ever returns to Boarding except reset()/restart().

import type { FlightPhase } from "../protocol";
import { GroundDebouncer, Sustain, type FlightSample } from "./flight-sample";

export interface PhaseFsmConfig {
  /** Consecutive samples before an on-ground/airborne change is believed. */
  groundDebounceSamples: number;
  taxiGsKt: number;
  taxiSustainMs: number;
  takeoffGsKt: number;
  taxiInGsKt: number;
  climbVsFpm: number;
  descentVsFpm: number;
  /** |VS| below this is level flight. */
  levelVsFpm: number;
  airborneSustainMs: number;
  approachAglFt: number;
  approachVsFpm: number;
  approachSustainMs: number;
}

export const DEFAULT_PHASE_CONFIG: PhaseFsmConfig = {
  groundDebounceSamples: 3,
  taxiGsKt: 5,
  taxiSustainMs: 3_000,
  takeoffGsKt: 30,
  taxiInGsKt: 30,
  climbVsFpm: 300,
  descentVsFpm: -300,
  levelVsFpm: 300,
  airborneSustainMs: 30_000,
  approachAglFt: 3_000,
  approachVsFpm: -100,
  approachSustainMs: 10_000,
};

export interface PhaseTransition {
  from: FlightPhase;
  to: FlightPhase;
  tMs: number;
}

const AIRBORNE: ReadonlySet<FlightPhase> = new Set([
  "Takeoff",
  "Climb",
  "Cruise",
  "Descent",
  "Approach",
]);

export function isAirbornePhase(phase: FlightPhase | null): boolean {
  return phase !== null && AIRBORNE.has(phase);
}

export class PhaseFsm {
  private current: FlightPhase | null = null;
  private readonly ground: GroundDebouncer;
  private readonly taxi = new Sustain();
  private readonly climb = new Sustain();
  private readonly level = new Sustain();
  private readonly descent = new Sustain();
  private readonly approach = new Sustain();
  private readonly config: PhaseFsmConfig;

  constructor(config: Partial<PhaseFsmConfig> = {}) {
    this.config = { ...DEFAULT_PHASE_CONFIG, ...config };
    this.ground = new GroundDebouncer(this.config.groundDebounceSamples);
  }

  get phase(): FlightPhase | null {
    return this.current;
  }

  /** Debounced on-ground state, null before the first sample. */
  get onGround(): boolean | null {
    return this.ground.value;
  }

  /** Forget everything (new session, replay restart, crash). */
  reset(): void {
    this.current = null;
    this.ground.reset();
    for (const s of [this.taxi, this.climb, this.level, this.descent, this.approach]) s.reset();
  }

  /**
   * The simulator link dropped during a flight: keep the phase (the flight resumes after a
   * reconnect) but forget the on-ground state and every sustained condition, so nothing
   * is believed until real samples arrive again.
   */
  suspend(): void {
    this.ground.reset();
    for (const s of [this.taxi, this.climb, this.level, this.descent, this.approach]) s.reset();
  }

  /** Explicit flight start: back to Boarding without forgetting the ground state. */
  restart(): PhaseTransition | null {
    const from = this.current;
    this.current = "Boarding";
    this.taxi.reset();
    return from && from !== "Boarding" ? { from, to: "Boarding", tMs: 0 } : null;
  }

  /** Feed one sample; returns the transition it caused, if any (at most one per sample). */
  update(s: FlightSample): PhaseTransition | null {
    const c = this.config;
    const onGround = this.ground.update(s.onGround);
    const airborne = !onGround;
    const taxiHeld = this.taxi.update(onGround && s.gsKt > c.taxiGsKt, s.tMs);
    const climbHeld = this.climb.update(airborne && s.vsFpm > c.climbVsFpm, s.tMs);
    const levelHeld = this.level.update(airborne && Math.abs(s.vsFpm) < c.levelVsFpm, s.tMs);
    const descentHeld = this.descent.update(airborne && s.vsFpm < c.descentVsFpm, s.tMs);
    const approachHeld = this.approach.update(
      airborne && s.aglFt < c.approachAglFt && s.vsFpm < c.approachVsFpm,
      s.tMs,
    );

    if (this.current === null) {
      this.current = initialPhase(s, onGround, c);
      return null;
    }

    const next = this.next(this.current, s, {
      onGround,
      taxi: taxiHeld >= c.taxiSustainMs,
      climb: climbHeld >= c.airborneSustainMs,
      level: levelHeld >= c.airborneSustainMs,
      descent: descentHeld >= c.airborneSustainMs,
      approach: approachHeld >= c.approachSustainMs,
    });
    if (next === null || next === this.current) return null;
    const transition = { from: this.current, to: next, tMs: s.tMs };
    this.current = next;
    return transition;
  }

  private next(
    phase: FlightPhase,
    s: FlightSample,
    held: {
      onGround: boolean;
      taxi: boolean;
      climb: boolean;
      level: boolean;
      descent: boolean;
      approach: boolean;
    },
  ): FlightPhase | null {
    const c = this.config;
    const airborne = !held.onGround;
    switch (phase) {
      case "Boarding":
        if (airborne && s.gsKt > c.takeoffGsKt) return "Takeoff";
        return held.taxi ? "TaxiOut" : null;
      case "TaxiOut":
        return airborne && s.gsKt > c.takeoffGsKt ? "Takeoff" : null;
      case "Takeoff":
      case "Climb":
      case "Cruise":
      case "Descent":
        if (held.onGround) return "Landing";
        if (held.approach && phase !== "Takeoff") return "Approach";
        if (held.climb && phase !== "Climb") return "Climb";
        if (held.descent && phase !== "Descent") return "Descent";
        if (held.level && phase !== "Cruise") return "Cruise";
        return null;
      case "Approach":
        if (held.onGround) return "Landing";
        return held.climb ? "Climb" : null;
      case "Landing":
        if (airborne) return held.climb ? "Climb" : null;
        return s.gsKt < c.taxiInGsKt ? "TaxiIn" : null;
      case "TaxiIn":
        if (airborne) return held.climb ? "Climb" : null;
        return s.enginesRunning === false && s.parkingBrake === true ? "Arrived" : null;
      case "Arrived":
        return held.onGround && held.taxi ? "TaxiOut" : null;
    }
  }
}

/** Phase for the very first sample (connector started mid-session). */
function initialPhase(s: FlightSample, onGround: boolean, c: PhaseFsmConfig): FlightPhase {
  if (onGround) return s.gsKt > c.taxiGsKt ? "TaxiOut" : "Boarding";
  if (s.vsFpm > c.climbVsFpm) return "Climb";
  if (s.aglFt < c.approachAglFt && s.vsFpm < c.approachVsFpm) return "Approach";
  if (s.vsFpm < c.descentVsFpm) return "Descent";
  return "Cruise";
}
