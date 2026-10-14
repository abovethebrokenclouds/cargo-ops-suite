import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerMessage } from "@cargo-ops/protocol";
import { LiveWsTransport, type WebSocketLike } from "./live-ws-transport";
import type { TransportEvent } from "./types";

class FakeWebSocket implements WebSocketLike {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.closed = true;
    this.readyState = 3;
  }
  // Test helpers.
  serverOpen() {
    this.readyState = 1;
    this.onopen?.({});
  }
  serverSend(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
  serverClose() {
    this.readyState = 3;
    this.onclose?.({});
  }
  sentMessages() {
    return this.sent.map((s) => JSON.parse(s) as { type: string } & Record<string, unknown>);
  }
}

const latest = () => {
  const ws = FakeWebSocket.instances.at(-1);
  if (!ws) throw new Error("no socket");
  return ws;
};

const welcome = {
  type: "welcome",
  v: 1,
  session: "s1",
  mode: "live",
  sim: { connected: true, name: "MSFS 2024", protocol: "SunRise" },
};

function setup(onInvalid?: (e: string) => void) {
  const transport = new LiveWsTransport("ws://127.0.0.1:4311/ws", "secret", {
    WebSocketImpl: FakeWebSocket,
    random: () => 0.5,
    ...(onInvalid ? { onInvalid } : {}),
  });
  const events: TransportEvent[] = [];
  transport.subscribe((e) => events.push(e));
  const statuses = () => events.flatMap((e) => (e.type === "status" ? [e.status] : []));
  const messages = () => events.flatMap((e) => (e.type === "message" ? [e.msg] : []));
  return { transport, events, statuses, messages };
}

describe("LiveWsTransport", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not touch WebSocket until connect()", () => {
    setup();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("sends hello with the token on open", () => {
    const { transport, statuses } = setup();
    transport.connect();
    expect(latest().url).toBe("ws://127.0.0.1:4311/ws");
    expect(statuses()).toEqual(["connecting"]);
    latest().serverOpen();
    expect(statuses()).toEqual(["connecting", "open"]);
    expect(latest().sentMessages()).toEqual([
      {
        type: "hello",
        v: 1,
        token: "secret",
        client: "web",
        wants: ["telemetry", "flight", "jobs", "company"],
      },
    ]);
  });

  it("emits validated messages and drops invalid ones", () => {
    const onInvalid = vi.fn();
    const { transport, messages } = setup(onInvalid);
    transport.connect();
    latest().serverOpen();
    latest().serverSend(welcome);
    latest().serverSend({ type: "delta", v: 1, seq: 1, patch: {} }); // no source
    latest().serverSend({ ...welcome, v: 2 });
    latest().serverSend("not json");
    latest().onmessage?.({ data: new ArrayBuffer(4) });
    latest().serverSend({ type: "delta", v: 1, seq: 1, source: "sim", patch: {} });
    expect(messages().map((m: ServerMessage) => m.type)).toEqual(["welcome", "delta"]);
    expect(onInvalid).toHaveBeenCalledTimes(4);
    expect(transport.invalidCount).toBe(4);
  });

  it("answers server pings with a pong", () => {
    const { transport } = setup();
    transport.connect();
    latest().serverOpen();
    latest().serverSend({ type: "ping", v: 1, t: 42 });
    expect(latest().sentMessages().at(-1)).toEqual({ type: "pong", v: 1, t: 42 });
  });

  it("sends resync with lastSeq and drops sends while not open", () => {
    const { transport } = setup();
    transport.connect();
    transport.resync(5);
    expect(latest().sent).toEqual([]);
    latest().serverOpen();
    transport.resync(5);
    transport.send({ type: "command", v: 1, id: "c1", name: "flight.start", args: null });
    expect(latest().sentMessages().slice(1)).toEqual([
      { type: "resync", v: 1, lastSeq: 5 },
      { type: "command", v: 1, id: "c1", name: "flight.start", args: null },
    ]);
  });

  it("reconnects with exponential backoff and resets after a welcome", () => {
    const { transport, statuses } = setup();
    transport.connect();
    latest().serverClose();
    expect(statuses()).toEqual(["connecting", "disconnected"]);
    expect(transport.reconnectState).toMatchObject({ phase: "waiting", delayMs: 500 });

    vi.advanceTimersByTime(499);
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(FakeWebSocket.instances).toHaveLength(2);

    latest().serverClose();
    expect(transport.reconnectState.delayMs).toBe(1000);
    vi.advanceTimersByTime(1000);
    expect(FakeWebSocket.instances).toHaveLength(3);

    latest().serverOpen();
    latest().serverSend(welcome);
    expect(transport.reconnectState).toMatchObject({ phase: "established", attempt: 0 });
    latest().serverClose();
    expect(transport.reconnectState.delayMs).toBe(500);
  });

  it("closes and reconnects when the watchdog expires", () => {
    const { transport, events } = setup();
    transport.connect();
    const first = latest();
    first.serverOpen();
    first.serverSend(welcome);
    vi.advanceTimersByTime(29_999);
    first.serverSend({ type: "ping", v: 1, t: 1 });
    vi.advanceTimersByTime(29_999);
    expect(first.closed).toBe(false);
    vi.advanceTimersByTime(1);
    expect(first.closed).toBe(true);
    expect(events.at(-1)).toEqual({
      type: "status",
      status: "disconnected",
      error: "watchdog timeout",
    });
    vi.advanceTimersByTime(500);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it("disconnect stops reconnecting and ignores late socket events", () => {
    const { transport, statuses, messages } = setup();
    transport.connect();
    const ws = latest();
    ws.serverOpen();
    transport.disconnect();
    expect(ws.closed).toBe(true);
    expect(statuses().at(-1)).toBe("disconnected");
    ws.serverSend(welcome);
    ws.serverClose();
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(messages()).toEqual([]);
    expect(transport.reconnectState.phase).toBe("stopped");
  });

  it("reports an error when no WebSocket implementation exists", () => {
    const original = globalThis.WebSocket;
    // @ts-expect-error simulate a non-browser runtime
    delete globalThis.WebSocket;
    try {
      const transport = new LiveWsTransport("ws://x", "t");
      const events: TransportEvent[] = [];
      transport.subscribe((e) => events.push(e));
      transport.connect();
      expect(events.at(-1)).toEqual({
        type: "status",
        status: "error",
        error: "WebSocket is unavailable",
      });
    } finally {
      globalThis.WebSocket = original;
    }
  });
});

describe("LiveWsTransport: refused token", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops and reports unauthorized on close 4401 instead of retrying the same token", () => {
    const { transport, events } = setup();
    transport.connect();
    latest().serverOpen();
    latest().serverSend(welcome);
    latest().readyState = 3;
    latest().onclose?.({ code: 4401 });
    expect(events.at(-1)).toEqual({ type: "status", status: "error", error: "unauthorized" });
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(transport.reconnectState.phase).toBe("stopped");
  });

  it("still retries after an ordinary close", () => {
    const { transport } = setup();
    transport.connect();
    latest().serverOpen();
    latest().onclose?.({ code: 1006 });
    vi.advanceTimersByTime(60_000);
    expect(FakeWebSocket.instances.length).toBeGreaterThan(1);
  });
});
