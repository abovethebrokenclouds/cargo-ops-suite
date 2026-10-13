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
import type { ClientMessage, FixtureFrame } from "@cargo-ops/protocol";
import {
  actionFromMessage,
  initialSimState,
  simReducer,
  type ClientSimState,
} from "@/lib/sim-state/reducer";
import { DemoTransport } from "./demo-transport";
import { getDemoFrames } from "./demo-fixture";
import { LiveWsTransport, type WebSocketCtor } from "./live-ws-transport";
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

const sessionSchema = z.object({ token: z.string().min(1), wsUrl: z.string().min(1) });
export type ConnectorSession = z.infer<typeof sessionSchema>;

/** GET /api/session (same origin) → token and WebSocket URL. */
export async function fetchSession(fetchImpl: typeof fetch): Promise<ConnectorSession> {
  const res = await fetchImpl("/api/session", { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`connector session request failed (${res.status})`);
  const parsed = sessionSchema.safeParse(await res.json());
  if (!parsed.success) throw new Error("connector session response is invalid");
  return parsed.data;
}

/** Resolve a possibly relative wsUrl against the page and switch http(s) to ws(s). */
export function toWebSocketUrl(wsUrl: string, pageHref: string): string {
  const url = new URL(wsUrl, pageHref);
  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";
  return url.toString();
}

export interface SimConnectionValue {
  state: ClientSimState;
  send: (msg: ClientMessage) => void;
  /** Null until the provider has mounted in the browser. */
  transportKind: TransportKind | null;
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
        if (ev.type === "status") {
          dispatch(
            ev.error === undefined
              ? { type: "status", status: ev.status }
              : { type: "status", status: ev.status, error: ev.error },
          );
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
            const url = toWebSocketUrl(session.wsUrl, options.href ?? window.location.href);
            const wsOptions = options.WebSocketImpl
              ? { timers, WebSocketImpl: options.WebSocketImpl }
              : { timers };
            attach(new LiveWsTransport(url, session.token, wsOptions));
          })
          .catch((err: unknown) => {
            if (cancelled) return;
            dispatch({
              type: "status",
              status: "disconnected",
              error: err instanceof Error ? err.message : "connector unreachable",
            });
            retryHandle = timers.setTimeout(start, backoffDelay(attempt++));
          });
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

  const value = useMemo(() => ({ state, send, transportKind }), [state, send, transportKind]);
  return createElement(SimConnectionContext.Provider, { value }, props.children);
}

export function useSimConnection(): SimConnectionValue {
  const value = useContext(SimConnectionContext);
  if (!value) throw new Error("useSimConnection must be used inside <SimConnectionProvider>");
  return value;
}
