import { Link } from "@tanstack/react-router";
import { formatCeiling, formatVisibility, formatWind } from "@cargo-ops/weather";

import { FlightCategoryChip } from "@/components/weather/FlightCategoryChip";
import { MetarOriginTag } from "@/components/weather/MetarStation";
import type { MetarState } from "@/lib/weather/use-metar";

import { ConsolePanel } from "./Console";

function footer(state: MetarState): string | null {
  if (state.status === "unavailable" || state.status === "error") return state.message;
  if (state.status !== "ready") return null;
  switch (state.data.mode) {
    case "sample":
      return "SAMPLE METARs built into Cargo Ops: not real weather, never for flight planning.";
    case "off":
      return "Weather is off in the connector.";
    default:
      return state.data.onlineAllowed
        ? `${state.data.attribution}. For simulation only.`
        : "Online weather is off for this browser (Settings → Weather).";
  }
}

/**
 * WX station: origin and destination METAR summaries from the shared useMetar result (the
 * page owns the request so the status board's WX lamp reads the same report).
 */
export function WeatherConsole({
  origin,
  destination,
  metar,
  className,
}: {
  origin: string | null;
  destination: string | null;
  metar: MetarState;
  className?: string;
}) {
  const rows: Array<{ role: string; station: string }> = [];
  if (origin) rows.push({ role: "ORIG", station: origin.toUpperCase() });
  if (destination && destination.toUpperCase() !== origin?.toUpperCase()) {
    rows.push({ role: "DEST", station: destination.toUpperCase() });
  }
  const data = metar.status === "ready" ? metar.data : null;
  const note = footer(metar);
  return (
    <ConsolePanel callsign="WX" title="Route weather" className={className} testId="console-wx">
      {rows.length === 0 ? (
        <p className="font-mono text-xs text-muted-foreground">
          Weather appears once there is an origin or destination.
        </p>
      ) : (
        <div className="flex flex-col gap-3" data-testid="ops-weather">
          <ul className="flex flex-col gap-2">
            {rows.map((r) => {
              const result = data?.stations.find((s) => s.station === r.station) ?? null;
              const report = result?.report ?? null;
              return (
                <li
                  key={r.station}
                  className="console-rule flex flex-col gap-1 border-b pb-2 last:border-b-0 last:pb-0"
                  data-testid="ops-metar"
                  data-station={r.station}
                  data-origin={report?.origin ?? "none"}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-sm text-console-foreground">
                      <span className="readout-label mr-2">{r.role}</span>
                      {r.station}
                    </span>
                    <span className="flex items-center gap-1.5">
                      {report ? (
                        <MetarOriginTag origin={report.origin} stale={report.stale} />
                      ) : null}
                      <FlightCategoryChip category={report?.category ?? null} />
                    </span>
                  </div>
                  <p className="truncate font-mono text-xs text-muted-foreground tabular-nums">
                    {report
                      ? `${formatWind(report.wind)} · ${formatVisibility(report.visibilitySm, report.visibilityPlus)} · CIG ${formatCeiling(report.ceilingFt, report.clouds !== null)}`
                      : (result?.note ??
                        (metar.status === "loading" || metar.status === "idle"
                          ? "Loading weather…"
                          : "No report."))}
                  </p>
                </li>
              );
            })}
          </ul>
          {note ? (
            <p className="text-[0.6875rem] text-muted-foreground" data-testid="ops-weather-status">
              {note}{" "}
              <Link to="/flight" className="text-phosphor-cyan hover:text-console-foreground">
                Full METARs
              </Link>
            </p>
          ) : null}
        </div>
      )}
    </ConsolePanel>
  );
}
