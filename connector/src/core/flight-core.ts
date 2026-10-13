// Flight core: runs the phase FSM, the landing analyser and the flight tracker on
// every motion update the store receives, and publishes their results through
// the same store (phase/flight domains, phase.changed/touchdown/flight.* events).
// It is the only producer of those domains and events: FakeSource strips any
// that a fixture contains, so replays are recomputed from raw telemetry.

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

  constructor(options: FlightCoreOptions) {
    this.store = options.store;
    this.log = options.log ?? (() => {});
    this.repo = options.repo ?? null;
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
    this.process(atMs);
  }

  /** A data patch was applied to the store; samples are taken on motion updates. */
  onData(patch: SimStatePatch, atMs: number): void {
    if (patch.motion) this.process(atMs);
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
      const result = this.tracker.start(this.lastSample, this.fsm.onGround, this.context());
      if (!result.ok) return failure(cmd.id, result.code, result.message);
      const transition = this.fsm.restart();
      if (transition) this.publishPhase(transition);
      if (this.lastSample) this.telemetry.begin(this.lastSample.tMs);
      this.handleTrackerEvents(result.events);
      this.publishFlight();
      return success(cmd.id, result.record);
    }
    if (cmd.name === "flight.end") {
      const args = cmd.args;
      const abort =
        typeof args === "object" &&
        args !== null &&
        (args as Record<string, unknown>)["abort"] === true;
      const result = this.tracker.end(this.fsm.phase, abort);
      if (!result.ok) return failure(cmd.id, result.code, result.message);
      this.handleTrackerEvents(result.events);
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

    const before = this.fsm.phase;
    const transition = this.fsm.update(sample);
    if (before === null && this.fsm.phase !== null) {
      this.store.apply({ phase: { current: this.fsm.phase } });
    }
    if (transition) this.publishPhase(transition);

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
      } else {
        this.persist(() => this.repo?.save(record));
        this.telemetry.end();
        this.log(
          "info",
          `Flight ${record.id} ended (${record.status}): ${record.distanceNm} nm, block ${record.blockMin} min`,
        );
      }
      this.store.event(event.name, record);
    }
  }

  private publishFlight(): void {
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

function failure(id: string, code: string, message: string): Result {
  return { type: "result", v: PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}
