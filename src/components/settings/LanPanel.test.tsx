import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { initialSimState } from "@/lib/sim-state/reducer";
import type { LanView } from "@/lib/settings/lan-access";
import { formatCountdown, pairCodeFromHash, secondsLeft } from "@/lib/settings/lan-access";
import { resetConnectorToken } from "@/lib/transport/connector-api";
import {
  LAN_TOKEN_KEY,
  PairingRequiredError,
  fetchSession,
  pairWithCode,
} from "@/lib/transport/useSimConnection";

import { LanPanel } from "./LanPanel";
import { DataPanel } from "./SettingsPanels";
import { PairDeviceForm } from "./PairDevice";
import type { SettingsContext } from "./SettingsPanels";

const MAIN = "m".repeat(64);
const ctx: SettingsContext = { state: initialSimState, served: true, connected: true };

function view(over: Partial<LanView> = {}): LanView {
  return {
    active: true,
    bind: "0.0.0.0",
    port: 4311,
    urls: ["http://192.168.1.5:4311/"],
    interfaces: ["192.168.1.5"],
    setting: { enabled: true, address: "0.0.0.0" },
    restartRequired: false,
    code: null,
    devices: [],
    codeBurned: false,
    warning: null,
    ...over,
  };
}

type Call = { url: string; method: string; auth: string | null; body: unknown };

/** A fake connector: routes by "METHOD path" to a JSON response. */
function fakeFetch(routes: Record<string, (body: unknown) => [number, unknown]>) {
  const calls: Call[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = new Headers(init.headers);
    const body = typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    calls.push({ url, method, auth: headers.get("Authorization"), body });
    const route = routes[`${method} ${url}`];
    if (!route) return new Response(JSON.stringify({ error: "not_found" }), { status: 404 });
    const [status, json] = route(body);
    return new Response(JSON.stringify(json), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

const localSession = (): [number, unknown] => [200, { token: MAIN, wsUrl: "/ws", scope: "local" }];

beforeEach(() => {
  resetConnectorToken();
  localStorage.clear();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("LanPanel on the PC", () => {
  it("shows status, the bound URL, the pairing code and paired devices; revoke removes one", async () => {
    const expiresAt = new Date(Date.now() + 299_000).toISOString();
    const device = {
      id: "d1",
      name: "Kitchen tablet",
      pairedAt: "2026-10-14T10:00:00.000Z",
      pairedFrom: "192.168.1.20",
      lastSeenAt: null,
    };
    const f = fakeFetch({
      "GET /api/session": localSession,
      "GET /api/lan": () => [
        200,
        view({
          code: {
            code: "ABCD2345",
            display: "ABCD-2345",
            expiresAt,
            ttlSec: 300,
            pairUrls: ["http://192.168.1.5:4311/settings#pair=ABCD2345"],
          },
          devices: [device],
        }),
      ],
      "DELETE /api/lan/devices/d1": () => [200, view()],
    });
    render(<LanPanel ctx={ctx} fetchImpl={f.impl} />);
    expect(await screen.findByTestId("lan-status")).toHaveTextContent("On · listening on 0.0.0.0");
    expect(screen.getByTestId("lan-urls")).toHaveTextContent("http://192.168.1.5:4311/");
    expect(screen.getByTestId("lan-code")).toHaveTextContent("ABCD-2345");
    expect(screen.getByTestId("lan-code-expires")).toHaveTextContent(/Expires in 4:5\d · one use/);
    expect(screen.getByTestId("lan-pair-url")).toHaveTextContent(
      "http://192.168.1.5:4311/settings#pair=ABCD2345",
    );
    expect(screen.getByTestId("lan-device-row")).toHaveTextContent("Kitchen tablet");
    expect(screen.getByTestId("lan-enabled")).toBeChecked();

    fireEvent.click(screen.getByRole("button", { name: "Revoke Kitchen tablet" }));
    expect(await screen.findByTestId("lan-no-devices")).toBeInTheDocument();
    const del = f.calls.find((c) => c.method === "DELETE");
    expect(del?.url).toBe("/api/lan/devices/d1");
    expect(del?.auth).toBe(`Bearer ${MAIN}`);
    expect(screen.getByText("Kitchen tablet can no longer connect")).toBeInTheDocument();
  });

  it("is off by default; turning it on needs confirmation and a restart", async () => {
    const f = fakeFetch({
      "GET /api/session": localSession,
      "GET /api/lan": () => [
        200,
        view({ active: false, bind: null, urls: [], setting: null, restartRequired: false }),
      ],
      "PUT /api/lan/settings": () => [
        200,
        view({
          active: false,
          bind: null,
          urls: [],
          setting: { enabled: true, address: "0.0.0.0" },
          restartRequired: true,
        }),
      ],
    });
    render(<LanPanel ctx={ctx} fetchImpl={f.impl} />);
    expect(await screen.findByTestId("lan-status")).toHaveTextContent("Off · 127.0.0.1 only");
    expect(screen.getByTestId("lan-generate-code")).toBeDisabled();
    expect(screen.queryByTestId("lan-restart")).toBeNull();

    fireEvent.click(screen.getByTestId("lan-enabled"));
    // Nothing is saved until the player confirms.
    expect(f.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(await screen.findByText("Allow LAN access?")).toBeInTheDocument();
    // The dialog names what 0.0.0.0 would expose.
    expect(screen.getByTestId("lan-confirm-interfaces")).toHaveTextContent(
      "http://192.168.1.5:4311/",
    );
    fireEvent.click(screen.getByTestId("lan-confirm-on"));
    expect(await screen.findByTestId("lan-restart")).toHaveTextContent(/Restart the connector/);
    const put = f.calls.find((c) => c.method === "PUT");
    expect(put?.body).toEqual({ enabled: true, address: "0.0.0.0" });
  });

  it("generates a pairing code when LAN is on", async () => {
    const f = fakeFetch({
      "GET /api/session": localSession,
      "GET /api/lan": () => [200, view()],
      "POST /api/lan/code": () => [
        201,
        view({
          code: {
            code: "WXYZ6789",
            display: "WXYZ-6789",
            expiresAt: new Date(Date.now() + 300_000).toISOString(),
            ttlSec: 300,
            pairUrls: ["http://192.168.1.5:4311/settings#pair=WXYZ6789"],
          },
        }),
      ],
    });
    render(<LanPanel ctx={ctx} fetchImpl={f.impl} />);
    fireEvent.click(await screen.findByTestId("lan-generate-code"));
    expect(await screen.findByTestId("lan-code")).toHaveTextContent("WXYZ-6789");
  });
});

describe("LanPanel notices", () => {
  it("says when wrong guesses cancelled the code", async () => {
    const f = fakeFetch({
      "GET /api/session": localSession,
      "GET /api/lan": () => [200, view({ code: null, codeBurned: true })],
    });
    render(<LanPanel ctx={ctx} fetchImpl={f.impl} />);
    expect(await screen.findByTestId("lan-code-burned")).toHaveTextContent(
      "Code cancelled after too many wrong attempts — create a new one",
    );
    expect(screen.getByTestId("lan-generate-code")).toBeEnabled();
  });

  it("shows why the saved setting was not applied, without a restart hint", async () => {
    const warning =
      "Saved LAN address 192.168.1.9 (Settings → LAN access) cannot be used: 192.168.1.9 is not an address of this PC";
    const f = fakeFetch({
      "GET /api/session": localSession,
      "GET /api/lan": () => [
        200,
        view({
          active: false,
          bind: null,
          urls: [],
          setting: { enabled: true, address: "192.168.1.9" },
          restartRequired: false,
          warning,
        }),
      ],
    });
    render(<LanPanel ctx={ctx} fetchImpl={f.impl} />);
    expect(await screen.findByTestId("lan-warning")).toHaveTextContent(warning);
    expect(screen.queryByTestId("lan-restart")).toBeNull();
  });

  it("lists every interface 0.0.0.0 would expose in the confirmation", async () => {
    const f = fakeFetch({
      "GET /api/session": localSession,
      "GET /api/lan": () => [
        200,
        view({
          active: false,
          bind: null,
          urls: [],
          setting: null,
          interfaces: ["192.168.1.5", "10.0.0.7"],
        }),
      ],
    });
    render(<LanPanel ctx={ctx} fetchImpl={f.impl} />);
    fireEvent.click(await screen.findByTestId("lan-enabled"));
    const list = await screen.findByTestId("lan-confirm-interfaces");
    expect(list).toHaveTextContent("http://192.168.1.5:4311/");
    expect(list).toHaveTextContent("http://10.0.0.7:4311/");
  });
});

describe("Data panel on a paired LAN device", () => {
  it("says backups are kept on the PC instead of an error", async () => {
    localStorage.setItem(LAN_TOKEN_KEY, "l".repeat(64));
    const message =
      "Career import, backups, deleting data and LAN settings are only available on the PC running Cargo Ops.";
    const f = fakeFetch({
      "GET /api/session": () => [
        200,
        { token: "l".repeat(64), wsUrl: "/ws", scope: "lan", device: { id: "d1", name: "Tablet" } },
      ],
      "GET /api/backups": () => [403, { error: "local_only", message }],
    });
    vi.stubGlobal("fetch", f.impl);
    try {
      render(<DataPanel ctx={ctx} />);
      expect(await screen.findByText("Backups are kept on the PC")).toBeInTheDocument();
      expect(screen.getByText(message)).toBeInTheDocument();
      expect(screen.queryByText("Backups could not be listed")).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("LanPanel elsewhere", () => {
  it("on a paired LAN device: names it and fetches no LAN management data", async () => {
    localStorage.setItem(LAN_TOKEN_KEY, "l".repeat(64));
    const f = fakeFetch({
      "GET /api/session": () => [
        200,
        { token: "l".repeat(64), wsUrl: "/ws", scope: "lan", device: { id: "d1", name: "Tablet" } },
      ],
    });
    render(<LanPanel ctx={ctx} fetchImpl={f.impl} />);
    expect(await screen.findByTestId("lan-paired-device")).toHaveTextContent(/paired .* as Tablet/);
    expect(f.calls.map((c) => c.url)).toEqual(["/api/session"]);
    expect(f.calls[0]?.auth).toBe(`Bearer ${"l".repeat(64)}`);
  });

  it("in demo mode: says it needs the connector and fetches nothing", () => {
    const f = fakeFetch({});
    render(<LanPanel ctx={{ ...ctx, served: false, connected: false }} fetchImpl={f.impl} />);
    expect(screen.getByTestId("lan-panel")).toHaveTextContent(/needs the local connector/);
    expect(f.calls).toHaveLength(0);
  });
});

describe("pairing on a LAN device", () => {
  it("fetchSession asks to pair and forgets a revoked token", async () => {
    localStorage.setItem(LAN_TOKEN_KEY, "r".repeat(64));
    const f = fakeFetch({
      "GET /api/session": () => [403, { error: "pairing_required" }],
    });
    await expect(fetchSession(f.impl)).rejects.toBeInstanceOf(PairingRequiredError);
    expect(f.calls[0]?.auth).toBe(`Bearer ${"r".repeat(64)}`);
    expect(localStorage.getItem(LAN_TOKEN_KEY)).toBeNull();
  });

  it("pairWithCode stores the LAN token only on success", async () => {
    const ok = fakeFetch({
      "POST /api/lan/pair": () => [
        200,
        { token: "n".repeat(64), wsUrl: "/ws", scope: "lan", device: { name: "Tablet" } },
      ],
    });
    expect(await pairWithCode("ABCD-2345", "Tablet", ok.impl)).toEqual({
      ok: true,
      deviceName: "Tablet",
    });
    expect(localStorage.getItem(LAN_TOKEN_KEY)).toBe("n".repeat(64));
    localStorage.clear();
    const bad = fakeFetch({
      "POST /api/lan/pair": () => [401, { error: "invalid_code", message: "That code is wrong" }],
    });
    expect(await pairWithCode("NOPE", "Tablet", bad.impl)).toEqual({
      ok: false,
      message: "That code is wrong",
    });
    expect(localStorage.getItem(LAN_TOKEN_KEY)).toBeNull();
  });

  it("reads the code from a pairing link", () => {
    expect(pairCodeFromHash("#pair=abcd2345")).toBe("ABCD2345");
    expect(pairCodeFromHash("#x=1&pair=WXYZ-6789")).toBe("WXYZ-6789");
    expect(pairCodeFromHash("#other")).toBe("");
  });

  it("the pair form prefills from the link, pairs and hands over", async () => {
    window.history.replaceState(null, "", "/settings#pair=ABCD2345");
    const onPaired = vi.fn();
    const f = fakeFetch({
      "POST /api/lan/pair": (body) => [
        (body as { code: string }).code === "ABCD2345" ? 200 : 401,
        { token: "p".repeat(64), device: { name: "Den tablet" } },
      ],
    });
    render(<PairDeviceForm onPaired={onPaired} fetchImpl={f.impl} />);
    await waitFor(() => expect(screen.getByTestId("pair-code")).toHaveValue("ABCD2345"));
    fireEvent.change(screen.getByTestId("pair-name"), { target: { value: "Den tablet" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("pair-submit"));
    });
    await waitFor(() => expect(onPaired).toHaveBeenCalledTimes(1));
    expect(f.calls[0]?.body).toEqual({ code: "ABCD2345", name: "Den tablet" });
    expect(window.location.hash).toBe("");
    expect(screen.getByText("Paired as Den tablet")).toBeInTheDocument();
  });

  it("shows the connector's message when the code is wrong", async () => {
    window.history.replaceState(null, "", "/settings");
    const onPaired = vi.fn();
    const f = fakeFetch({
      "POST /api/lan/pair": () => [
        429,
        { error: "pairing_locked", message: "Too many wrong codes" },
      ],
    });
    render(<PairDeviceForm onPaired={onPaired} fetchImpl={f.impl} />);
    expect(screen.getByTestId("pair-submit")).toBeDisabled();
    fireEvent.change(screen.getByTestId("pair-code"), { target: { value: "zzzz-zzzz" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("pair-submit"));
    });
    expect(await screen.findByText("Too many wrong codes")).toBeInTheDocument();
    expect(onPaired).not.toHaveBeenCalled();
  });
});

describe("countdown helpers", () => {
  it("formats the time left", () => {
    expect(secondsLeft(new Date(10_500).toISOString(), 0)).toBe(11);
    expect(secondsLeft(new Date(0).toISOString(), 5_000)).toBe(0);
    expect(formatCountdown(299)).toBe("4:59");
    expect(formatCountdown(5)).toBe("0:05");
  });
});
