import { CloudSun } from "lucide-react";

import { Panel } from "@/components/dashboard/Panel";
import { useNow } from "@/lib/sim-state/hooks";
import { cn } from "@/lib/utils";
import { useMetar, type MetarState } from "@/lib/weather/use-metar";

import { MetarStation } from "./MetarStation";

function Footer({ state }: { state: MetarState }) {
  if (state.status === "unavailable" || state.status === "error") {
    return <span data-testid="weather-status">{state.message}</span>;
  }
  if (state.status !== "ready") return null;
  const { mode, onlineAllowed, attribution } = state.data;
  if (mode === "sample") {
    return (
      <span data-testid="weather-status" data-weather-mode="sample">
        SAMPLE METARs built into Cargo Ops, for illustration only: not real weather. Never use them
        for flight planning.
      </span>
    );
  }
  if (mode === "off") {
    return (
      <span data-testid="weather-status" data-weather-mode="off">
        Weather is off in the connector (started with --weather off).
      </span>
    );
  }
  if (!onlineAllowed) {
    return (
      <span data-testid="weather-status" data-weather-mode="disabled">
        Online weather is off for this browser: turn it on in Settings → Weather.
      </span>
    );
  }
  return (
    <span data-testid="weather-status" data-weather-mode="online">
      {attribution}. For simulation only.
    </span>
  );
}

/** Origin and destination METARs (stations shown in the order given). */
export function RouteWeather({
  origin,
  destination,
  className,
}: {
  origin: string | null | undefined;
  destination: string | null | undefined;
  className?: string;
}) {
  const state = useMetar([origin, destination]);
  const now = useNow(30_000);
  const rows: Array<{ role: string; station: string }> = [];
  if (origin) rows.push({ role: "Origin", station: origin.toUpperCase() });
  if (destination && destination.toUpperCase() !== origin?.toUpperCase()) {
    rows.push({ role: "Destination", station: destination.toUpperCase() });
  }
  if (rows.length === 0) {
    return (
      <p className={cn("text-sm text-muted-foreground", className)} data-testid="route-weather">
        Weather appears once there is an origin or destination.
      </p>
    );
  }
  const data = state.status === "ready" ? state.data : null;
  return (
    <div className={cn("flex flex-col gap-3", className)} data-testid="route-weather">
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        {rows.map((r) => (
          <MetarStation
            key={r.station}
            role={r.role}
            now={now}
            result={
              data?.stations.find((s) => s.station === r.station) ?? {
                station: r.station,
                report: null,
                note:
                  state.status === "unavailable" || state.status === "error"
                    ? state.message
                    : "Loading weather…",
              }
            }
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        <Footer state={state} />
      </p>
    </div>
  );
}

/** RouteWeather in a panel (Live Flight, job board mission). */
export function RouteWeatherPanel({
  origin,
  destination,
  className,
  eyebrow = "Weather",
}: {
  origin: string | null | undefined;
  destination: string | null | undefined;
  className?: string;
  eyebrow?: string;
}) {
  return (
    <Panel {...(className ? { className } : {})} eyebrow={eyebrow} title="METAR" icon={CloudSun}>
      <RouteWeather origin={origin} destination={destination} />
    </Panel>
  );
}
