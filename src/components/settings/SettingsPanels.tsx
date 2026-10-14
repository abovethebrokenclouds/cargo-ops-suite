import {
  Archive,
  CloudDownload,
  CloudSun,
  Database,
  Download,
  FlaskConical,
  Gauge,
  Map as MapIcon,
  Plug,
  Route as RouteIcon,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { EmptyState } from "@/components/EmptyState";
import { Panel } from "@/components/dashboard/Panel";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Switch } from "@/components/ui/switch";
import { EMPTY, formatInt, formatMinutes } from "@/lib/format";
import {
  formatBytes,
  importCareerFile,
  useBackups,
  useMaskedToken,
  useSimbrief,
} from "@/lib/settings/connector-data";
import { useOnlineMapsSetting } from "@/lib/settings/map-settings";
import { useOnlineWeatherSetting } from "@/lib/settings/weather-settings";
import { useUnits } from "@/lib/settings/units";
import { connectorJson, downloadExport } from "@/lib/transport/connector-api";
import type { ClientSimState } from "@/lib/sim-state";
import { cn } from "@/lib/utils";

import {
  Field,
  Note,
  Segmented,
  SettingRow,
  inputClass,
  primaryButton,
  secondaryButton,
} from "./form";

/** What the settings page knows about the data source. */
export interface SettingsContext {
  state: ClientSimState;
  /** Served by the local connector (live transport), whatever its current state. */
  served: boolean;
  /** Connected to the connector right now (live or replay session). */
  connected: boolean;
}

function connectionLabel(ctx: SettingsContext): string {
  switch (ctx.state.connection) {
    case "live":
      return ctx.state.welcome?.sim.connected ? "Live · simulator connected" : "Live · sim offline";
    case "replay":
      return "Replay (--sim fake)";
    case "demo":
      return "Demo (in-browser)";
    case "connecting":
    case "idle":
      return "Connecting…";
    default:
      return "Connector offline";
  }
}

function NotConnected({ ctx, what }: { ctx: SettingsContext; what: string }) {
  if (ctx.connected) return null;
  return (
    <p
      className="rounded-md bg-secondary/60 px-3 py-2 text-xs text-muted-foreground"
      data-testid="settings-needs-connector"
    >
      {ctx.served
        ? `The connector is not reachable right now; ${what} comes back when it reconnects.`
        : `${what[0]?.toUpperCase()}${what.slice(1)} needs the local connector. This page is running in demo mode.`}
    </p>
  );
}

// ---- Units ----

export function UnitsPanel() {
  const [units, setUnits] = useUnits();
  return (
    <Panel
      className="col-span-12 md:col-span-6"
      eyebrow="Display · this browser"
      title="Units"
      icon={Gauge}
    >
      <div className="flex flex-col divide-y divide-border" data-testid="units-panel">
        <Segmented
          name="unit-weight"
          label="Weight (fuel, payload)"
          value={units.weight}
          options={[
            { value: "lb", label: "lb" },
            { value: "kg", label: "kg" },
          ]}
          onChange={(weight) => setUnits({ ...units, weight })}
        />
        <Segmented
          name="unit-altitude"
          label="Altitude"
          value={units.altitude}
          options={[
            { value: "ft", label: "ft" },
            { value: "m", label: "m" },
          ]}
          onChange={(altitude) => setUnits({ ...units, altitude })}
        />
        <Segmented
          name="unit-speed"
          label="Speed"
          value={units.speed}
          options={[{ value: "kt", label: "kt" }]}
          onChange={() => {}}
        />
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Applies to Live Flight and map readouts in this browser. Cargo weights, the job board and
        the economy are always in kilograms; speeds are always knots.
      </p>
    </Panel>
  );
}

// ---- Connector ----

export function ConnectorPanel({ ctx }: { ctx: SettingsContext }) {
  const token = useMaskedToken(ctx.served && ctx.connected);
  const [host, setHost] = useState<string | null>(null);
  useEffect(() => setHost(window.location.host), []);
  return (
    <Panel
      className="col-span-12 md:col-span-6"
      eyebrow="Simulator link"
      title="Connector"
      icon={Plug}
    >
      <dl className="flex flex-col divide-y divide-border" data-testid="connector-panel">
        <SettingRow label="Status">
          <span data-testid="connector-status">{connectionLabel(ctx)}</span>
        </SettingRow>
        <SettingRow label="Address">
          {ctx.served ? (host ?? EMPTY) : "not served by the connector"}
        </SettingRow>
        <SettingRow label="Access token" testId="token-row">
          <span data-testid="token-masked">
            {!ctx.served
              ? "none in demo mode"
              : token.status === "ready"
                ? token.data
                : token.status === "error"
                  ? "unavailable"
                  : EMPTY}
          </span>
        </SettingRow>
      </dl>
      <details className="mt-3 text-xs text-muted-foreground">
        <summary className="cursor-pointer text-foreground">Port and token reset</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>
            The connector listens on 127.0.0.1 only (default port 4311) unless you turn on LAN
            access below. Another port:{" "}
            <code className="font-mono">scripts\start-cargo-ops.cmd --port 4312</code>, then open
            that port.
          </li>
          <li>
            The token only protects the local API from other web pages; this page fetches it itself
            and never shows it in full. It never leaves this PC: LAN devices pair and get their own.
          </li>
          <li>
            Reset it: stop the connector and start it with{" "}
            <code className="font-mono">--reset-token</code> (or delete{" "}
            <code className="font-mono">%LOCALAPPDATA%\CargoOps\config.json</code>), then reload
            open tabs. <code className="font-mono">--reset-token</code> also unpairs every LAN
            device.
          </li>
        </ul>
      </details>
    </Panel>
  );
}

// ---- Basemap ----

export function BasemapPanel({ ctx }: { ctx: SettingsContext }) {
  const [localBasemap, setLocalBasemap] = useState<boolean | null>(null);
  useEffect(() => {
    if (!ctx.served) {
      setLocalBasemap(null);
      return;
    }
    let alive = true;
    fetch("/api/health", { headers: { Accept: "application/json" } })
      .then((r) => (r.ok ? (r.json() as Promise<{ basemap?: { local?: boolean } }>) : null))
      .then((h) => alive && setLocalBasemap(h?.basemap?.local ?? null))
      .catch(() => alive && setLocalBasemap(null));
    return () => {
      alive = false;
    };
  }, [ctx.served, ctx.connected]);
  return (
    <Panel className="col-span-12 md:col-span-6" eyebrow="Map" title="Basemap" icon={MapIcon}>
      <dl className="flex flex-col divide-y divide-border">
        <SettingRow label="Order">Local → Online → Outline</SettingRow>
        <SettingRow label="Local (PMTiles via connector)">
          <span data-testid="basemap-local">
            {localBasemap === null
              ? ctx.served
                ? "unknown"
                : "needs the connector"
              : localBasemap
                ? "installed"
                : "not installed"}
          </span>
        </SettingRow>
        <SettingRow label="Online maps (OpenFreeMap)">
          <OnlineMapsSwitch />
        </SettingRow>
        <SettingRow label="Offline floor">Natural Earth outline</SettingRow>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        Local extract: <code className="font-mono">scripts\fetch-basemap.ps1</code> (OpenStreetMap
        data, ODbL). Online maps fetch tiles from tiles.openfreemap.org; turn them off to stay fully
        offline.
      </p>
    </Panel>
  );
}

/** Per-browser toggle; off keeps the map fully offline (local PMTiles or the outline). */
function OnlineMapsSwitch() {
  const [enabled, setEnabled] = useOnlineMapsSetting();
  return (
    <span className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {enabled === null ? "…" : enabled ? "On" : "Off"}
      </span>
      <Switch
        checked={enabled ?? false}
        disabled={enabled === null}
        onCheckedChange={setEnabled}
        aria-label="Allow online maps (OpenFreeMap)"
        data-testid="online-maps-switch"
      />
    </span>
  );
}

// ---- Weather ----

const WEATHER_MODE_LABEL: Record<string, string> = {
  online: "Online (aviationweather.gov)",
  sample: "Sample METARs (not real weather)",
  off: "Off (--weather off)",
};

export function WeatherPanel({ ctx }: { ctx: SettingsContext }) {
  const [mode, setMode] = useState<string | null>(null);
  const enabled = ctx.served && ctx.connected;
  useEffect(() => {
    if (!enabled) {
      setMode(null);
      return;
    }
    let alive = true;
    connectorJson<{ weather?: string }>("/api/status")
      .then((s) => alive && setMode(s.weather ?? null))
      .catch(() => alive && setMode(null));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return (
    <Panel className="col-span-12 md:col-span-6" eyebrow="METAR" title="Weather" icon={CloudSun}>
      <dl className="flex flex-col divide-y divide-border">
        <SettingRow label="Source">
          <span data-testid="weather-mode">
            {!ctx.served
              ? "Sample METARs (demo, no network)"
              : mode
                ? (WEATHER_MODE_LABEL[mode] ?? mode)
                : "needs the connector"}
          </span>
        </SettingRow>
        <SettingRow label="Online weather (aviationweather.gov)">
          <OnlineWeatherSwitch />
        </SettingRow>
      </dl>
      <p className="mt-3 text-xs text-muted-foreground">
        With the switch on, the connector fetches origin and destination METARs from the NOAA
        Aviation Weather Center (aviationweather.gov: public US Government data, no key), caches
        them for 10 minutes and shows them on Live Flight and the job board. Off, no weather request
        leaves your PC. Replays and the demo show SAMPLE METARs, never real weather.
      </p>
    </Panel>
  );
}

/** Per-browser toggle, like online maps; off = the connector makes no weather request. */
function OnlineWeatherSwitch() {
  const [enabled, setEnabled] = useOnlineWeatherSetting();
  return (
    <span className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {enabled === null ? "…" : enabled ? "On" : "Off"}
      </span>
      <Switch
        checked={enabled ?? false}
        disabled={enabled === null}
        onCheckedChange={setEnabled}
        aria-label="Allow online weather (aviationweather.gov)"
        data-testid="online-weather-switch"
      />
    </span>
  );
}

// ---- Demo mode ----

export function DemoPanel({ ctx }: { ctx: SettingsContext }) {
  return (
    <Panel
      className="col-span-12 md:col-span-6"
      eyebrow="Data source"
      title="Demo mode"
      icon={FlaskConical}
    >
      <dl className="flex flex-col divide-y divide-border">
        <SettingRow label="Demo mode">
          <span data-testid="demo-mode">
            {ctx.served ? "Off (connector)" : "On (no connector)"}
          </span>
        </SettingRow>
      </dl>
      <p className="mt-3 text-sm text-muted-foreground">
        There is no switch on purpose. Demo mode is on exactly when this page is not served by the
        local connector (the Lovable preview or a dev server): a built-in recording plays and every
        value is tagged DEMO. Served by the connector the page never falls back to demo data; with{" "}
        <code className="font-mono">--sim fake</code> the connector replays a recording tagged
        REPLAY into a separate demo database, never into your career.
      </p>
    </Panel>
  );
}

// ---- Data: export/import and backups ----

export function DataPanel({ ctx }: { ctx: SettingsContext }) {
  const enabled = ctx.served && ctx.connected;
  const backups = useBackups(enabled);
  const [exportNote, setExportNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, setPending] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const doExport = () => {
    setExportNote(null);
    downloadExport("/api/export/json", "cargo-ops-career.json")
      .then(() => setExportNote({ tone: "ok", text: "Career export downloaded" }))
      .catch((err: unknown) =>
        setExportNote({ tone: "error", text: err instanceof Error ? err.message : "Failed" }),
      );
  };

  const doImport = async () => {
    if (!pending) return;
    setImporting(true);
    const r = await importCareerFile(pending);
    setImporting(false);
    setPending(null);
    if (fileRef.current) fileRef.current.value = "";
    setExportNote({ tone: r.ok ? "ok" : "error", text: r.text });
  };

  const view = backups.state.status === "ready" ? backups.state.data : null;

  return (
    <Panel
      className="col-span-12"
      eyebrow="Your career"
      title="Data"
      icon={Database}
      action={
        view ? (
          <span className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground">
            {view.database === "live" ? "career database" : "replay database"}
          </span>
        ) : null
      }
    >
      <div className="flex flex-col gap-6" data-testid="data-panel">
        <NotConnected ctx={ctx} what="data management" />
        <div className="grid gap-6 lg:grid-cols-2">
          <section aria-labelledby="career-heading" className="flex flex-col gap-3">
            <h3 id="career-heading" className="font-display text-base font-semibold">
              Career export and import
            </h3>
            <p className="text-sm text-muted-foreground">
              One JSON file with the company, jobs, missions, ledger, logbook, fleet, loans, used
              market and FBOs (no telemetry). Importing <strong>replaces</strong> the current career
              and is refused during a flight.
            </p>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className={secondaryButton}
                disabled={!enabled}
                onClick={doExport}
                data-testid="career-export"
              >
                <Download className="size-4" aria-hidden="true" /> Export career (JSON)
              </button>
              <label
                className={cn(secondaryButton, !enabled && "pointer-events-none opacity-50")}
                htmlFor="career-import"
              >
                <Upload className="size-4" aria-hidden="true" /> Import career…
              </label>
              <input
                ref={fileRef}
                id="career-import"
                type="file"
                accept="application/json,.json"
                className="sr-only"
                disabled={!enabled}
                data-testid="career-import-input"
                onChange={(e) => setPending(e.target.files?.[0] ?? null)}
              />
            </div>
            <Note note={exportNote} />
          </section>

          <section aria-labelledby="backups-heading" className="flex flex-col gap-3">
            <h3 id="backups-heading" className="font-display text-base font-semibold">
              Backups
            </h3>
            <p className="text-sm text-muted-foreground">
              The connector writes a daily copy of the career database
              {view ? ` and keeps the newest ${view.keep}` : ""}. Back up before an import or a big
              purchase.
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                className={primaryButton}
                disabled={!enabled || backups.busy}
                onClick={() => void backups.create()}
                data-testid="backup-now"
              >
                <Archive className="size-4" aria-hidden="true" />
                {backups.busy ? "Backing up…" : "Back up now"}
              </button>
            </div>
            <Note note={backups.note} />
            {view ? (
              <p className="break-all font-mono text-xs text-muted-foreground">
                Folder: {view.dir}
              </p>
            ) : null}
          </section>
        </div>

        {backups.state.status === "error" ? (
          <EmptyState
            icon={Archive}
            title="Backups could not be listed"
            description={backups.state.message}
          />
        ) : backups.state.status === "loading" ? (
          <EmptyState icon={Archive} title="Loading backups…" />
        ) : view && view.backups.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm" data-testid="backup-list">
              <caption className="sr-only">Database backups, newest first</caption>
              <thead>
                <tr className="border-b border-border">
                  {["File", "Type", "Created (UTC)", "Size"].map((h) => (
                    <th key={h} scope="col" className="label-eyebrow px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {view.backups.map((b) => (
                  <tr
                    key={b.name}
                    className="border-b border-border/60"
                    data-testid="backup-row"
                    data-name={b.name}
                  >
                    <td className="px-3 py-2 font-mono text-xs text-foreground">{b.name}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{b.kind}</td>
                    <td className="px-3 py-2 font-mono text-xs text-muted-foreground">
                      {b.createdAt.slice(0, 19).replace("T", " ")}
                    </td>
                    <td className="px-3 py-2 font-tabular text-xs">{formatBytes(b.sizeBytes)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : enabled ? (
          <EmptyState
            icon={Archive}
            title="No backups yet"
            description={
              view?.database === "demo"
                ? "Replays do not write daily backups; use Back up now to try it."
                : "The first daily backup is written when the connector starts."
            }
          />
        ) : null}

        {view ? (
          <details className="text-xs text-muted-foreground">
            <summary className="cursor-pointer text-foreground">Restore a backup</summary>
            <ol className="mt-2 list-decimal space-y-1 pl-5" data-testid="restore-steps">
              {view.restore.map((s) => (
                <li key={s} className="break-all">
                  {s}
                </li>
              ))}
            </ol>
          </details>
        ) : null}
      </div>

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the current career?</AlertDialogTitle>
            <AlertDialogDescription>
              Importing <span className="font-mono">{pending?.name}</span> replaces the company,
              fleet, loans, ledger, logbook and FBOs in the{" "}
              {view?.database === "demo" ? "replay" : "career"} database. Back up first if you might
              want them back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction disabled={importing} onClick={() => void doImport()}>
              Import and replace
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}

// ---- SimBrief ----

export function SimbriefPanel({ ctx }: { ctx: SettingsContext }) {
  const enabled = ctx.served && ctx.connected;
  const sb = useSimbrief(enabled);
  const view = sb.state.status === "ready" ? sb.state.data : null;
  const [username, setUsername] = useState("");
  const [userId, setUserId] = useState("");
  useEffect(() => {
    if (!view) return;
    setUsername(view.settings.username ?? "");
    setUserId(view.settings.userId ?? "");
  }, [view]);
  const on = view?.settings.enabled ?? false;
  const plan = view?.plan ?? null;

  return (
    <Panel
      className="col-span-12"
      eyebrow="Optional · off by default"
      title="SimBrief flight plan import"
      icon={RouteIcon}
    >
      <div className="flex flex-col gap-5" data-testid="simbrief-panel">
        <NotConnected ctx={ctx} what="SimBrief import" />
        <p className="text-sm text-muted-foreground">
          Uses <strong>your own free SimBrief account</strong>: when you press Import, the connector
          sends your SimBrief username or pilot ID to simbrief.com and fetches your latest flight
          plan (OFP). Nothing is sent until you turn this on and press Import. The job board then
          suggests contracts on that route.
        </p>
        <div className="flex items-center justify-between gap-4">
          <span className="text-sm text-muted-foreground" id="simbrief-enabled-label">
            Enable SimBrief import
          </span>
          <Switch
            checked={on}
            disabled={!view || sb.busy !== null}
            onCheckedChange={(v) => void sb.save({ enabled: v })}
            aria-labelledby="simbrief-enabled-label"
            data-testid="simbrief-enabled"
          />
        </div>
        <form
          className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void sb.save({ username: username.trim() || null, userId: userId.trim() || null });
          }}
        >
          <Field label="SimBrief username" htmlFor="simbrief-username">
            <input
              id="simbrief-username"
              className={inputClass}
              value={username}
              maxLength={64}
              autoComplete="off"
              spellCheck={false}
              disabled={!view}
              onChange={(e) => setUsername(e.target.value)}
            />
          </Field>
          <Field label="or pilot ID" htmlFor="simbrief-userid">
            <input
              id="simbrief-userid"
              className={cn(inputClass, "font-mono")}
              value={userId}
              inputMode="numeric"
              maxLength={12}
              autoComplete="off"
              disabled={!view}
              onChange={(e) => setUserId(e.target.value)}
            />
          </Field>
          <button type="submit" className={secondaryButton} disabled={!view || sb.busy !== null}>
            Save
          </button>
        </form>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={primaryButton}
            disabled={!view || !on || sb.busy !== null}
            onClick={() => void sb.importLatest()}
            data-testid="simbrief-import"
          >
            <CloudDownload className="size-4" aria-hidden="true" />
            {sb.busy === "import" ? "Importing…" : "Import latest OFP"}
          </button>
          {plan ? (
            <button
              type="button"
              className={secondaryButton}
              disabled={sb.busy !== null}
              onClick={() => void sb.clear()}
            >
              Clear planned flight
            </button>
          ) : null}
        </div>
        <Note note={sb.note} />
        {plan ? (
          <dl
            className="grid grid-cols-2 gap-3 font-mono text-xs sm:grid-cols-4"
            data-testid="planned-flight"
          >
            {[
              ["Route", `${plan.origin} → ${plan.destination}`],
              ["Aircraft", plan.aircraftIcao ?? EMPTY],
              [
                "Planned fuel",
                plan.plannedFuelKg === null ? EMPTY : `${formatInt(plan.plannedFuelKg)} kg`,
              ],
              ["Payload", plan.payloadKg === null ? EMPTY : `${formatInt(plan.payloadKg)} kg`],
              ["Distance", plan.distanceNm === null ? EMPTY : `${formatInt(plan.distanceNm)} nm`],
              ["ETE", formatMinutes(plan.eteMin)],
              ["Flight", plan.flightNumber ?? EMPTY],
              ["Fetched", plan.fetchedAt.slice(0, 16).replace("T", " ")],
            ].map(([k, v]) => (
              <div key={k} className="panel-inset p-3">
                <dt className="text-muted-foreground">{k}</dt>
                <dd className="mt-1 truncate text-foreground">{v}</dd>
              </div>
            ))}
            <div className="panel-inset col-span-2 p-3 sm:col-span-4">
              <dt className="text-muted-foreground">ATC route</dt>
              <dd className="mt-1 break-words text-foreground">{plan.route || "DCT"}</dd>
            </div>
          </dl>
        ) : null}
        <p className="text-xs text-muted-foreground">
          Endpoint {view?.endpoint ?? "www.simbrief.com/api/xml.fetcher.php"} (public fetch API, no
          key). Field mapping not yet verified against a real OFP; at most one request every 30 s,
          10 s timeout, no automatic retries.
        </p>
      </div>
    </Panel>
  );
}
