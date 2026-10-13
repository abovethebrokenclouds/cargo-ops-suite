import { Activity } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type uPlot from "uplot";

import { EmptyState } from "@/components/EmptyState";
import { formatInt } from "@/lib/format";
import type { TelemetryPoint } from "@/lib/sim-state/history";

type SeriesKey = "altFt" | "vsFpm" | "gsKt";

interface StripSeries {
  key: SeriesKey;
  label: string;
  unit: string;
  /** CSS custom property (design token) the line colour is read from. */
  token: string;
}

const STRIP_SERIES: readonly StripSeries[] = [
  { key: "altFt", label: "Altitude", unit: "ft", token: "--primary" },
  { key: "vsFpm", label: "Vertical speed", unit: "fpm", token: "--accent" },
  { key: "gsKt", label: "Ground speed", unit: "kt", token: "--tertiary" },
];

const STRIP_HEIGHT = 84;
const SYNC_KEY = "cargo-ops-telemetry";

/** Resolved value of a design token on :root, or undefined when it is not defined. */
function tokenColor(name: string): string | undefined {
  if (typeof document === "undefined") return undefined;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || undefined;
}

function seriesData(points: readonly TelemetryPoint[], key: SeriesKey): uPlot.AlignedData {
  return [points.map((p) => p.t / 1000), points.map((p) => p[key])];
}

function stripOptions(series: StripSeries, width: number): uPlot.Options {
  const axisStroke = tokenColor("--muted-foreground");
  const grid = tokenColor("--border");
  const stroke = tokenColor(series.token);
  const axis: uPlot.Axis = {
    size: 48,
    font: "10px var(--font-mono)",
    ...(axisStroke ? { stroke: axisStroke } : {}),
    grid: { show: true, width: 1, ...(grid ? { stroke: grid } : {}) },
    ticks: { show: false },
  };
  return {
    width: Math.max(160, width),
    height: STRIP_HEIGHT,
    legend: { show: false },
    cursor: { sync: { key: SYNC_KEY }, points: { show: false } },
    scales: { x: { time: true } },
    axes: [{ ...axis, size: 24 }, axis],
    series: [
      {},
      { label: series.label, width: 1.5, points: { show: false }, ...(stroke ? { stroke } : {}) },
    ],
  };
}

/**
 * Altitude, vertical speed and ground speed over the last ~10 minutes, from frames
 * received by this browser. uPlot is loaded lazily inside an effect (never during
 * SSR); line colours come from the design tokens on :root.
 */
export function TelemetryStrip({ points }: { points: readonly TelemetryPoint[] }) {
  const hasData = points.length >= 2;
  const containers = useRef<Array<HTMLDivElement | null>>([]);
  const charts = useRef<uPlot[]>([]);
  const pointsRef = useRef(points);
  pointsRef.current = points;
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!hasData) return;
    let cancelled = false;
    let observer: ResizeObserver | null = null;
    Promise.all([import("uplot"), import("uplot/dist/uPlot.min.css")])
      .then(([mod]) => {
        if (cancelled) return;
        const UPlot = mod.default;
        charts.current = STRIP_SERIES.flatMap((series, i) => {
          const el = containers.current[i];
          if (!el) return [];
          return [
            new UPlot(
              stripOptions(series, el.clientWidth),
              seriesData(pointsRef.current, series.key),
              el,
            ),
          ];
        });
        if (typeof ResizeObserver !== "undefined") {
          observer = new ResizeObserver(() => {
            for (const [i, chart] of charts.current.entries()) {
              const el = containers.current[i];
              if (el) chart.setSize({ width: Math.max(160, el.clientWidth), height: STRIP_HEIGHT });
            }
          });
          for (const el of containers.current) if (el) observer.observe(el);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      observer?.disconnect();
      for (const chart of charts.current) chart.destroy();
      charts.current = [];
    };
  }, [hasData]);

  useEffect(() => {
    for (const [i, chart] of charts.current.entries()) {
      const series = STRIP_SERIES[i];
      if (series) chart.setData(seriesData(points, series.key));
    }
  }, [points]);

  if (!hasData) {
    return (
      <EmptyState
        icon={Activity}
        title="Collecting telemetry"
        description="Altitude, vertical speed and ground speed appear here as frames arrive."
      />
    );
  }

  const latest = points.at(-1);
  return (
    <div className="flex flex-col gap-3" data-testid="telemetry-strip">
      {STRIP_SERIES.map((series, i) => (
        <div key={series.key} className="panel-inset px-3 pb-1 pt-2" data-series={series.key}>
          <div className="flex items-baseline justify-between gap-2">
            <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground">
              {series.label}
            </p>
            <p className="font-mono text-sm font-semibold text-foreground font-tabular">
              {latest ? formatInt(latest[series.key]) : "—"}
              <span className="ml-1 text-xs font-medium text-muted-foreground">{series.unit}</span>
            </p>
          </div>
          <div
            ref={(el) => {
              containers.current[i] = el;
            }}
            className="min-h-[84px] w-full"
            aria-hidden="true"
          />
        </div>
      ))}
      {failed ? (
        <p className="text-xs text-muted-foreground">The chart could not be loaded.</p>
      ) : null}
    </div>
  );
}
