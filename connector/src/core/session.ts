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
import type { LogFn, SimSource } from "../sim/source";
import { FlightCore, type FlightCoreOptions } from "./flight-core";
import { StateStore } from "./store";

/** Domains that describe the simulator; cleared when the link drops so stale values never look live. */
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
] as const;

export type LinkListener = () => void;

/** Flight-core options the session passes through (storage, clocks, thresholds). */
export type SessionOptions = Omit<FlightCoreOptions, "store" | "log"> & {
  /** Receive clock for updates without their own timestamp. Default Date.now. */
  receiveClock?: () => number;
};

export class ConnectorSession {
  readonly id = randomUUID();
  readonly store: StateStore;
  readonly flight: FlightCore;
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
    const { receiveClock, ...core } = options;
    this.receiveClock = receiveClock ?? Date.now;
    this.flight = new FlightCore({ ...core, store: this.store, log });
  }

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.source.subscribe((update) => {
      switch (update.type) {
        case "connected":
          this.notifyLink();
          break;
        case "disconnected": {
          const clear: SimStatePatch = {};
          for (const domain of SIM_DERIVED_DOMAINS) clear[domain] = null;
          this.store.apply(clear);
          this.notifyLink();
          break;
        }
        case "reset":
          this.store.reset(update.state);
          this.flight.onReset(update.at ?? this.receiveClock());
          break;
        case "data":
          this.store.apply(update.patch);
          this.flight.onData(update.patch, update.at ?? this.receiveClock());
          break;
        case "event":
          this.store.event(update.name, update.data);
          this.flight.onEvent(update.name);
          break;
      }
    });
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

  /** Answer a client command (flight.start / flight.end; others not implemented). */
  command(cmd: Command): Result {
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
