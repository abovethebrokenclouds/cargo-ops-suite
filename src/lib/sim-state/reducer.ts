import {
  simDomainSchemas,
  type Delta,
  type ServerMessage,
  type SimDomain,
  type SimEvent,
  type SimState,
  type Snapshot,
  type Source,
  type Welcome,
} from "@cargo-ops/protocol";

/** Transport-level status, reported by every Transport implementation. */
export type TransportStatus = "idle" | "connecting" | "open" | "disconnected" | "error";

/** What the UI shows. live/demo/replay are only reachable through a real `welcome`. */
export type ConnectionState =
  "idle" | "connecting" | "live" | "demo" | "replay" | "disconnected" | "error";

export const MAX_EVENTS = 200;

/**
 * Domains read from the simulator or computed from it (phase, tracked flight). The
 * connector clears them when the simulator link drops; while a live welcome says the
 * simulator is offline the client never holds them either, so nothing stale is shown as
 * live with a SIM tag. Connector-owned state (company, jobs, mission, fleet, …) stays.
 */
export const SIM_TELEMETRY_DOMAINS: readonly SimDomain[] = [
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
];

/** A live session whose welcome reports the simulator as not connected. */
export function isSimOfflineSession(state: ClientSimState): boolean {
  return state.welcome?.mode === "live" && !state.welcome.sim.connected;
}

function withoutSimTelemetry<T extends Record<string, unknown>>(sim: T): T {
  const out: Record<string, unknown> = { ...sim };
  for (const domain of SIM_TELEMETRY_DOMAINS) delete out[domain];
  return out as T;
}

export interface ReceivedEvent {
  msg: SimEvent;
  /** Client clock when received, ms. */
  at: number;
}

export interface ClientSimState {
  connection: ConnectionState;
  welcome: Welcome | null;
  source: Source | null;
  /** Last applied frame seq; -1 before the first frame of a session. */
  lastSeq: number;
  sim: Partial<SimState>;
  /** Most recent events, oldest first, capped at MAX_EVENTS. */
  events: ReceivedEvent[];
  /** Client clock of the last applied frame, ms. */
  lastFrameAt: number | null;
  /** Set on a seq gap or an unusable delta; cleared by the next snapshot. */
  needsResync: boolean;
  error?: string;
}

export type SimAction =
  | { type: "status"; status: TransportStatus; error?: string }
  | { type: "welcome"; msg: Welcome }
  | { type: "snapshot"; msg: Snapshot; at: number }
  | { type: "delta"; msg: Delta; at: number }
  | { type: "event"; msg: SimEvent; at: number }
  | { type: "reset" };

export const initialSimState: ClientSimState = {
  connection: "idle",
  welcome: null,
  source: null,
  lastSeq: -1,
  sim: {},
  events: [],
  lastFrameAt: null,
  needsResync: false,
};

/** Map a server message to a reducer action; result/ping/pong are not state. */
export function actionFromMessage(msg: ServerMessage, at: number): SimAction | null {
  switch (msg.type) {
    case "welcome":
      return { type: "welcome", msg };
    case "snapshot":
      return { type: "snapshot", msg, at };
    case "delta":
      return { type: "delta", msg, at };
    case "event":
      return { type: "event", msg, at };
    default:
      return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stripUndefined(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(value)) if (field !== undefined) out[key] = field;
  return out;
}

/**
 * Shallow-merge a patch into the current domains. A partial patch for a domain we
 * have no base for is skipped (storing it would leave required fields missing) and
 * reported as incomplete so the caller can request a resync.
 */
function applyPatch(
  current: Partial<SimState>,
  patch: Delta["patch"],
): { sim: Partial<SimState>; incomplete: boolean } {
  const next: Record<string, unknown> = { ...current };
  let incomplete = false;
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const domain = key as SimDomain;
    const prev = next[domain];
    if (value === null) {
      next[domain] = null;
    } else if (isPlainObject(prev) && isPlainObject(value)) {
      next[domain] = { ...prev, ...stripUndefined(value) };
    } else if (simDomainSchemas[domain].safeParse(value).success) {
      next[domain] = value;
    } else {
      incomplete = true;
    }
  }
  return { sim: next as Partial<SimState>, incomplete };
}

function statusToConnection(status: TransportStatus): ConnectionState | null {
  switch (status) {
    case "idle":
      return "idle";
    case "connecting":
      return "connecting";
    case "disconnected":
      return "disconnected";
    case "error":
      return "error";
    case "open":
      // Socket open is not a session yet; wait for welcome.
      return null;
  }
}

export function simReducer(state: ClientSimState, action: SimAction): ClientSimState {
  switch (action.type) {
    case "reset":
      return initialSimState;

    case "status": {
      const connection = statusToConnection(action.status);
      if (connection === null) return state;
      const next: ClientSimState = {
        ...state,
        connection,
        // Any status change ends the current session; a new welcome is required.
        welcome: null,
        lastSeq: -1,
        needsResync: false,
      };
      if (action.status === "error") next.error = action.error ?? "transport error";
      else delete next.error;
      return next;
    }

    case "welcome": {
      const next: ClientSimState = {
        ...state,
        connection: action.msg.mode,
        welcome: action.msg,
        // A new session never inherits data from the previous one; its snapshot follows.
        source: null,
        sim: {},
        lastFrameAt: null,
        lastSeq: -1,
        needsResync: false,
      };
      delete next.error;
      return next;
    }

    case "snapshot": {
      if (!state.welcome) return state;
      return {
        ...state,
        source: action.msg.source,
        lastSeq: action.msg.seq,
        sim: isSimOfflineSession(state)
          ? withoutSimTelemetry({ ...action.msg.state })
          : { ...action.msg.state },
        lastFrameAt: action.at,
        needsResync: false,
      };
    }

    case "delta": {
      if (!state.welcome) return state;
      const { seq } = action.msg;
      // Stale or duplicate frame: older than what we already applied.
      if (state.lastSeq >= 0 && seq <= state.lastSeq) return state;
      const gap = state.lastSeq < 0 || seq !== state.lastSeq + 1;
      const patch = isSimOfflineSession(state)
        ? withoutSimTelemetry(action.msg.patch)
        : action.msg.patch;
      const { sim, incomplete } = applyPatch(state.sim, patch);
      return {
        ...state,
        source: action.msg.source,
        lastSeq: seq,
        sim,
        lastFrameAt: action.at,
        needsResync: state.needsResync || gap || incomplete,
      };
    }

    case "event": {
      if (!state.welcome) return state;
      const { seq } = action.msg;
      if (state.lastSeq >= 0 && seq <= state.lastSeq) return state;
      const gap = state.lastSeq < 0 || seq !== state.lastSeq + 1;
      const events = [...state.events, { msg: action.msg, at: action.at }];
      return {
        ...state,
        source: action.msg.source,
        lastSeq: seq,
        events: events.length > MAX_EVENTS ? events.slice(-MAX_EVENTS) : events,
        lastFrameAt: action.at,
        needsResync: state.needsResync || gap,
      };
    }
  }
}
