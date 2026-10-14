// SimConnectSource: the live link to MSFS 2020/2024 through node-simconnect
// (LGPL-3.0-or-later, used unmodified from node_modules).
//
// UNVERIFIED on a real simulator: this file has been type-checked against node-simconnect
// 4.2.1 and exercised against the test-only protocol emulator
// (connector/test/support/simconnect-emulator.ts), which speaks the SimConnect wire format
// but is not MSFS. See docs/VERIFICATION.md for the PC checklist.

import {
  DataRequestFlag,
  Protocol,
  SimConnectConstants,
  SimConnectDataType,
  SimConnectConnection,
  SimConnectPeriod,
  type ConnectionOptions,
  type RawBuffer,
  type RecvException,
  type RecvOpen,
  type RecvSimObjectData,
} from "node-simconnect";
import type { SimStatePatch } from "../protocol";
import { AI_SAMPLE_INTERVAL_MS, SimConnectAiSampler, type AiTarget } from "./ai-traffic";
import { fastIntervalMs, mapFast, mapSlow, pausedFromEx1, simNameFor } from "./mapping";
import {
  MAX_ENGINES,
  MAX_STATIONS,
  buildDatums,
  clampCount,
  type DatumSpec,
  type IndexCounts,
  type RawValues,
  type SimVarGroup,
} from "./simvars";
import {
  SimEmitter,
  type LogFn,
  type SimLinkInfo,
  type SimListener,
  type SimSource,
} from "./source";

const APP_NAME = "Cargo Ops";
const OPEN_TIMEOUT_MS = 15_000;
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;

/** System events subscribed on connect (plan §6.1); each must be in SYSTEM_EVENT_CATALOG. */
export const SYSTEM_EVENTS = [
  "Pause",
  "Pause_EX1",
  "SimStart",
  "SimStop",
  "FlightLoaded",
  "AircraftLoaded",
  "Crashed",
  "CrashReset",
  "1sec",
] as const;
type SystemEventName = (typeof SYSTEM_EVENTS)[number];
const EVENT_ID: Record<SystemEventName, number> = Object.fromEntries(
  SYSTEM_EVENTS.map((name, i) => [name, i + 1]),
) as Record<SystemEventName, number>;
const EVENT_NAME_BY_ID = new Map<number, SystemEventName>(
  SYSTEM_EVENTS.map((name) => [EVENT_ID[name], name]),
);

const SYSTEM_STATE_SIM_REQUEST = 900;
/** System states requested on connect; each must be in SYSTEM_STATE_CATALOG. */
export const SYSTEM_STATES = ["Sim"] as const;

type ProtocolName = "SunRise" | "KittyHawk";
const PROTOCOLS: { name: ProtocolName; value: Protocol }[] = [
  { name: "SunRise", value: Protocol.SunRise },
  { name: "KittyHawk", value: Protocol.KittyHawk },
];

/** One active data definition + request. Ids are never reused within a connection. */
interface ActiveDefinition {
  group: SimVarGroup;
  defineId: number;
  requestId: number;
  datums: DatumSpec[];
}

/** Read one frame in definition order. Throws if the buffer is shorter than expected. */
export function readFrame(data: RawBuffer, datums: DatumSpec[]): RawValues {
  const out: RawValues = {};
  for (const d of datums) {
    switch (d.type) {
      case "f64":
        out[d.rawKey] = data.readFloat64();
        break;
      case "string64":
        out[d.rawKey] = data.readString64();
        break;
      case "string256":
        out[d.rawKey] = data.readString256();
        break;
    }
  }
  return out;
}

function dataTypeFor(d: DatumSpec): SimConnectDataType {
  switch (d.type) {
    case "f64":
      return SimConnectDataType.FLOAT64;
    case "string64":
      return SimConnectDataType.STRING64;
    case "string256":
      return SimConnectDataType.STRING256;
  }
}

export interface SimConnectSourceOptions {
  log: LogFn;
  /**
   * Connect over TCP to this SimConnect server instead of the normal discovery (SimConnect.cfg,
   * then the local named pipe, then the registry port). Used by the hidden
   * `--simconnect-host/--simconnect-port` options and the protocol emulator tests.
   */
  remote?: { host: string; port: number };
  /** First reconnect delay, ms (default 2,000; doubles up to `retryMaxMs`). Tests shorten it. */
  retryMinMs?: number;
  /** Longest reconnect delay, ms (default 30,000). */
  retryMaxMs?: number;
  /** AI traffic sampling interval, ms (default 30,000). Tests shorten it. */
  aiSampleIntervalMs?: number;
}

export class SimConnectSource implements SimSource {
  readonly mode = "live" as const;
  readonly frameSource = "sim" as const;

  private readonly emitter = new SimEmitter();
  private readonly log: LogFn;
  private readonly remote: { host: string; port: number } | undefined;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly aiSampleIntervalMs: number;
  private handle: SimConnectConnection | null = null;
  private info: SimLinkInfo = { connected: false };
  private running = false;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay: number;
  private offlineReported = false;
  private nextId = 1;
  private defs = new Map<SimVarGroup, ActiveDefinition>();
  /** sendId of each addToDataDefinition → datum, to attribute SimConnect exceptions. */
  private sendIds = new Map<number, { group: SimVarGroup; datum: DatumSpec }>();
  private disabled = new Set<string>();
  private counts: IndexCounts | null = null;
  private paused = false;
  private simRate: number | undefined;
  private lastFastEmit = 0;
  private lastAgl: number | undefined;
  private rebuildTimer: NodeJS.Timeout | null = null;
  /** Definitions waiting for a rebuild after the simulator rejected one of their datums. */
  private readonly rebuildGroups = new Set<SimVarGroup>();
  /** Object id the simulator reports for the user aircraft (from OBJECT_ID_USER frames). */
  private userObjectId: number | null = null;
  /** P5 part 2: AI traffic near the player's FBO airports (bonus income). */
  private aiSampler: SimConnectAiSampler | null = null;
  private aiTimer: NodeJS.Timeout | null = null;
  private aiTargets: () => AiTarget[] = () => [];
  private userPosition: { lat: number; lon: number } | null = null;
  /** Latest values the sim reported but the protocol has no domain for (diagnostics). */
  zulu: string | undefined;
  simRunning: boolean | undefined;

  constructor(options: SimConnectSourceOptions) {
    this.log = options.log;
    this.remote = options.remote;
    this.retryMinMs = options.retryMinMs ?? RETRY_MIN_MS;
    this.retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS;
    this.aiSampleIntervalMs = options.aiSampleIntervalMs ?? AI_SAMPLE_INTERVAL_MS;
    this.retryDelay = this.retryMinMs;
  }

  link(): SimLinkInfo {
    return { ...this.info };
  }

  subscribe(listener: SimListener): () => void {
    return this.emitter.subscribe(listener);
  }

  setAiTargetsProvider(provider: () => AiTarget[]): void {
    this.aiTargets = provider;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (this.remote) {
      this.log("info", `SimConnect over TCP at ${this.remote.host}:${this.remote.port}`);
    }
    void this.connect();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.teardown("connector stopping");
  }

  // ---- connection lifecycle ----

  private async connect(): Promise<void> {
    if (!this.running || this.handle) return;
    let lastError = "unknown error";
    for (const protocol of PROTOCOLS) {
      try {
        const { recvOpen, handle } = await openWithTimeout(
          protocol.value,
          OPEN_TIMEOUT_MS,
          this.remote,
        );
        if (!this.running) {
          safeClose(handle);
          return;
        }
        this.onOpen(handle, recvOpen, protocol.name);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        this.log("debug", `SimConnect open with ${protocol.name} failed: ${lastError}`);
      }
    }
    // Say it once at info level; repeats while MSFS is not running go to debug.
    this.log(
      this.offlineReported ? "debug" : "info",
      `Simulator not reachable (${lastError}); retrying in ${Math.round(this.retryDelay / 1000)} s`,
    );
    this.offlineReported = true;
    this.scheduleRetry();
  }

  private scheduleRetry(): void {
    if (!this.running || this.retryTimer) return;
    const delay = this.retryDelay;
    this.retryDelay = Math.min(this.retryMaxMs, this.retryDelay * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
  }

  private onOpen(handle: SimConnectConnection, recvOpen: RecvOpen, protocol: ProtocolName): void {
    this.handle = handle;
    this.retryDelay = this.retryMinMs;
    this.offlineReported = false;
    const version = [
      recvOpen.applicationVersionMajor,
      recvOpen.applicationVersionMinor,
      recvOpen.applicationBuildMajor,
      recvOpen.applicationBuildMinor,
    ].join(".");
    const simName = simNameFor(recvOpen.applicationName, protocol);
    this.info = { connected: true, name: simName, version, protocol };
    this.log(
      "info",
      `Connected to ${recvOpen.applicationName} (${simName}) v${version} via SimConnect ${protocol}`,
    );

    handle.on("quit", () => this.onLost(handle, "simulator quit"));
    handle.on("close", () => this.onLost(handle, "SimConnect connection closed"));
    handle.on("error", (err) => this.onLost(handle, `SimConnect error: ${err.message}`));
    handle.on("exception", (ex) => this.onException(ex));
    handle.on("simObjectData", (data) => this.onData(data));
    handle.on("event", (ev) => this.onSystemEvent(ev.clientEventId, ev.data));
    handle.on("eventEx1", (ev) => this.onSystemEvent(ev.clientEventId, ev.data[0]));
    handle.on("eventFilename", (ev) => this.onSystemEvent(ev.clientEventId, 0, ev.fileName));
    handle.on("systemState", (state) => {
      if (state.requestID !== SYSTEM_STATE_SIM_REQUEST) return;
      this.simRunning = state.dataInteger === 1;
      this.log("info", `System state "Sim" = ${state.dataInteger}`);
    });

    this.emitter.emit({ type: "connected", simName, protocol, version });
    this.emitter.emit({
      type: "event",
      name: "sim.connected",
      data: { simName, protocol, version },
    });

    for (const name of SYSTEM_EVENTS) handle.subscribeToSystemEvent(EVENT_ID[name], name);
    handle.requestSystemState(SYSTEM_STATE_SIM_REQUEST, SYSTEM_STATES[0]);
    this.defineFast();
    this.requestCounts();
    this.startAiTraffic(handle);
  }

  /**
   * AI traffic sampling (UNVERIFIED on a real sim): every 30 s, when an owned FBO airport is
   * within 190 km of the user aircraft, request every AIRCRAFT object around the user.
   */
  private startAiTraffic(handle: SimConnectConnection): void {
    try {
      this.aiSampler = new SimConnectAiSampler(
        handle,
        { defineId: this.allocId(), requestId: this.allocId() },
        this.log,
        (samples, at) => this.emitter.emit({ type: "aiTraffic", samples, at }),
        () => this.userObjectId,
      );
    } catch (err) {
      this.log(
        "warn",
        `AI traffic sampling unavailable: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
    handle.on("simObjectDataByType", (recv) => {
      this.aiSampler?.onData(recv, Date.now());
    });
    this.aiTimer = setInterval(() => {
      if (this.handle !== handle) return;
      this.aiSampler?.sample(this.userPosition, this.aiTargets(), Date.now());
    }, this.aiSampleIntervalMs);
    this.aiTimer.unref();
  }

  private onLost(handle: SimConnectConnection, reason: string): void {
    if (this.handle !== handle) return;
    this.teardown(reason);
    if (this.running) {
      this.log("warn", `${reason}; reconnecting`);
      this.scheduleRetry();
    }
  }

  private teardown(reason: string): void {
    const handle = this.handle;
    this.handle = null;
    this.defs.clear();
    this.sendIds.clear();
    this.disabled.clear();
    this.counts = null;
    this.simRate = undefined;
    this.paused = false;
    this.zulu = undefined;
    this.simRunning = undefined;
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
    this.rebuildGroups.clear();
    this.userObjectId = null;
    if (this.aiTimer) clearInterval(this.aiTimer);
    this.aiTimer = null;
    this.aiSampler = null;
    this.userPosition = null;
    if (handle) {
      handle.removeAllListeners("quit");
      handle.removeAllListeners("close");
      handle.removeAllListeners("simObjectData");
      handle.removeAllListeners("simObjectDataByType");
      safeClose(handle);
    }
    if (this.info.connected) {
      this.info = { connected: false };
      this.emitter.emit({ type: "event", name: "sim.disconnected", data: { reason } });
      this.emitter.emit({ type: "disconnected", reason });
    }
  }

  // ---- data definitions ----

  private allocId(): number {
    return this.nextId++;
  }

  private define(group: SimVarGroup, datums: DatumSpec[], period: SimConnectPeriod): void {
    const handle = this.handle;
    if (!handle) return;
    const previous = this.defs.get(group);
    if (previous) {
      handle.requestDataOnSimObject(
        previous.requestId,
        previous.defineId,
        SimConnectConstants.OBJECT_ID_USER,
        SimConnectPeriod.NEVER,
      );
      handle.clearDataDefinition(previous.defineId);
      this.defs.delete(group);
    }
    if (datums.length === 0) return;
    const def: ActiveDefinition = {
      group,
      defineId: this.allocId(),
      requestId: this.allocId(),
      datums,
    };
    for (const datum of datums) {
      const sendId = handle.addToDataDefinition(
        def.defineId,
        datum.simvar,
        datum.unit,
        dataTypeFor(datum),
      );
      this.sendIds.set(sendId, { group, datum });
    }
    handle.requestDataOnSimObject(
      def.requestId,
      def.defineId,
      SimConnectConstants.OBJECT_ID_USER,
      period,
      DataRequestFlag.DATA_REQUEST_FLAG_DEFAULT,
    );
    this.defs.set(group, def);
  }

  private defineFast(): void {
    // Position/motion every sim frame; throttled to 5/10 Hz in onData.
    this.define(
      "fast",
      buildDatums("fast", { engines: 0, stations: 0 }, this.disabled),
      SimConnectPeriod.SIM_FRAME,
    );
  }

  private requestCounts(): void {
    this.define(
      "counts",
      buildDatums("counts", { engines: 0, stations: 0 }, this.disabled),
      SimConnectPeriod.ONCE,
    );
  }

  private defineSlow(): void {
    if (!this.counts) return;
    this.define("slow", buildDatums("slow", this.counts, this.disabled), SimConnectPeriod.SECOND);
  }

  private onException(ex: RecvException): void {
    const source = this.sendIds.get(ex.sendId);
    if (!source) {
      this.log("warn", `SimConnect exception ${ex.exceptionName} (send ${ex.sendId})`);
      return;
    }
    // The simulator rejected a datum: drop it (every index of an indexed SimVar)
    // and rebuild that definition so the buffer layout matches again.
    const { group, datum } = source;
    this.disabled.add(datum.spec.key);
    this.log(
      "warn",
      `SimConnect rejected "${datum.simvar}" (${datum.unit ?? "string"}): ${ex.exceptionName}. ` +
        `Dropping ${datum.spec.name}; fix it in connector/src/sim/simvars.ts.`,
    );
    this.scheduleRebuild(group);
  }

  private scheduleRebuild(group: SimVarGroup): void {
    // Exceptions arrive in a burst; rebuild every affected definition once afterwards.
    // (Several groups can be hit in one burst, e.g. a fast and a slow SimVar on MSFS 2020.)
    this.rebuildGroups.add(group);
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      const groups = [...this.rebuildGroups];
      this.rebuildGroups.clear();
      for (const g of groups) {
        if (g === "fast") this.defineFast();
        else if (g === "counts") this.requestCounts();
        else this.defineSlow();
      }
    }, 250);
  }

  private onData(recv: RecvSimObjectData): void {
    const def = [...this.defs.values()].find((d) => d.requestId === recv.requestID);
    if (!def) return; // Frame from a definition we already replaced.
    // Frames requested for OBJECT_ID_USER carry the user aircraft's real object id.
    this.userObjectId = recv.objectID;
    let raw: RawValues;
    try {
      raw = readFrame(recv.data, def.datums);
    } catch (err) {
      this.log("warn", `Dropped a ${def.group} frame: ${err instanceof Error ? err.message : err}`);
      return;
    }
    if (def.group === "counts") this.onCounts(raw);
    else if (def.group === "slow") this.onSlow(raw);
    else this.onFast(raw);
  }

  private onCounts(raw: RawValues): void {
    const counts: IndexCounts = {
      engines: clampCount(raw["engineCount"], MAX_ENGINES),
      stations: clampCount(raw["stationCount"], MAX_STATIONS),
    };
    const changed =
      !this.counts ||
      this.counts.engines !== counts.engines ||
      this.counts.stations !== counts.stations;
    this.counts = counts;
    if (changed || !this.defs.has("slow")) {
      this.log(
        "info",
        `Aircraft has ${counts.engines} engine(s), ${counts.stations} payload station(s)`,
      );
      this.defineSlow();
    }
  }

  private onSlow(raw: RawValues): void {
    if (!this.counts) return;
    const mapped = mapSlow(raw, this.counts);
    const patch: SimStatePatch = {};
    if (mapped.aircraft) patch.aircraft = mapped.aircraft;
    if (mapped.fuel) patch.fuel = mapped.fuel;
    if (mapped.weights) patch.weights = mapped.weights;
    if (mapped.payload) patch.payload = mapped.payload;
    if (mapped.engines) patch.engines = mapped.engines;
    if (mapped.controls) patch.controls = mapped.controls;
    // Always reported: a GPS plan, or null for "none" (inactive, empty or rejected). The
    // session resolves it against the manual and mission destinations.
    patch.plan = mapped.plan ?? null;
    this.zulu = mapped.zulu;
    if (mapped.simRate !== undefined && mapped.simRate !== this.simRate) {
      const first = this.simRate === undefined;
      this.simRate = mapped.simRate;
      if (!first)
        this.emitter.emit({ type: "event", name: "sim.rate", data: { rate: mapped.simRate } });
    }
    const sim = this.simDomain();
    if (sim) patch.sim = sim;
    if (Object.keys(patch).length > 0) this.emitter.emit({ type: "data", patch });
  }

  private onFast(raw: RawValues): void {
    const now = Date.now();
    if (now - this.lastFastEmit < fastIntervalMs(this.lastAgl)) return;
    const mapped = mapFast(raw);
    const patch: SimStatePatch = {};
    if (mapped.position) {
      patch.position = mapped.position;
      this.lastAgl = mapped.position.aglFt;
      this.userPosition = { lat: mapped.position.lat, lon: mapped.position.lon };
    }
    if (mapped.motion) patch.motion = mapped.motion;
    if (Object.keys(patch).length === 0) return;
    this.lastFastEmit = now;
    this.emitter.emit({ type: "data", patch });
  }

  /** The `sim` domain needs a real SIMULATION RATE; until one arrives it is not reported. */
  private simDomain(): SimStatePatch["sim"] | undefined {
    if (!this.info.connected || this.simRate === undefined) return undefined;
    const sim: NonNullable<SimStatePatch["sim"]> = {
      connected: true,
      paused: this.paused,
      simRate: this.simRate,
    };
    if (this.info.name) sim.name = this.info.name;
    return sim;
  }

  // ---- system events ----

  private onSystemEvent(clientEventId: number, data: number, fileName?: string): void {
    const name = EVENT_NAME_BY_ID.get(clientEventId);
    if (!name) return;
    switch (name) {
      case "Pause":
        this.setPaused(data === 1, { event: name, data });
        break;
      case "Pause_EX1":
        this.setPaused(pausedFromEx1(data), { event: name, flags: data });
        break;
      case "SimStart":
      case "SimStop":
        this.simRunning = name === "SimStart";
        this.log("info", `System event ${name}`);
        if (name === "SimStart") this.requestCounts();
        break;
      case "FlightLoaded":
      case "AircraftLoaded":
        this.log("info", `System event ${name}${fileName ? `: ${fileName}` : ""}`);
        // A new aircraft may have a different number of engines or stations.
        this.requestCounts();
        break;
      case "Crashed":
        this.log("warn", "System event Crashed");
        this.emitter.emit({ type: "event", name: "crash", data: {} });
        break;
      case "CrashReset":
        this.log("info", "System event CrashReset");
        break;
      case "1sec":
        break;
    }
  }

  private setPaused(paused: boolean, detail: Record<string, unknown>): void {
    if (paused === this.paused) return;
    this.paused = paused;
    this.emitter.emit({ type: "event", name: "sim.paused", data: { paused, ...detail } });
    const sim = this.simDomain();
    if (sim) this.emitter.emit({ type: "data", patch: { sim } });
  }
}

function safeClose(handle: SimConnectConnection): void {
  try {
    handle.close();
  } catch {
    // Already closed.
  }
}

/**
 * Open a SimConnect connection with our own deadline. Unlike node-simconnect's `open()`, an
 * attempt fails as soon as the server closes the connection or answers with an exception
 * (e.g. a simulator that does not speak the requested protocol), instead of waiting for the
 * library's 5 s open timeout. A handle that arrives after the deadline is closed.
 */
function openWithTimeout(
  protocol: Protocol,
  ms: number,
  remote?: { host: string; port: number },
): Promise<{ recvOpen: RecvOpen; handle: SimConnectConnection }> {
  return new Promise((resolve, reject) => {
    const handle = new SimConnectConnection(APP_NAME, protocol);
    // Late socket errors on an abandoned handle must never become uncaught 'error' events.
    handle.on("error", () => {});
    let settled = false;
    const finish = (err: Error | null, recvOpen?: RecvOpen) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      handle.removeListener("open", onOpen);
      handle.removeListener("error", onError);
      handle.removeListener("close", onClose);
      handle.removeListener("exception", onException);
      if (err || !recvOpen) {
        safeClose(handle);
        reject(err ?? new Error("open failed"));
      } else {
        resolve({ recvOpen, handle });
      }
    };
    const onOpen = (recvOpen: RecvOpen) => finish(null, recvOpen);
    const onError = (err: Error) => finish(err instanceof Error ? err : new Error(String(err)));
    const onClose = () => finish(new Error("connection closed during open"));
    const onException = (ex: RecvException) =>
      finish(new Error(`open refused: ${ex.exceptionName} (exception ${ex.exception})`));
    const timer = setTimeout(() => finish(new Error(`open timed out after ${ms} ms`)), ms);
    handle.on("open", onOpen);
    handle.on("error", onError);
    handle.on("close", onClose);
    handle.on("exception", onException);
    const options: ConnectionOptions | undefined = remote
      ? { host: remote.host, port: remote.port }
      : undefined;
    try {
      handle.connect(options);
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)));
    }
  });
}
