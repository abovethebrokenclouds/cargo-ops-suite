import { createFileRoute } from "@tanstack/react-router";
import { BookOpen, Download, MapPinned } from "lucide-react";
import { useMemo, useState } from "react";

import { PageHero } from "@/components/AppNav";
import { EmptyState } from "@/components/EmptyState";
import { PayoutBreakdown } from "@/components/cargo/PayoutBreakdown";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { Panel } from "@/components/dashboard/Panel";
import { SourceTag } from "@/components/status/SourceTag";
import { TrackMap } from "@/components/logbook/TrackMap";
import { useLogbook, useTrack, type LogbookEntry } from "@/lib/economy/logbook";
import { EMPTY, formatInt, formatMinutes, formatUsd } from "@/lib/format";
import { downloadExport } from "@/lib/transport/connector-api";
import { useSimConnection } from "@/lib/transport/useSimConnection";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/logbook")({
  head: () => ({
    meta: [
      { title: "Logbook — Cargo Ops" },
      {
        name: "description",
        content:
          "Every flight with landing grade, distance and payload, exportable to CSV, GPX and JSON.",
      },
      { property: "og:title", content: "Logbook — Cargo Ops" },
      {
        property: "og:description",
        content:
          "Every flight with landing grade, distance and payload, exportable to CSV, GPX and JSON.",
      },
    ],
  }),
  component: Logbook,
});

const columns = ["Date", "Route", "Aircraft", "Distance", "Block", "Landing", "Payout", "Status"];

const exportButton =
  "inline-flex items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-secondary/70 disabled:cursor-not-allowed disabled:text-muted-foreground disabled:opacity-60";

function date(iso: string | null): string {
  return iso ? iso.slice(0, 16).replace("T", " ") : EMPTY;
}

function statusTone(e: LogbookEntry): string {
  const s = e.mission?.status ?? e.status;
  if (s === "delivered" || s === "completed") return "text-success";
  if (s === "failed") return "text-destructive";
  if (s === "aborted") return "text-warning";
  return "text-accent";
}

function Logbook() {
  const { state } = useSimConnection();
  const { entries, missions, error, connector } = useLogbook(state);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const selected = entries?.find((e) => e.id === selectedId) ?? entries?.[0] ?? null;
  const track = useTrack(connector ? (selected?.id ?? null) : null);
  const mission = selected?.mission
    ? (missions.find((m) => m.id === selected.mission?.id) ?? null)
    : null;
  const totals = useMemo(() => {
    if (!entries) return null;
    return {
      hours: entries.reduce((s, e) => s + (e.blockMin ?? 0), 0) / 60,
      flights: entries.length,
      nm: entries.reduce((s, e) => s + (e.distanceNm ?? 0), 0),
      paid: entries.reduce((s, e) => s + (e.mission?.payout ?? 0), 0),
    };
  }, [entries]);
  const source = connector ? state.source : null;
  const disabledNote = connector ? undefined : "Exports come from the local connector";

  const doExport = (path: string, name: string) => {
    setExportError(null);
    downloadExport(path, name).catch((err: unknown) =>
      setExportError(err instanceof Error ? err.message : "Export failed"),
    );
  };

  return (
    <>
      <PageHero
        eyebrow="Logbook"
        title="Every leg, on record."
        sub="Verified flights with landing grades, distance flown, missions and payouts."
      />
      <div className="grid-ops">
        <MetricTile
          className="col-span-12 md:col-span-6 xl:col-span-3"
          label="Total hours"
          value={totals?.hours ?? null}
          format={(n) => n.toFixed(1)}
          unit="h"
          size="xl"
          source={totals ? source : null}
        />
        <MetricTile
          className="col-span-6 xl:col-span-3"
          label="Flights"
          value={totals?.flights ?? null}
          source={totals ? source : null}
        />
        <MetricTile
          className="col-span-6 xl:col-span-3"
          label="Distance"
          value={totals?.nm ?? null}
          unit="nm"
          source={totals ? source : null}
        />
        <MetricTile
          className="col-span-12 xl:col-span-3"
          label="Paid out"
          value={totals?.paid ?? null}
          format={formatUsd}
          source={totals ? source : null}
        />
        <Panel
          className="col-span-12"
          eyebrow="History"
          title="Flights"
          icon={BookOpen}
          action={
            <div className="flex flex-wrap items-center justify-end gap-2">
              <SourceTag source={source} />
              <button
                type="button"
                className={exportButton}
                disabled={!connector || !entries?.length}
                title={disabledNote}
                data-testid="export-csv"
                onClick={() => doExport("/api/export/csv", "cargo-ops-logbook.csv")}
              >
                <Download className="size-3.5" aria-hidden="true" /> CSV
              </button>
              <button
                type="button"
                className={exportButton}
                disabled={!connector || !selected}
                title={disabledNote}
                data-testid="export-gpx"
                onClick={() =>
                  selected &&
                  doExport(
                    `/api/export/gpx?flight=${encodeURIComponent(selected.id)}`,
                    `cargo-ops-${selected.id}.gpx`,
                  )
                }
              >
                <Download className="size-3.5" aria-hidden="true" /> GPX
              </button>
              <button
                type="button"
                className={exportButton}
                disabled={!connector}
                title={disabledNote}
                data-testid="export-json"
                onClick={() => doExport("/api/export/json", "cargo-ops-career.json")}
              >
                <Download className="size-3.5" aria-hidden="true" /> JSON
              </button>
            </div>
          }
          bodyClassName="p-0 md:p-0"
        >
          {!connector ? (
            <p
              className="border-b border-border px-5 py-3 text-xs text-muted-foreground md:px-6"
              data-testid="export-disabled-note"
            >
              Flights are recorded by the local connector. Exports (CSV, GPX, JSON) are disabled in
              demo mode.
            </p>
          ) : null}
          {exportError ? (
            <p className="px-5 py-3 text-xs text-destructive md:px-6" role="alert">
              {exportError}
            </p>
          ) : null}
          <div className="overflow-x-auto">
            <table className="w-full min-w-[48rem] text-left text-sm" data-testid="logbook-table">
              <thead>
                <tr className="border-b border-border">
                  {columns.map((c) => (
                    <th
                      key={c}
                      scope="col"
                      className="label-eyebrow px-5 py-3 font-semibold md:px-6"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(entries ?? []).map((e) => (
                  <tr
                    key={e.id}
                    className={cn(
                      "cursor-pointer border-b border-border/60 transition-colors hover:bg-secondary/40",
                      selected?.id === e.id && "bg-secondary/60",
                    )}
                    onClick={() => setSelectedId(e.id)}
                    data-testid="logbook-row"
                    data-flight-id={e.id}
                  >
                    <td className="px-5 py-3 font-mono text-xs text-muted-foreground md:px-6">
                      {date(e.startedAt)}
                    </td>
                    <td className="px-5 py-3 font-mono font-semibold text-foreground md:px-6">
                      {e.origin ?? "????"} → {e.destination ?? "????"}
                    </td>
                    <td className="max-w-[12rem] truncate px-5 py-3 text-muted-foreground md:px-6">
                      {e.aircraftTitle ?? EMPTY}
                    </td>
                    <td className="px-5 py-3 font-tabular md:px-6">
                      {e.distanceNm === null ? EMPTY : `${formatInt(e.distanceNm)} nm`}
                    </td>
                    <td className="px-5 py-3 font-tabular md:px-6">{formatMinutes(e.blockMin)}</td>
                    <td className="px-5 py-3 font-mono font-semibold text-accent md:px-6">
                      {e.landing?.grade ?? EMPTY}
                    </td>
                    <td className="px-5 py-3 font-tabular md:px-6" data-testid="logbook-payout">
                      {e.mission?.payout != null ? formatUsd(e.mission.payout) : EMPTY}
                    </td>
                    <td className={cn("px-5 py-3 text-xs md:px-6", statusTone(e))}>
                      {e.mission ? `${e.mission.status} · ${e.status}` : e.status}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {!entries || entries.length === 0 ? (
            <div className="p-5 md:p-6">
              <EmptyState
                icon={BookOpen}
                title={connector ? "No flights logged yet" : "No logbook in demo mode"}
                description={
                  connector
                    ? (error ?? "Flights are recorded automatically from block-out to arrival.")
                    : "Run the local connector: every tracked flight lands here with its mission and payout."
                }
              />
            </div>
          ) : null}
        </Panel>

        {selected ? (
          <Panel
            className="col-span-12"
            eyebrow="Flight detail"
            title={`${selected.origin ?? "????"} → ${selected.destination ?? "????"}`}
            icon={MapPinned}
            action={<SourceTag source={source} />}
          >
            <div className="grid gap-5 lg:grid-cols-2" data-testid="flight-detail">
              <div>
                {track && track.length > 0 ? (
                  <TrackMap
                    points={track}
                    origin={selected.origin}
                    destination={selected.destination}
                  />
                ) : (
                  <EmptyState
                    icon={MapPinned}
                    title={track === null ? "Loading track…" : "No track recorded"}
                  />
                )}
                <dl className="mt-4 grid grid-cols-2 gap-3 font-mono text-xs sm:grid-cols-4">
                  {[
                    ["Block", formatMinutes(selected.blockMin)],
                    ["Airborne", formatMinutes(selected.airborneMin)],
                    [
                      "Landing",
                      selected.landing
                        ? `${selected.landing.grade} · ${selected.landing.rateFpm} fpm`
                        : EMPTY,
                    ],
                    [
                      "Payload",
                      selected.payloadKg != null ? `${formatInt(selected.payloadKg)} kg` : EMPTY,
                    ],
                  ].map(([k, v]) => (
                    <div key={k} className="panel-inset p-3">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="mt-1 text-foreground">{v}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              <div className="flex flex-col gap-3">
                {mission?.payout ? (
                  mission.payout.jobs.map((b) => (
                    <div key={b.jobId}>
                      <p className="mb-1 font-mono text-xs text-muted-foreground">
                        Mission {mission.id} · {b.jobId}
                      </p>
                      <PayoutBreakdown breakdown={b} />
                    </div>
                  ))
                ) : (
                  <EmptyState
                    title={selected.mission ? "No payout" : "No mission on this flight"}
                    description={
                      selected.mission?.failure?.message ??
                      (selected.mission
                        ? `Mission ${selected.mission.status}.`
                        : "Free flight: nothing was carried for a contract.")
                    }
                  />
                )}
              </div>
            </div>
          </Panel>
        ) : null}
      </div>
    </>
  );
}
