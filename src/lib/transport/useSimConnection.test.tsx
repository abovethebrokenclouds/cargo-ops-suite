import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FixtureFrame } from "@cargo-ops/protocol";
import { statusLabel } from "@/lib/sim-state/selectors";
import type { WebSocketLike } from "./live-ws-transport";
import {
  SimConnectionProvider,
  pickTransportKind,
  toWebSocketUrl,
  useSimConnection,
  type SimConnectionOptions,
} from "./useSimConnection";

function Probe() {
  const { state, transportKind } = useSimConnection();
  return (
    <div>
      <span data-testid="label">{statusLabel(state)}</span>
      <span data-testid="kind">{transportKind ?? "none"}</span>
      <span data-testid="lat">{state.sim.position?.lat ?? "-"}</span>
    </div>
  );
}

const demoFrames: FixtureFrame[] = [
  {
    t: 0,
    msg: {
      type: "snapshot",
      v: 1,
      seq: 0,
      source: "demo",
      state: { position: { lat: 35, lon: -90, altFt: 341, aglFt: 0 } },
    },
  },
];

class FakeWs implements WebSocketLike {
  static last: FakeWs | null = null;
  readyState = 0;
  sent: string[] = [];
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeWs.last = this;
  }
  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
}

function renderWith(options: SimConnectionOptions) {
  return render(
    <SimConnectionProvider options={options}>
      <Probe />
    </SimConnectionProvider>,
  );
}

const flush = () => act(() => vi.advanceTimersByTimeAsync(0));

describe("pickTransportKind", () => {
  it("uses the live connector only when flagged or on the connector origin", () => {
    expect(pickTransportKind({ connectorFlag: "1", origin: "https://x.lovable.app" })).toBe("live");
    expect(pickTransportKind({ connectorFlag: undefined, origin: "http://127.0.0.1:4311" })).toBe(
      "live",
    );
    expect(pickTransportKind({ connectorFlag: undefined, origin: "http://localhost:4311" })).toBe(
      "live",
    );
    expect(pickTransportKind({ connectorFlag: "0", origin: "http://localhost:8080" })).toBe("demo");
    expect(pickTransportKind({ connectorFlag: undefined, origin: undefined })).toBe("demo");
  });
});

describe("toWebSocketUrl", () => {
  it("resolves relative URLs and switches to ws schemes", () => {
    expect(toWebSocketUrl("/ws", "http://127.0.0.1:4311/flight")).toBe("ws://127.0.0.1:4311/ws");
    expect(toWebSocketUrl("https://h/ws", "http://a/")).toBe("wss://h/ws");
    expect(toWebSocketUrl("ws://127.0.0.1:4311/ws", "http://a/")).toBe("ws://127.0.0.1:4311/ws");
  });
});

describe("SimConnectionProvider", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    FakeWs.last = null;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("throws when the hook is used outside the provider", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/SimConnectionProvider/);
  });

  it("uses demo data off the connector origin", async () => {
    renderWith({ origin: "http://localhost:8080", demoFrames: () => demoFrames });
    await flush();
    expect(screen.getByTestId("kind").textContent).toBe("demo");
    expect(screen.getByTestId("label").textContent).toBe("DEMO DATA");
    expect(screen.getByTestId("lat").textContent).toBe("35");
  });

  it("shows the connector offline, without demo data, when /api/session fails", async () => {
    const demo = vi.fn(() => demoFrames);
    const fetchImpl = vi.fn(() => Promise.reject(new Error("ECONNREFUSED")));
    renderWith({ origin: "http://127.0.0.1:4311", demoFrames: demo, fetch: fetchImpl });
    await flush();
    expect(screen.getByTestId("kind").textContent).toBe("live");
    expect(screen.getByTestId("label").textContent).toBe("CONNECTOR OFFLINE");
    expect(screen.getByTestId("lat").textContent).toBe("-");
    expect(demo).not.toHaveBeenCalled();
    // Keeps retrying with backoff.
    await act(() => vi.advanceTimersByTimeAsync(600));
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("connects live with the session token and requests a resync on a seq gap", async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ token: "tok", wsUrl: "/ws" }), {
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );
    renderWith({
      origin: "http://127.0.0.1:4311",
      href: "http://127.0.0.1:4311/",
      fetch: fetchImpl as unknown as typeof fetch,
      WebSocketImpl: FakeWs,
    });
    await flush();
    const ws = FakeWs.last;
    if (!ws) throw new Error("socket not created");
    expect(ws.url).toBe("ws://127.0.0.1:4311/ws");
    expect(screen.getByTestId("label").textContent).toBe("CONNECTING");

    const deliver = (msg: unknown) => act(() => ws.onmessage?.({ data: JSON.stringify(msg) }));
    act(() => {
      ws.readyState = 1;
      ws.onopen?.({});
    });
    expect(JSON.parse(ws.sent[0] ?? "{}")).toMatchObject({ type: "hello", token: "tok" });
    deliver({
      type: "welcome",
      v: 1,
      session: "s",
      mode: "live",
      sim: { connected: true, name: "MSFS 2024", protocol: "SunRise" },
    });
    expect(screen.getByTestId("label").textContent).toBe("LIVE · MSFS 2024 · SunRise");

    deliver({ type: "snapshot", v: 1, seq: 0, source: "sim", state: {} });
    deliver({ type: "event", v: 1, seq: 4, source: "sim", name: "sim.paused", data: true });
    deliver({ type: "event", v: 1, seq: 5, source: "sim", name: "sim.paused", data: false });
    const resyncs = ws.sent.map((s) => JSON.parse(s)).filter((m) => m.type === "resync");
    expect(resyncs).toEqual([{ type: "resync", v: 1, lastSeq: 4 }]);
  });

  it("command() resolves with the matching result (demo mode answers demo_mode)", async () => {
    let result: unknown = null;
    function Commander() {
      const { command } = useSimConnection();
      return (
        <button
          type="button"
          onClick={() => {
            void command?.("job.accept", { jobId: "J-1" }).then((r) => (result = r));
          }}
        >
          go
        </button>
      );
    }
    render(
      <SimConnectionProvider
        options={{ connectorFlag: "0", origin: "http://x", demoFrames: () => demoFrames }}
      >
        <Commander />
      </SimConnectionProvider>,
    );
    await flush();
    act(() => screen.getByText("go").click());
    await flush();
    await flush();
    expect(result).toMatchObject({ type: "result", ok: false, error: { code: "demo_mode" } });
  });
});
