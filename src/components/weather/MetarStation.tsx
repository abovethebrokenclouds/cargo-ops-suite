import { useId, useState } from "react";
import {
  formatCeiling,
  formatObservationAge,
  formatVisibility,
  formatWind,
  hpaToInHg,
  isObservationOld,
  type MetarStationResult,
} from "@cargo-ops/weather";

import { cn } from "@/lib/utils";

import { FlightCategoryChip } from "./FlightCategoryChip";

const tagBase =
  "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold leading-none tracking-[0.16em]";

/** SAMPLE (never real weather) / LIVE / STALE tag for one report. */
export function MetarOriginTag({ origin, stale }: { origin: "live" | "sample"; stale: boolean }) {
  if (origin === "sample") {
    return (
      <span
        className={cn(tagBase, "bg-warning/15 text-warning")}
        title="Built-in sample for demonstration, not real weather"
        data-metar-origin="sample"
      >
        SAMPLE
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1">
      <span
        className={cn(tagBase, "bg-success/15 text-success")}
        title="Fetched from aviationweather.gov"
        data-metar-origin="live"
      >
        LIVE
      </span>
      {stale ? (
        <span
          className={cn(tagBase, "border border-muted-foreground/30 text-muted-foreground")}
          title="The last refresh failed; showing the previous report"
          data-metar-stale=""
        >
          STALE
        </span>
      ) : null}
    </span>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="label-eyebrow">{label}</dt>
      <dd className="mt-1 truncate font-mono text-sm text-foreground font-tabular">{value}</dd>
    </div>
  );
}

/** One station: category chip, decoded wind/visibility/ceiling, age, raw text toggle. */
export function MetarStation({
  role,
  result,
  now,
  className,
}: {
  role: string;
  result: MetarStationResult | null;
  /** Current time for the observation age (null before mount). */
  now: number | null;
  className?: string;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const rawId = useId();
  const report = result?.report ?? null;
  const age = report && now !== null ? formatObservationAge(report.observedAt, now) : null;
  const old = report && now !== null ? isObservationOld(report.observedAt, now) : false;
  return (
    <div
      className={cn("panel-inset flex min-w-0 flex-col gap-3 p-4", className)}
      data-testid="metar-station"
      data-station={result?.station ?? ""}
      data-category={report?.category ?? "unknown"}
      data-origin={report?.origin ?? "none"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="label-eyebrow">{role}</span>
        <span className="font-display text-xl font-bold tracking-tight">
          {result?.station ?? "—"}
        </span>
        {report ? (
          <>
            <FlightCategoryChip category={report.category} />
            <MetarOriginTag origin={report.origin} stale={report.stale} />
          </>
        ) : null}
        {age ? (
          <span
            className={cn("ml-auto text-xs", old ? "text-warning" : "text-muted-foreground")}
            data-testid="metar-age"
            title={report?.observedAt ?? undefined}
          >
            Observed {age}
          </span>
        ) : null}
      </div>

      {report ? (
        <>
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <Item label="Wind" value={formatWind(report.wind)} />
            <Item
              label="Visibility"
              value={formatVisibility(report.visibilitySm, report.visibilityPlus)}
            />
            <Item label="Ceiling" value={formatCeiling(report.ceilingFt, report.clouds !== null)} />
            <Item
              label="Temp / dew"
              value={
                report.tempC === null
                  ? "—"
                  : `${Math.round(report.tempC)}° / ${report.dewpointC === null ? "—" : `${Math.round(report.dewpointC)}°`} C`
              }
            />
          </dl>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {report.weather ? <span className="font-mono">Weather {report.weather}</span> : null}
            {report.altimeterHpa !== null ? (
              <span className="font-mono font-tabular">
                QNH {Math.round(report.altimeterHpa)} hPa ·{" "}
                {hpaToInHg(report.altimeterHpa).toFixed(2)} inHg
              </span>
            ) : null}
            <button
              type="button"
              className="ml-auto font-medium text-accent hover:text-foreground"
              aria-expanded={showRaw}
              aria-controls={rawId}
              onClick={() => setShowRaw((v) => !v)}
              data-testid="metar-raw-toggle"
            >
              {showRaw ? "Hide raw METAR" : "Raw METAR"}
            </button>
          </div>
          {showRaw ? (
            <pre
              id={rawId}
              className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/60 px-3 py-2 font-mono text-xs text-foreground"
              data-testid="metar-raw"
            >
              {report.rawText}
            </pre>
          ) : null}
        </>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="metar-note">
          {result?.note ?? "Loading weather…"}
        </p>
      )}
      {report && result?.note && report.origin === "live" ? (
        <p className="text-xs text-muted-foreground">{result.note}</p>
      ) : null}
    </div>
  );
}
