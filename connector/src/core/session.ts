// Connector session: wires one SimSource into the StateStore and owns the
// welcome message. `welcome.sim.connected` comes only from the source's link
// state, which SimConnectSource sets after node-simconnect's open() resolved.

import { randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  type Command,
  type Result,
  type SimStatePatch,
  type Welcome,
} from "../protocol";
import { airportLookup, type EconomyAirport } from "../economy";
import type { LogFn, SimSource } from "../sim/source";
import { EconomyEngine, type EconomyOptions } from "./economy/engine";
import { FlightCore, type FlightCoreOptions } from "./flight-core";
import { PlanResolver } from "./plan";
import { StateStore } from "./store";

/**
 * Domains that describe the simulator, or are computed from it by the flight core (phase,
 * flight); cleared when the link drops so stale values never look live. The flight core
 * republishes phase and flight on the first real sample after a reconnect.
 */
const SIM_DERIVED_DOMAINS = [
  "sim",
  "aircraft",
  "position",
  "motion",
  "fuel",
  "weights",
  "payload",
  "engines",
  "controls",
  "plan",
  "phase",
  "flight",
] as const;

export type LinkListener = () => void;

/** Flight-core options the session passes through (storage, clocks, thresholds). */
export type SessionOptions = Omit<FlightCoreOptions, "store" | "log" | "hooks"> & {
  /** Receive clock for updates without their own timestamp. Default Date.now. */
  receiveClock?: () => number;
  /** Cargo operations (P3); without it job/mission commands are not implemented. */
  economy?: Omit<EconomyOptions, "store" | "log">;
  /** Airports for manual/mission destinations. Default: the economy's airports. */
  airports?: readonly EconomyAirport[] | null;
};

export class ConnectorSession {
  readonly id = randomUUID();
  readonly store: StateStore;
  readonly flight: FlightCore;
  readonly economy: EconomyEngine | null;
  /** Owns the `plan` domain: GPS plan, else manual destination, else mission. */
  readonly plan: PlanResolver;
  private readonly receiveClock: () => number;
  private readonly linkListeners = new Set<LinkListener>();
  private unsubscribe: (() => void) | null = null;

  constructor(
    readonly source: SimSource,
    private readonly log: LogFn,
    options: SessionOptions = {},
  ) {
    this.store = new StateStore(source.frameSource, (domain, reason) =>
      log("debug", `Ignored ${domain} update: ${reason}`),
    );
    const { receiveClock, economy, airports, ...core } = options;
    this.receiveClock = receiveClock ?? Date.now;
    this.economy = economy ? new EconomyEngine({ ...economy, store: this.store, log }) : null;
    this.flight = new FlightCore({
      ...core,
      store: this.store,
      log,
      ...(this.economy ? { hooks: this.economy.hooks() } : {}),
    });
    const planAirports = airports ?? economy?.airports ?? null;
    this.plan = new PlanResolver({
      store: this.store,
      airports: planAirports ? airportLookup(planAirports) : null,
      log,
      startOffline: source.mode === "live" && !source.link().connected,
    });
    // The manual destination lasts for one flight.
    this.store.subscribe((frame) => {
      if (frame.type === "event" && frame.name === "flight.ended") this.plan.onFlightEnded();
    });
  }

  start(): void {
    if (this.unsubscribe) return;
    this.economy?.start();
    this.unsubscribe = this.source.subscribe((update) => {
      switch (update.type) {
        case "connected":
          this.plan.onConnect();
          this.flight.onConnect();
          this.notifyLink();
          break;
        case "disconnected": {
          const clear: SimStatePatch = {};
          for (const domain of SIM_DERIVED_DOMAINS) clear[domain] = null;
          this.store.apply(clear);
          this.plan.onDisconnect();
          this.flight.onDisconnect();
          this.notifyLink();
          break;
        }
        case "reset": {
          const at = update.at ?? this.receiveClock();
          // The source's plan is the GPS plan; the published one is resolved below.
          const { plan, ...state } = update.state;
          // Connector-owned economy domains survive a replay restart.
          this.store.reset(this.economy ? { ...state, ...this.economy.domains() } : state);
          this.economy?.onStoreReset();
          this.economy?.onAircraftTitle(update.state.aircraft?.title ?? null);
          this.plan.reset(plan, at);
          this.flight.onReset(at);
          break;
        }
        case "data": {
          const at = update.at ?? this.receiveClock();
          const { plan, ...patch } = update.patch;
          this.plan.ingest(plan);
          this.store.apply(patch);
          if (patch.aircraft !== undefined && this.economy) {
            const aircraft = this.store.getDomain("aircraft") as { title?: string } | null;
            this.economy.onAircraftTitle(aircraft?.title ?? null);
          }
          // Before the flight core, so a flight starting on this sample sees the route.
          this.plan.refresh(at);
          this.flight.onData(patch, at);
          break;
        }
        case "event":
          this.store.event(update.name, update.data);
          this.flight.onEvent(update.name);
          break;
        case "aiTraffic":
          this.economy?.onAiTraffic(update.samples, update.at);
          break;
      }
    });
    if (this.economy && this.source.setAiTargetsProvider) {
      const economy = this.economy;
      this.source.setAiTargetsProvider(() => economy.companyBook.aiTargets());
    }
    this.source.start();
  }

  async stop(): Promise<void> {
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.source.stop();
  }

  /** Called when the simulator link changes; the server re-welcomes every client. */
  onLinkChange(listener: LinkListener): () => void {
    this.linkListeners.add(listener);
    return () => {
      this.linkListeners.delete(listener);
    };
  }

  /**
   * Answer a client command: plan.destination → plan resolver, job/mission/settings → economy,
   * flight.* → flight core. Commands arrive only over the authenticated WebSocket (allowed
   * Origin and token, see server.ts).
   */
  command(cmd: Command): Result {
    if (cmd.name === "plan.destination") return this.plan.command(cmd);
    if (this.economy?.handles(cmd.name)) {
      const result = this.economy.command(cmd);
      // A mission loaded, unloaded or aborted changes the mission destination at once.
      if (result.ok) this.plan.refreshNow();
      return result;
    }
    return this.flight.command(cmd);
  }

  welcome(): Welcome {
    const link = this.source.link();
    const sim: Welcome["sim"] = { connected: link.connected };
    if (link.connected) {
      if (link.name) sim.name = link.name;
      if (link.version) sim.version = link.version;
      if (link.protocol) sim.protocol = link.protocol;
    }
    return { type: "welcome", v: PROTOCOL_VERSION, session: this.id, mode: this.source.mode, sim };
  }

  private notifyLink(): void {
    for (const listener of [...this.linkListeners]) listener();
  }
}
