// LAN access for /settings (connector --lan, plan §3.2). On this PC: status, bound URLs, the
// saved opt-in (applies on the next start), the one-time pairing code and the paired devices
// with revoke. On a paired LAN device: who it is paired as (management stays on the PC).
// Browser-only: effects and handlers.

import { useCallback, useEffect, useState } from "react";

import { connectorFetch } from "@/lib/transport/connector-api";
import { fetchSession, type ConnectorSession } from "@/lib/transport/useSimConnection";

export interface LanDeviceView {
  id: string;
  name: string;
  pairedAt: string;
  pairedFrom: string;
  lastSeenAt: string | null;
}

export interface LanView {
  active: boolean;
  bind: string | null;
  port: number;
  urls: string[];
  interfaces: string[];
  setting: { enabled: boolean; address: string } | null;
  restartRequired: boolean;
  code: {
    code: string;
    display: string;
    expiresAt: string;
    ttlSec: number;
    pairUrls: string[];
  } | null;
  devices: LanDeviceView[];
}

export type LanState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "device"; name: string }
  | { status: "local"; view: LanView };

type Note = { tone: "ok" | "error"; text: string } | null;

async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** `#pair=ABCD2345` from a pairing link opened on the tablet (the fragment never leaves it). */
export function pairCodeFromHash(hash: string): string {
  const m = /(?:^#|&)pair=([A-Za-z0-9-]{1,16})/.exec(hash);
  return m?.[1]?.toUpperCase() ?? "";
}

/** Seconds left until an ISO time, never negative. */
export function secondsLeft(iso: string, now: number): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - now) / 1000)) : 0;
}

export function formatCountdown(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function useLanAccess(enabled: boolean, fetchImpl?: typeof fetch) {
  const [state, setState] = useState<LanState>({ status: "idle" });
  const [busy, setBusy] = useState<"code" | "setting" | "revoke" | null>(null);
  const [note, setNote] = useState<Note>(null);

  const doFetch = useCallback(
    (path: string, init: RequestInit = {}) =>
      connectorFetch(
        path,
        { ...init, headers: { Accept: "application/json", "Content-Type": "application/json" } },
        fetchImpl ?? globalThis.fetch.bind(globalThis),
      ),
    [fetchImpl],
  );

  const load = useCallback(async () => {
    let session: ConnectorSession;
    try {
      session = await fetchSession(fetchImpl ?? globalThis.fetch.bind(globalThis));
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "unavailable" });
      return;
    }
    if (session.scope === "lan") {
      setState({ status: "device", name: session.device?.name ?? "LAN device" });
      return;
    }
    try {
      const res = await doFetch("/api/lan");
      if (!res.ok) {
        setState({ status: "error", message: await errorText(res) });
        return;
      }
      setState({ status: "local", view: (await res.json()) as LanView });
    } catch (err) {
      setState({ status: "error", message: err instanceof Error ? err.message : "unavailable" });
    }
  }, [doFetch, fetchImpl]);

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    void load();
  }, [enabled, load]);

  const run = useCallback(
    async (
      kind: "code" | "setting" | "revoke",
      path: string,
      init: RequestInit,
      ok: string,
    ): Promise<boolean> => {
      setBusy(kind);
      setNote(null);
      try {
        const res = await doFetch(path, init);
        if (!res.ok) {
          setNote({ tone: "error", text: await errorText(res) });
          return false;
        }
        setState({ status: "local", view: (await res.json()) as LanView });
        setNote({ tone: "ok", text: ok });
        return true;
      } catch (err) {
        setNote({ tone: "error", text: err instanceof Error ? err.message : "Request failed" });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [doFetch],
  );

  const generateCode = useCallback(
    () => run("code", "/api/lan/code", { method: "POST" }, "Pairing code ready (one use, 5 min)"),
    [run],
  );
  const cancelCode = useCallback(
    () => run("code", "/api/lan/code", { method: "DELETE" }, "Pairing code cancelled"),
    [run],
  );
  const saveSetting = useCallback(
    (enabledNext: boolean, address = "0.0.0.0") =>
      run(
        "setting",
        "/api/lan/settings",
        { method: "PUT", body: JSON.stringify({ enabled: enabledNext, address }) },
        enabledNext
          ? "Saved: LAN access turns on when the connector restarts"
          : "Saved: LAN access turns off when the connector restarts",
      ),
    [run],
  );
  const revoke = useCallback(
    (id: string, name: string) =>
      run(
        "revoke",
        `/api/lan/devices/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        `${name} can no longer connect`,
      ),
    [run],
  );

  return { state, busy, note, reload: load, generateCode, cancelCode, saveSetting, revoke };
}
