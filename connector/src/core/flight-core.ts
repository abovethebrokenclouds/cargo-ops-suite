// Flight core: runs the phase FSM, the landing analyser and the flight tracker on
// every motion update the store receives, and publishes their results through
// the same store (phase/flight domains, phase.changed/touchdown/flight.* events).
// It is the only producer of those domains and events: FakeSource strips any
// that a fixture contains, so replays are recomputed from raw telemetry.
//
// Simulator link loss (MSFS quit, crashed, pipe broken): the session clears every
// sim-derived domain, including phase and flight, and calls onDisconnect(). Until the
// next real sample the core holds no live input: while the link is down flight.start and a
// plain flight.end are refused with `sim_offline` (an abort is still allowed; after the
// reconnect but before a sample, start answers `no_data`), nothing is published as the
// flight domain, and the offline time is never counted (the sim clock resumes where it
// stopped). A running flight is suspended, not ended: its phase is kept and it resumes
// on the first sample after the reconnect, where the usual checks apply (a position jump
// sets the teleport flag). Without a running flight the phase and a half-begun leg are
// forgotten, as at session start.
//
// SimStop (back to the main menu) is not a link loss: the link stays up and the source
// reports it as a pause (effective pause = pause flag OR sim not running, see
// sim/pause-state.ts), so the running flight keeps its id and phase, its clock (block time,
// air time, the economy's sim minutes) stops at the stop and resumes at SimStart.

import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type Command,
  type FlightState,
  type PlanState,
  type AircraftState,
  type Result,
  type SimDomainState,
  type SimStatePatch,
} from "../protocol";
import type { LogFn } from "../sim/source";
import type { FlightRepo } from "../storage/flights";
import { SimClock, sampleFrom, type FlightSample, type SampleDomains } from "./flight-sample";
import {
  FlightTracker,
  type FlightRecord,
  type TrackerConfig,
  type TrackerContext,
  type TrackerEvent,
} from "./flight-tracker";
import { LandingAnalyser, type LandingConfig } from "./landing-analyser";
import { PhaseFsm, type PhaseFsmConfig, type PhaseTransition } from "./phase-fsm";
import type { StateStore } from "./store";
import { TelemetryRecorder } from "./telemetry-recorder";

/** Optional observers (the economy engine) of the flight core's lifecycle. */
export interface FlightHooks {
  /** Extra flight.start preconditions (e.g. the loaded mission's origin); null = allowed. */
  beforeStart?(sample: FlightSample): {
    code: string;
    message: string;
    reasons?: Array<{ code: string; message: string }>;
  } | null;
  /** Every processed sample, after the tracker (flight = the running flight's domain). */
  onSample?(sample: FlightSample, flight: FlightState | null, onGround: boolean | null): void;
  onFlightStarted?(record: FlightRecord, explicit: boolean): void;
  /** After the flight row is saved, before the flight.ended event. */
  onFlightEnded?(record: FlightRecord, last: FlightSample | null): void;
  /** The store was reset (session start, replay restart). */
  onReset?(): void;
  /** The simulator link dropped; the session already cleared the sim-derived domains. */
  onSimOffline?(): void;
  /** Reference approach speed for the landing speed grade, kt. */
  referenceSpeedKt?(): number | null;
}

export interface FlightCoreOptions {
  store: StateStore;
  log?: LogFn;
  repo?: FlightRepo | null;
  /** Wall clock for startedAt/endedAt (tests inject a fixed one). */
  now?: () => number;
  newId?: () => string;
  phase?: Partial<PhaseFsmConfig>;
  landing?: Partial<LandingConfig>;
  tracker?: Partial<TrackerConfig>;
  hooks?: FlightHooks;
}

export class FlightCore {
  readonly fsm: PhaseFsm;
  readonly analyser: LandingAnalyser;
  readonly tracker: FlightTracker;
  readonly clock = new SimClock();
  readonly telemetry: TelemetryRecorder;
  private readonly store: StateStore;
  private readonly log: LogFn;
  private readonly repo: FlightRepo | null;
  private lastSample: FlightSample | null = null;
  private publishedFlightId: string | null = null;
  private explicitStart = false;
  /** False between a simulator disconnect and the reconnect. */
  private simLinked = true;
  /** True from a simulator disconnect until the first real sample after it. */
  private awaitingSample = false;
  hooks: FlightHooks;

  constructor(options: FlightCoreOptions) {
    this.store = options.store;
    this.log = options.log ?? (() => {});
    this.repo = options.repo ?? null;
    this.hooks = options.hooks ?? {};
    this.fsm = new PhaseFsm(options.phase);
    this.analyser = new LandingAnalyser(options.landing);
    this.tracker = new FlightTracker(
      options.now ?? Date.now,
      options.newId ?? randomUUID,
      options.tracker,
    );
    this.telemetry = new TelemetryRecorder((id, rows) =>
      this.persist(() => this.repo?.addTelemetry(id, rows)),
    );
  }

  /** The store was reset from a snapshot (session start, replay restart). */
  onReset(atMs: number): void {
    this.handleTrackerEvents(this.tracker.reset());
    this.fsm.reset();
    this.analyser.reset();
    this.clock.reset();
    this.telemetry.end();
    this.lastSample = null;
    this.publishedFlightId = null;
    this.hooks.onReset?.();
    this.process(atMs);
  }

  /**
   * The simulator link dropped (see the header): forget every live input, suspend a
   * running flight, refuse sim-dependent commands until real samples arrive again.
   */
  onDisconnect(): void {
    this.simLinked = false;
    this.awaitingSample = true;
    this.lastSample = null;
    this.analyser.reset();
    this.clock.suspend();
    if (this.tracker.active) {
      this.fsm.suspend();
    } else {
      this.fsm.reset();
      this.tracker.dropPendingLeg();
      this.telemetry.end();
    }
    this.hooks.onSimOffline?.();
  }

  /** The simulator link is back; live inputs return with its first sample. */
  onConnect(): void {
    this.simLinked = true;
  }

  /**
   * A data patch was applied to the store; samples are taken on motion updates. A pause
   * change without motion (SimStop / SimStart, a pause event) still marks the sim clock, so
   * the time until the next frame is attributed to the right state: no frames arrive in the
   * main menu, and the first frame after SimStart must not count the menu time.
   */
  onData(patch: SimStatePatch, atMs: number): void {
    if (patch.motion) {
      this.process(atMs);
      return;
    }
    if (patch.sim === undefined) return;
    const sim = this.store.getDomain("sim") as SimDomainState | null | undefined;
    const paused = sim?.paused ?? false;
    if (paused === this.clock.paused) return;
    this.clock.advance(atMs, {
      paused,
      simRate: sim?.simRate ?? 1,
      ...(sim?.simTimeSec !== undefined ? { simTimeSec: sim.simTimeSec } : {}),
    });
  }

  /** A simulator event passed through the store. */
  onEvent(name: string): void {
    if (name !== "crash") return;
    this.log("warn", "Crash reported by the simulator; the flight fails");
    this.handleTrackerEvents(this.tracker.crash());
    this.fsm.reset();
    this.analyser.reset();
    this.telemetry.end();
    this.publishFlight();
  }

  /** flight.start / flight.end; other commands are not implemented yet. */
  command(cmd: Command): Result {
    if (cmd.name === "flight.start") {
      if (!this.simLinked) return offline(cmd.id, "start the flight once it is running again");
      const pre = this.tracker.precheck(this.lastSample, this.fsm.onGround);
      if (pre) return failure(cmd.id, pre.code, pre.message);
      const blocked = this.lastSample ? (this.hooks.beforeStart?.(this.lastSample) ?? null) : null;
      if (blocked) return failure(cmd.id, blocked.code, blocked.message, blocked.reasons);
      this.explicitStart = true;
      const result = this.tracker.start(this.lastSample, this.fsm.onGround, this.context());
      if (!result.ok) {
        this.explicitStart = false;
        return failure(cmd.id, result.code, result.message);
      }
      const transition = this.fsm.restart();
      if (transition) this.publishPhase(transition);
      if (this.lastSample) this.telemetry.begin(this.lastSample.tMs);
      this.handleTrackerEvents(result.events);
      this.explicitStart = false;
      this.publishFlight();
      return success(cmd.id, result.record);
    }
    if (cmd.name === "flight.end") {
      const args = cmd.args;
      const abort =
        typeof args === "object" &&
        args !== null &&
        (args as Record<string, unknown>)["abort"] === true;
      if (!abort && !this.simLinked && this.tracker.active) {
        return offline(cmd.id, "arrival cannot be checked; pass abort to end the flight anyway");
      }
      const result = this.tracker.end(this.fsm.phase, abort);
      if (!result.ok) return failure(cmd.id, result.code, result.message);
      this.handleTrackerEvents(result.events);
      // Aborted while the sim is gone: the phase kept for the flight is no longer needed.
      if (this.awaitingSample) this.fsm.reset();
      this.publishFlight();
      return success(cmd.id, result.record);
    }
    return failure(
      cmd.id,
      "not_implemented",
      `Command ${cmd.name} is not implemented in this connector version`,
    );
  }

  private domains(): SampleDomains {
    const get = <T>(d: Parameters<StateStore["getDomain"]>[0]) =>
      (this.store.getDomain(d) ?? null) as T | null;
    return {
      position: get("position"),
      motion: get("motion"),
      controls: get("controls"),
      engines: get("engines"),
      fuel: get("fuel"),
      sim: get("sim"),
    };
  }

  private context(): TrackerContext {
    const plan = (this.store.getDomain("plan") ?? null) as PlanState | null;
    const aircraft = (this.store.getDomain("aircraft") ?? null) as AircraftState | null;
    return {
      origin: plan?.origin,
      destination: plan?.destination,
      destDistanceNm: plan?.destDistanceNm,
      aircraftTitle: aircraft?.title,
    };
  }

  private process(atMs: number): void {
    const domains = this.domains();
    const sim = domains.sim as SimDomainState | null | undefined;
    const tMs = this.clock.advance(atMs, {
      paused: sim?.paused ?? false,
      simRate: sim?.simRate ?? 1,
      ...(sim?.simTimeSec !== undefined ? { simTimeSec: sim.simTimeSec } : {}),
    });
    const sample = sampleFrom(domains, tMs);
    if (!sample) return;
    this.lastSample = sample;
    const resumed = this.awaitingSample;
    this.awaitingSample = false;

    const before = this.fsm.phase;
    const transition = this.fsm.update(sample);
    // First phase of a session, or the kept phase of a flight resumed after a reconnect.
    if ((before === null || resumed) && this.fsm.phase !== null) {
      this.store.apply({ phase: { current: this.fsm.phase } });
    }
    if (transition) this.publishPhase(transition);

    this.analyser.referenceSpeedKt = this.hooks.referenceSpeedKt?.() ?? null;
    const touchdown = this.analyser.update(sample);
    if (touchdown) {
      this.store.event("touchdown", touchdown);
      this.tracker.onTouchdown(touchdown);
      this.telemetry.touchdown(this.analyser.lastContactMs ?? sample.tMs);
      this.log(
        "info",
        `Touchdown ${touchdown.rateFpm} fpm (${touchdown.rateSource}), ${touchdown.peakG} G, grade ${touchdown.grade}`,
      );
    }

    const hadLeg = this.tracker.legActive;
    const events = this.tracker.onSample(
      sample,
      transition,
      this.fsm.onGround === false,
      this.context(),
    );
    if (!hadLeg && this.tracker.legActive) this.telemetry.begin(sample.tMs);
    this.telemetry.sample(sample, this.fsm.phase);
    this.handleTrackerEvents(events);
    this.publishFlight();
    this.hooks.onSample?.(
      sample,
      this.tracker.active ? this.tracker.domain() : null,
      this.fsm.onGround,
    );
  }

  private publishPhase(transition: PhaseTransition): void {
    this.store.apply({ phase: { current: transition.to } });
    this.store.event("phase.changed", { from: transition.from, to: transition.to });
  }

  private handleTrackerEvents(events: TrackerEvent[]): void {
    for (const event of events) {
      const record: FlightRecord = event.data;
      if (event.name === "flight.started") {
        this.persist(() => this.repo?.save(record));
        this.telemetry.attach(record.id);
        this.log("info", `Flight ${record.id} started`);
        this.store.event(event.name, record);
        this.hooks.onFlightStarted?.(record, this.explicitStart);
        continue;
      } else {
        this.persist(() => this.repo?.save(record));
        this.telemetry.end();
        this.hooks.onFlightEnded?.(record, this.lastSample);
        this.log(
          "info",
          `Flight ${record.id} ended (${record.status}): ${record.distanceNm} nm, block ${record.blockMin} min`,
        );
      }
      this.store.event(event.name, record);
    }
  }

  private publishFlight(): void {
    // Nothing is published as live while the simulator is gone; the next sample does it.
    if (this.awaitingSample) return;
    const domain: FlightState | null = this.tracker.domain();
    if (!domain) return;
    if (domain.id !== this.publishedFlightId) {
      // A new flight never inherits fields (endedAt, …) from the previous one.
      if (this.publishedFlightId !== null) this.store.apply({ flight: null });
      this.publishedFlightId = domain.id ?? null;
    }
    this.store.apply({ flight: domain });
  }

  private persist(write: () => void): void {
    if (!this.repo) return;
    try {
      write();
    } catch (err) {
      this.log("warn", `Could not write flight data: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function success(id: string, data: unknown): Result {
  return { type: "result", v: PROTOCOL_VERSION, id, ok: true, data };
}

function offline(id: string, what: string): Result {
  return failure(id, "sim_offline", `The simulator is not connected: ${what}`);
}

function failure(
  id: string,
  code: string,
  message: string,
  reasons?: Array<{ code: string; message: string }>,
): Result {
  return {
    type: "result",
    v: PROTOCOL_VERSION,
    id,
    ok: false,
    error: { code, message, ...(reasons?.length ? { reasons } : {}) },
  };
}
