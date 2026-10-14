import {
  createContext,
  createElement,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { z } from "zod";
import {
  PROTOCOL_VERSION,
  type ClientMessage,
  type FixtureFrame,
  type Result,
} from "@cargo-ops/protocol";
import {
  actionFromMessage,
  initialSimState,
  simReducer,
  type ClientSimState,
} from "@/lib/sim-state/reducer";
import { DemoTransport } from "./demo-transport";
import { getDemoFrames } from "./demo-fixture";
import { LiveWsTransport, UNAUTHORIZED_ERROR, type WebSocketCtor } from "./live-ws-transport";
import { resetConnectorToken } from "./connector-api";
import { backoffDelay } from "./reconnect";
import { defaultTimers, type Timers, type Transport } from "./types";

export type TransportKind = "live" | "demo";

/** Origins served by the local connector; the page talks to it live when loaded from here. */
export const CONNECTOR_ORIGINS = ["http://127.0.0.1:4311", "http://localhost:4311"];

export function pickTransportKind(env: {
  connectorFlag: string | undefined;
  origin: string | undefined;
}): TransportKind {
  if (env.connectorFlag === "1") return "live";
  if (env.origin && CONNECTOR_ORIGINS.includes(env.origin)) return "live";
  return "demo";
}

const sessionSchema = z.object({
  token: z.string().min(1),
  wsUrl: z.string().min(1),
  /** "local" = this PC (main token); "lan" = a paired LAN device (its own token). */
  scope: z.enum(["local", "lan"]).optional(),
  device: z.object({ id: z.string(), name: z.string() }).optional(),
});
export type ConnectorSession = z.infer<typeof sessionSchema>;

// ---- LAN pairing (connector --lan): the token of a paired device lives in this browser ----

/** localStorage key of this browser's LAN device token (never the PC's main token). */
export const LAN_TOKEN_KEY = "cargo-ops.lan-token";

export function readLanToken(): string | null {
  try {
    return globalThis.localStorage?.getItem(LAN_TOKEN_KEY) ?? null;
  } catch {
    return null;
  }
}

function writeLanToken(token: string | null): void {
  try {
    if (token === null) globalThis.localStorage?.removeItem(LAN_TOKEN_KEY);
    else globalThis.localStorage?.setItem(LAN_TOKEN_KEY, token);
  } catch {
    // Private mode or storage disabled: pairing then lasts for this page only.
  }
}

/** The connector serves this page to a LAN device that has not paired (or was revoked). */
export class PairingRequiredError extends Error {
  constructor() {
    super("pairing required");
    this.name = "PairingRequiredError";
  }
}

/**
 * GET /api/session (same origin) → token and WebSocket URL. On this PC the connector answers
 * with its token; on a LAN device it only confirms the stored LAN token, or asks to pair.
 */
export async function fetchSession(fetchImpl: typeof fetch): Promise<ConnectorSession> {
  const lanToken = readLanToken();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (lanToken) headers["Authorization"] = `Bearer ${lanToken}`;
  const res = await fetchImpl("/api/session", { headers });
  if (res.status === 403) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    if (body?.error === "pairing_required") {
      if (lanToken) writeLanToken(null); // revoked or unknown: forget it
      throw new PairingRequiredError();
    }
  }
  if (!res.ok) throw new Error(`connector session request failed (${res.status})`);
  const parsed = sessionSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("connector session response is invalid");
  return parsed.data;
}

export type PairResult = { ok: true; deviceName: string } | { ok: false; message: string };

/** POST /api/lan/pair with the code shown on the PC; stores the LAN token on success. */
export async function pairWithCode(
  code: string,
  name: string,
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<PairResult> {
  try {
    const res = await fetchImpl("/api/lan/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ code, name }),
    });
    const body = (await res.json().catch(() => null)) as {
      token?: string;
      message?: string;
      error?: string;
      device?: { name?: string };
    } | null;
    if (!res.ok || typeof body?.token !== "string") {
      return { ok: false, message: body?.message ?? body?.error ?? `HTTP ${res.status}` };
    }
    writeLanToken(body.token);
    return { ok: true, deviceName: body.device?.name ?? name };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Pairing failed" };
  }
}

/** Forget this browser's LAN pairing (it must pair again). */
export function forgetLanPairing(): void {
  writeLanToken(null);
}

/** Resolve a possibly relative wsUrl against the page and switch http(s) to ws(s). */
export function toWebSocketUrl(wsUrl: string, pageHref: string): string {
  const url = new URL(wsUrl, pageHref);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

/** Send a command and wait for its `result` (never throws; failures are `ok: false`). */
export type CommandFn = (name: string, args?: unknown) => Promise<Result>;

export interface SimConnectionValue {
  state: ClientSimState;
  send: (msg: ClientMessage) => void;
  /** Null until the provider has mounted in the browser. */
  transportKind: TransportKind | null;
  /** Command round-trip; absent in test fixtures that only render state. */
  command?: CommandFn;
  /** This page runs on a LAN device that must pair before it gets any data. */
  pairingRequired?: boolean;
  /** Fetch the session again (after pairing). */
  reconnect?: () => void;
}

/** How long a command waits for its result, ms. */
export const COMMAND_TIMEOUT_MS = 10_000;

function localFailure(id: string, code: string, message: string): Result {
  return { type: "result", v: PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}

/** Overrides for tests; production code passes none. */
export interface SimConnectionOptions {
  connectorFlag?: string;
  origin?: string;
  href?: string;
  fetch?: typeof fetch;
  demoFrames?: () => FixtureFrame[];
  WebSocketImpl?: WebSocketCtor;
  timers?: Timers;
}

/** Exported so component tests can supply a fixed value; app code uses the provider. */
export const SimConnectionContext = createContext<SimConnectionValue | null>(null);

export function SimConnectionProvider(props: {
  children?: ReactNode;
  options?: SimConnectionOptions;
}) {
  const [state, dispatch] = useReducer(simReducer, initialSimState);
  const [transportKind, setTransportKind] = useState<TransportKind | null>(null);
  const transportRef = useRef<Transport | null>(null);
  const optionsRef = useRef(props.options ?? {});
  const resyncSent = useRef(false);
  const pending = useRef(new Map<string, (r: Result) => void>());
  const commandSeq = useRef(0);
  const [pairingRequired, setPairingRequired] = useState(false);
  const restartRef = useRef<() => void>(() => {});

  useEffect(() => {
    // Everything browser-specific happens here, never at render or module time.
    const options = optionsRef.current;
    const timers = options.timers ?? defaultTimers;
    const kind = pickTransportKind({
      connectorFlag: options.connectorFlag ?? import.meta.env.VITE_CARGO_OPS_CONNECTOR,
      origin: options.origin ?? window.location.origin,
    });
    setTransportKind(kind);

    let cancelled = false;
    let unsubscribe: () => void = () => {};
    let retryHandle: unknown = null;

    const attach = (transport: Transport) => {
      transportRef.current = transport;
      unsubscribe = transport.subscribe((ev) => {
        if (ev.type === "status" && ev.status === "error" && ev.error === UNAUTHORIZED_ERROR) {
          // Token refused (reset on the PC, or this LAN device was revoked): ask again.
          restartRef.current();
          return;
        }
        if (ev.type === "status") {
          dispatch(
            ev.error === undefined
              ? { type: "status", status: ev.status }
              : { type: "status", status: ev.status, error: ev.error },
          );
          return;
        }
        if (ev.msg.type === "result") {
          const resolve = pending.current.get(ev.msg.id);
          if (resolve) {
            pending.current.delete(ev.msg.id);
            resolve(ev.msg);
          }
          return;
        }
        const action = actionFromMessage(ev.msg, timers.now());
        if (action) dispatch(action);
      });
      transport.connect();
    };

    if (kind === "demo") {
      attach(new DemoTransport({ frames: options.demoFrames ?? getDemoFrames, timers }));
    } else {
      // On the connector origin we never fall back to demo data: if the connector is
      // unreachable the UI shows it as offline and keeps retrying.
      const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
      let attempt = 0;
      const start = () => {
        dispatch({ type: "status", status: "connecting" });
        fetchSession(fetchImpl)
          .then((session) => {
            if (cancelled) return;
            setPairingRequired(false);
            const url = toWebSocketUrl(session.wsUrl, options.href ?? window.location.href);
            const wsOptions = options.WebSocketImpl
              ? { timers, WebSocketImpl: options.WebSocketImpl }
              : { timers };
            attach(new LiveWsTransport(url, session.token, wsOptions));
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            if (err instanceof PairingRequiredError) {
              // No retry loop: nothing changes until the player pairs this device.
              setPairingRequired(true);
              dispatch({ type: "status", status: "disconnected", error: err.message });
              return;
            }
            dispatch({
              type: "status",
              status: "disconnected",
              error: err instanceof Error ? err.message : "connector unreachable",
            });
            retryHandle = timers.setTimeout(start, backoffDelay(attempt++));
          });
      };
      restartRef.current = () => {
        if (cancelled) return;
        unsubscribe();
        unsubscribe = () => {};
        transportRef.current?.disconnect();
        transportRef.current = null;
        if (retryHandle !== null) timers.clearTimeout(retryHandle);
        retryHandle = null;
        attempt = 0;
        resetConnectorToken();
        start();
      };
      start();
    }

    return () => {
      cancelled = true;
      if (retryHandle !== null) timers.clearTimeout(retryHandle);
      unsubscribe();
      transportRef.current?.disconnect();
      transportRef.current = null;
    };
  }, []);

  // Ask the connector for a fresh snapshot once per detected gap.
  useEffect(() => {
    if (!state.needsResync) {
      resyncSent.current = false;
      return;
    }
    const transport = transportRef.current;
    if (resyncSent.current || !(transport instanceof LiveWsTransport)) return;
    resyncSent.current = true;
    transport.resync(state.lastSeq);
  }, [state.needsResync, state.lastSeq]);

  const send = useCallback((msg: ClientMessage) => {
    transportRef.current?.send(msg);
  }, []);

  const command = useCallback<CommandFn>((name, args = {}) => {
    const id = `cmd-${Date.now().toString(36)}-${++commandSeq.current}`;
    const transport = transportRef.current;
    if (!transport) {
      return Promise.resolve(localFailure(id, "not_connected", "Not connected to the connector"));
    }
    return new Promise<Result>((resolve) => {
      const timer = globalThis.setTimeout(() => {
        if (!pending.current.delete(id)) return;
        resolve(localFailure(id, "timeout", "The connector did not answer in time"));
      }, COMMAND_TIMEOUT_MS);
      pending.current.set(id, (r) => {
        globalThis.clearTimeout(timer);
        resolve(r);
      });
      transport.send({ type: "command", v: PROTOCOL_VERSION, id, name, args });
    });
  }, []);

  const reconnect = useCallback(() => restartRef.current(), []);

  const value = useMemo(
    () => ({ state, send, transportKind, command, pairingRequired, reconnect }),
    [state, send, transportKind, command, pairingRequired, reconnect],
  );
  return createElement(SimConnectionContext.Provider, { value }, props.children);
}

/** The command round-trip, or a stub that reports "not connected". */
export function useCommand(): CommandFn {
  const value = useContext(SimConnectionContext);
  return (
    value?.command ??
    ((name) =>
      Promise.resolve(localFailure(name, "not_connected", "Not connected to the connector")))
  );
}

export function useSimConnection(): SimConnectionValue {
  const value = useContext(SimConnectionContext);
  if (!value) throw new Error("useSimConnection must be used inside <SimConnectionProvider>");
  return value;
}
