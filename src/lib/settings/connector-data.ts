// Data management calls for /settings (P6): backups, SimBrief settings and import, the
// masked access token, career import. Browser-only (effects and handlers), same-origin
// connector API with the bearer token from /api/session.

import { useCallback, useEffect, useState } from "react";
import type { PlannedFlight, SimbriefSettings } from "@cargo-ops/protocol";

import { connectorFetch, connectorJson } from "@/lib/transport/connector-api";
import { fetchSession } from "@/lib/transport/useSimConnection";

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  createdAt: string;
  kind: "daily" | "manual";
}

export interface BackupsView {
  dir: string;
  keep: number;
  database: "live" | "demo";
  backups: BackupInfo[];
  restore: string[];
}

export type Loadable<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

function message(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/** Error text from a JSON error body `{ error, message }`, else the HTTP status. */
async function errorText(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string; error?: string };
    return body.message ?? body.error ?? `HTTP ${res.status}`;
  } catch {
    return `HTTP ${res.status}`;
  }
}

/** Show at most the last 4 characters: the page never displays the whole token. */
export function maskToken(token: string | null | undefined): string {
  if (!token) return "—";
  const tail = token.length > 8 ? token.slice(-4) : "";
  return `${"•".repeat(12)}${tail}`;
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** The masked token of this connector (fetched once; null when not served by one). */
export function useMaskedToken(enabled: boolean): Loadable<string> {
  const [state, setState] = useState<Loadable<string>>({ status: "idle" });
  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    let alive = true;
    setState({ status: "loading" });
    fetchSession(globalThis.fetch.bind(globalThis))
      .then((s) => alive && setState({ status: "ready", data: maskToken(s.token) }))
      .catch((err: unknown) => alive && setState({ status: "error", message: message(err, "") }));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return state;
}

export function useBackups(enabled: boolean) {
  const [state, setState] = useState<Loadable<BackupsView>>({ status: "idle" });
  /** Set on a paired LAN device: backups (and their paths) stay on the PC. */
  const [localOnly, setLocalOnly] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(() => {
    setState((s) => (s.status === "ready" ? s : { status: "loading" }));
    return connectorFetch("/api/backups", { headers: { Accept: "application/json" } })
      .then(async (res) => {
        if (res.status === 403) {
          const body = (await res.json().catch(() => null)) as {
            error?: string;
            message?: string;
          } | null;
          if (body?.error === "local_only") {
            setLocalOnly(body.message ?? "Backups are only available on the PC.");
            setState({ status: "idle" });
            return;
          }
        }
        if (!res.ok) throw new Error(`/api/backups failed (${res.status})`);
        setLocalOnly(null);
        setState({ status: "ready", data: (await res.json()) as BackupsView });
      })
      .catch((err: unknown) =>
        setState({ status: "error", message: message(err, "Could not load backups") }),
      );
  }, []);

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    void load();
  }, [enabled, load]);

  const create = useCallback(async () => {
    setBusy(true);
    setNote(null);
    try {
      const res = await connectorFetch("/api/backups", { method: "POST" });
      if (!res.ok) {
        setNote({ tone: "error", text: await errorText(res) });
        return;
      }
      const body = (await res.json()) as { backup: BackupInfo };
      setNote({ tone: "ok", text: `Backup written: ${body.backup.name}` });
      await load();
    } catch (err) {
      setNote({ tone: "error", text: message(err, "Backup failed") });
    } finally {
      setBusy(false);
    }
  }, [load]);

  return { state, busy, note, create, reload: load, localOnly };
}

export interface SimbriefView {
  settings: SimbriefSettings;
  plan: PlannedFlight | null;
  endpoint: string;
  verified: boolean;
}

export function useSimbrief(enabled: boolean) {
  const [state, setState] = useState<Loadable<SimbriefView>>({ status: "idle" });
  const [busy, setBusy] = useState<"save" | "import" | "clear" | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);

  const load = useCallback(
    () =>
      connectorJson<SimbriefView>("/api/simbrief")
        .then((data) => setState({ status: "ready", data }))
        .catch((err: unknown) =>
          setState({ status: "error", message: message(err, "Could not load SimBrief settings") }),
        ),
    [],
  );

  useEffect(() => {
    if (!enabled) {
      setState({ status: "idle" });
      return;
    }
    setState({ status: "loading" });
    void load();
  }, [enabled, load]);

  const run = useCallback(
    async (kind: "save" | "import" | "clear", path: string, init: RequestInit, ok: string) => {
      setBusy(kind);
      setNote(null);
      try {
        const res = await connectorFetch(path, {
          ...init,
          headers: { "Content-Type": "application/json", Accept: "application/json" },
        });
        if (!res.ok) {
          setNote({ tone: "error", text: await errorText(res) });
          return false;
        }
        setNote({ tone: "ok", text: ok });
        await load();
        return true;
      } catch (err) {
        setNote({ tone: "error", text: message(err, "Request failed") });
        return false;
      } finally {
        setBusy(null);
      }
    },
    [load],
  );

  const save = useCallback(
    (update: Partial<Pick<SimbriefSettings, "enabled" | "username" | "userId">>) =>
      run("save", "/api/simbrief", { method: "PUT", body: JSON.stringify(update) }, "Saved"),
    [run],
  );
  const importLatest = useCallback(
    () => run("import", "/api/simbrief/import", { method: "POST" }, "Latest OFP imported"),
    [run],
  );
  const clear = useCallback(
    () => run("clear", "/api/simbrief/plan", { method: "DELETE" }, "Planned flight cleared"),
    [run],
  );

  return { state, busy, note, save, importLatest, clear };
}

/** The imported planned flight for the job board (null when none or not connected). */
export function usePlannedFlight(enabled: boolean): PlannedFlight | null {
  const [plan, setPlan] = useState<PlannedFlight | null>(null);
  useEffect(() => {
    if (!enabled) {
      setPlan(null);
      return;
    }
    let alive = true;
    connectorJson<SimbriefView>("/api/simbrief")
      .then((v) => alive && setPlan(v.settings.enabled ? v.plan : null))
      .catch(() => alive && setPlan(null));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return plan;
}

/** POST a career export file to /api/import. Returns a user-facing result. */
export async function importCareerFile(
  file: Blob,
): Promise<{ ok: true; text: string } | { ok: false; text: string }> {
  let json: unknown;
  try {
    json = JSON.parse(await file.text());
  } catch {
    return { ok: false, text: "That file is not JSON. Pick a Cargo Ops career export (.json)." };
  }
  try {
    const res = await connectorFetch("/api/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(json),
    });
    if (!res.ok) return { ok: false, text: await errorText(res) };
    const body = (await res.json()) as { counts?: Record<string, number> };
    const counts = body.counts
      ? Object.entries(body.counts)
          .filter(([, n]) => n > 0)
          .map(([k, n]) => `${n} ${k}`)
          .join(", ")
      : "";
    return { ok: true, text: `Career imported${counts ? `: ${counts}` : ""}.` };
  } catch (err) {
    return { ok: false, text: message(err, "Import failed") };
  }
}
