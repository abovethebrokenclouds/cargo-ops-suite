import {
  PROTOCOL_VERSION,
  encode,
  parseServerMessage,
  type ClientMessage,
  type Topic,
} from "@cargo-ops/protocol";
import {
  DEFAULT_BACKOFF,
  WATCHDOG_MS,
  Watchdog,
  initialReconnectState,
  reconnectStep,
  type BackoffOptions,
  type ReconnectEvent,
  type ReconnectState,
} from "./reconnect";
import {
  Emitter,
  defaultTimers,
  type Timers,
  type Transport,
  type TransportListener,
} from "./types";

/** The subset of the browser WebSocket this transport uses. */
export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketCtor = new (url: string) => WebSocketLike;

const WS_OPEN = 1;
const DEFAULT_WANTS: Topic[] = ["telemetry", "flight", "jobs", "company"];

export interface LiveWsTransportOptions {
  /** Defaults to the global WebSocket, looked up at connect time. */
  WebSocketImpl?: WebSocketCtor;
  timers?: Timers;
  random?: () => number;
  backoff?: BackoffOptions;
  watchdogMs?: number;
  wants?: Topic[];
  /** Called for every incoming message that fails validation (it is dropped). */
  onInvalid?: (error: string) => void;
}

/** WebSocket transport to the local connector, with hello/token, validation and reconnect. */
export class LiveWsTransport implements Transport {
  private readonly emitter = new Emitter();
  private readonly timers: Timers;
  private readonly watchdog: Watchdog;
  private fsm: ReconnectState = initialReconnectState;
  private ws: WebSocketLike | null = null;
  private retryHandle: unknown = null;
  /** Messages that failed validation since construction. */
  invalidCount = 0;

  constructor(
    private readonly url: string,
    private readonly token: string,
    private readonly options: LiveWsTransportOptions = {},
  ) {
    this.timers = options.timers ?? defaultTimers;
    this.watchdog = new Watchdog(
      () => this.handleClose("watchdog timeout"),
      options.watchdogMs ?? WATCHDOG_MS,
      this.timers,
    );
  }

  get reconnectState(): ReconnectState {
    return this.fsm;
  }

  subscribe(listener: TransportListener): () => void {
    return this.emitter.subscribe(listener);
  }

  connect(): void {
    if (this.fsm.phase !== "idle" && this.fsm.phase !== "stopped") return;
    this.step({ type: "start" });
    this.open();
  }

  disconnect(): void {
    if (this.fsm.phase === "idle" || this.fsm.phase === "stopped") return;
    this.step({ type: "stop" });
    this.cancelRetry();
    this.watchdog.stop();
    this.dropSocket();
    this.emitter.emit({ type: "status", status: "disconnected" });
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WS_OPEN) this.ws.send(encode(msg));
  }

  /** Ask the connector for a fresh snapshot after a seq gap. */
  resync(lastSeq: number): void {
    this.send({ type: "resync", v: PROTOCOL_VERSION, lastSeq });
  }

  private step(event: ReconnectEvent): void {
    this.fsm = reconnectStep(
      this.fsm,
      event,
      this.options.random ?? Math.random,
      this.options.backoff ?? DEFAULT_BACKOFF,
    );
  }

  private open(): void {
    this.emitter.emit({ type: "status", status: "connecting" });
    const Ctor =
      this.options.WebSocketImpl ??
      ((globalThis as { WebSocket?: unknown }).WebSocket as WebSocketCtor | undefined);
    if (!Ctor) {
      this.step({ type: "stop" });
      this.emitter.emit({ type: "status", status: "error", error: "WebSocket is unavailable" });
      return;
    }
    let ws: WebSocketLike;
    try {
      ws = new Ctor(this.url);
    } catch (err) {
      this.handleClose(err instanceof Error ? err.message : "WebSocket failed to open");
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      if (this.ws !== ws) return;
      this.step({ type: "opened" });
      this.emitter.emit({ type: "status", status: "open" });
      this.send({
        type: "hello",
        v: PROTOCOL_VERSION,
        token: this.token,
        client: "web",
        wants: this.options.wants ?? DEFAULT_WANTS,
      });
      this.watchdog.kick();
    };
    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.watchdog.kick();
      this.handleData(ev.data);
    };
    ws.onclose = () => {
      if (this.ws === ws) this.handleClose();
    };
    // An error is always followed by close; nothing to do here.
    ws.onerror = () => {};
  }

  private handleData(data: unknown): void {
    if (typeof data !== "string") {
      this.reject("non-text frame");
      return;
    }
    const parsed = parseServerMessage(data);
    if (!parsed.ok) {
      this.reject(parsed.error);
      return;
    }
    const msg = parsed.msg;
    if (msg.type === "welcome") this.step({ type: "established" });
    if (msg.type === "ping") this.send({ type: "pong", v: PROTOCOL_VERSION, t: msg.t });
    this.emitter.emit({ type: "message", msg });
  }

  private reject(error: string): void {
    this.invalidCount++;
    this.options.onInvalid?.(error);
  }

  private handleClose(reason?: string): void {
    this.watchdog.stop();
    this.dropSocket();
    const before = this.fsm.phase;
    this.step({ type: "closed" });
    if (this.fsm.phase !== "waiting" || before === "waiting") return;
    this.emitter.emit(
      reason
        ? { type: "status", status: "disconnected", error: reason }
        : { type: "status", status: "disconnected" },
    );
    this.retryHandle = this.timers.setTimeout(() => {
      this.retryHandle = null;
      this.step({ type: "retry" });
      if (this.fsm.phase === "connecting") this.open();
    }, this.fsm.delayMs ?? 0);
  }

  private dropSocket(): void {
    const ws = this.ws;
    this.ws = null;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    try {
      ws.close();
    } catch {
      // Already closed.
    }
  }

  private cancelRetry(): void {
    if (this.retryHandle !== null) this.timers.clearTimeout(this.retryHandle);
    this.retryHandle = null;
  }
}
