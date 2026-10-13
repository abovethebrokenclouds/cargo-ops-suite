import { Activity, Braces, ClipboardCopy, Network, Terminal } from "lucide-react";
import { useState } from "react";
import { PROTOCOL_VERSION, SIM_DOMAINS } from "@cargo-ops/protocol";

import { EmptyState } from "@/components/EmptyState";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { Panel } from "@/components/dashboard/Panel";
import { SourceTag } from "@/components/status/SourceTag";
import { EMPTY, formatInt } from "@/lib/format";
import {
  buildDiagnostics,
  compactJson,
  frameAgeMs,
  recentEvents,
  type ClientSimState,
} from "@/lib/sim-state";
import { useFrameRate, useNow } from "@/lib/sim-state/hooks";
import { useSimConnection } from "@/lib/transport/useSimConnection";
import { cn } from "@/lib/utils";

const EVENT_ROWS = 50;

function clockTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

function formatAge(ms: number | null): string {
  if (ms === null) return EMPTY;
  return ms < 10_000 ? `${formatInt(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function domainSummary(value: unknown): string {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (typeof value === "object") return `${Object.keys(value).length} fields`;
  return typeof value;
}

type CopyState = "idle" | "copied" | "unavailable" | "failed";

function CopyButton({ build }: { build: () => unknown }) {
  const [status, setStatus] = useState<CopyState>("idle");
  const onClick = async () => {
    const clipboard = typeof navigator === "undefined" ? undefined : navigator.clipboard;
    if (!clipboard?.writeText) {
      setStatus("unavailable");
      return;
    }
    try {
      await clipboard.writeText(JSON.stringify(build(), null, 2));
      setStatus("copied");
    } catch {
      setStatus("failed");
    }
  };
  const label = {
    idle: "Copy diagnostics",
    copied: "Copied to clipboard",
    unavailable: "Clipboard unavailable",
    failed: "Copy failed",
  }[status];
  return (
    <button
      type="button"
      onClick={() => void onClick()}
      className={cn(
        "inline-flex items-center gap-2 rounded-xl bg-gradient-brand px-5 py-3 text-sm font-semibold text-primary-foreground shadow-glow transition-transform hover:scale-[1.03]",
      )}
      aria-live="polite"
    >
      <ClipboardCopy className="size-4" aria-hidden="true" />
      {label}
    </button>
  );
}

function Row({ label, value, mono = true }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="panel-inset min-w-0 px-3 py-2.5">
      <dt className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "mt-1 truncate text-sm text-foreground",
          mono && "font-mono font-tabular",
          value === EMPTY && "text-muted-foreground",
        )}
        title={value}
      >
        {value}
      </dd>
    </div>
  );
}

function connectionRows(
  state: ClientSimState,
  transportKind: string | null,
  ageMs: number | null,
  fps: number | null,
): Array<[string, string]> {
  const w = state.welcome;
  return [
    ["Transport", transportKind ?? EMPTY],
    ["Connection", state.connection],
    ["Welcome mode", w?.mode ?? EMPTY],
    ["Session", w?.session ?? EMPTY],
    ["Simulator", state.sim.sim?.name ?? w?.sim.name ?? EMPTY],
    ["Sim version", w?.sim.version ?? EMPTY],
    ["SimConnect binding", w?.sim.protocol ?? EMPTY],
    ["Sim connected", w ? (w.sim.connected ? "yes" : "no") : EMPTY],
    ["Wire protocol", `v${PROTOCOL_VERSION}`],
    ["Last seq", state.lastSeq < 0 ? EMPTY : String(state.lastSeq)],
    ["Needs resync", state.needsResync ? "yes" : "no"],
    ["Frame age", formatAge(ageMs)],
    ["Frames / s (5 s)", fps === null ? EMPTY : fps.toFixed(1)],
    ["Last error", state.error ?? EMPTY],
  ];
}

/** Connection health, event log and raw state for debugging the connector link. */
export function DiagnosticsView() {
  const { state, transportKind } = useSimConnection();
  const now = useNow(1000);
  const fps = useFrameRate(state, now);
  const ageMs = now === null ? null : frameAgeMs(state, now);
  const events = recentEvents(state, EVENT_ROWS);

  return (
    <div className="grid-ops" data-testid="diagnostics">
      <div className="col-span-12 flex flex-wrap items-center justify-between gap-3">
        <p className="max-w-2xl text-sm text-muted-foreground">
          Fixture recording lives in the connector CLI: run it with{" "}
          <code className="rounded bg-secondary/70 px-1.5 py-0.5 font-mono text-xs text-foreground">
            --record
          </code>{" "}
          to capture a JSONL session for replay and tests.
        </p>
        <CopyButton
          build={() =>
            buildDiagnostics({
              state,
              transportKind,
              now: Date.now(),
              framesPerSec: fps,
            })
          }
        />
      </div>

      <MetricTile
        className="col-span-6 lg:col-span-3"
        label="Update rate"
        value={fps}
        format={(n) => n.toFixed(1)}
        unit="fps"
        digits={4}
        hint="Frames applied over the last 5 s"
      />
      <MetricTile
        className="col-span-6 lg:col-span-3"
        label="Frame age"
        value={ageMs}
        unit="ms"
        digits={6}
        tone={ageMs !== null && ageMs > 5000 ? "warning" : "default"}
        hint="Since the last applied frame"
      />
      <MetricTile
        className="col-span-6 lg:col-span-3"
        label="Last seq"
        value={state.lastSeq < 0 ? null : state.lastSeq}
        digits={5}
        hint={state.needsResync ? "Gap detected · resync requested" : "Contiguous"}
      />
      <MetricTile
        className="col-span-6 lg:col-span-3"
        label="Events"
        value={state.welcome ? state.events.length : null}
        digits={3}
        hint="Kept in memory (max 200)"
      />

      <Panel
        className="col-span-12 lg:col-span-5"
        eyebrow="Link"
        title="Connection"
        icon={Network}
        action={<SourceTag source={state.source} />}
      >
        <dl className="grid grid-cols-2 gap-2">
          {connectionRows(state, transportKind, ageMs, fps).map(([label, value]) => (
            <Row key={label} label={label} value={value} />
          ))}
        </dl>
      </Panel>

      <Panel
        className="col-span-12 lg:col-span-7"
        eyebrow="Events"
        title="Event log"
        icon={Activity}
        bodyClassName="p-0 md:p-0"
      >
        {events.length === 0 ? (
          <div className="p-5 md:p-6">
            <EmptyState
              icon={Activity}
              title="No events yet"
              description="Simulator, flight and phase events appear here as the connector sends them."
            />
          </div>
        ) : (
          <div className="max-h-[32rem] overflow-auto">
            <table className="w-full min-w-[36rem] border-collapse text-left font-mono text-xs">
              <thead className="sticky top-0 bg-card">
                <tr className="text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground">
                  <th className="px-4 py-2 font-medium">Time</th>
                  <th className="px-2 py-2 text-right font-medium">Seq</th>
                  <th className="px-2 py-2 font-medium">Source</th>
                  <th className="px-2 py-2 font-medium">Name</th>
                  <th className="px-4 py-2 font-medium">Data</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr
                    key={`${e.msg.seq}-${e.at}`}
                    className="border-t border-border align-top font-tabular"
                  >
                    <td className="whitespace-nowrap px-4 py-2 text-muted-foreground">
                      {clockTime(e.at)}
                    </td>
                    <td className="px-2 py-2 text-right text-foreground">{e.msg.seq}</td>
                    <td className="px-2 py-2">
                      <SourceTag source={e.msg.source} />
                      {e.msg.source === "sim" ? <span className="text-success">sim</span> : null}
                    </td>
                    <td className="whitespace-nowrap px-2 py-2 text-accent">{e.msg.name}</td>
                    <td className="max-w-[24rem] truncate px-4 py-2 text-muted-foreground">
                      {compactJson(e.msg.data)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel
        className="col-span-12"
        eyebrow="Raw"
        title="Latest state"
        icon={Braces}
        action={<SourceTag source={state.source} />}
      >
        <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">
          {SIM_DOMAINS.map((domain) => {
            const value = (state.sim as Record<string, unknown>)[domain];
            const present = value !== undefined && value !== null;
            return (
              <details
                key={domain}
                className="panel-inset group min-w-0 px-3 py-2"
                data-domain={domain}
              >
                <summary className="flex cursor-pointer list-none items-center justify-between gap-3 font-mono text-xs">
                  <span className="flex items-center gap-2">
                    <Terminal className="size-3.5 text-accent" aria-hidden="true" />
                    <span className={present ? "text-foreground" : "text-muted-foreground"}>
                      {domain}
                    </span>
                  </span>
                  <span className="text-[0.625rem] uppercase tracking-[0.14em] text-muted-foreground">
                    {domainSummary(value)}
                  </span>
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre font-mono text-[0.6875rem] leading-relaxed text-muted-foreground">
                  {value === undefined ? "// absent" : JSON.stringify(value, null, 2)}
                </pre>
              </details>
            );
          })}
        </div>
      </Panel>
    </div>
  );
}
