import { CloudFog } from "lucide-react";

import type { MissionWeather, WeatherCheck } from "@cargo-ops/protocol";
import { SourceTag } from "@/components/status/SourceTag";
import { FlightCategoryChip } from "@/components/weather/FlightCategoryChip";
import { MetarOriginTag } from "@/components/weather/MetarStation";
import { cn } from "@/lib/utils";

// METAR flight category frozen at departure (origin) and arrival (destination) and the
// weather bonus it earned (docs/ECONOMY.md "Weather bonus"). Only what the connector
// recorded is shown; a missing end shows "—", never a guess.

const pct = (n: number) => `+${Math.round(n * 100)} %`;

function End({ check, label }: { check: WeatherCheck | undefined; label: string }) {
  if (!check) {
    return (
      <span className="text-muted-foreground" data-weather-end={label}>
        {label} —
      </span>
    );
  }
  return (
    <span
      className="inline-flex flex-wrap items-center gap-1.5"
      data-weather-end={label}
      data-category={check.category ?? "unknown"}
      data-eligible={check.eligible ? "true" : "false"}
      title={check.message}
    >
      <span className="text-muted-foreground">
        {label} {check.station}
      </span>
      <FlightCategoryChip category={check.category} />
      {check.metarOrigin ? (
        <MetarOriginTag origin={check.metarOrigin} stale={check.stale ?? false} />
      ) : null}
      <SourceTag source={check.source} />
    </span>
  );
}

/** Compact cell for the logbook table: categories at both ends and the applied bonus. */
export function WeatherBonusPill({
  weather,
  className,
}: {
  weather: MissionWeather | null | undefined;
  className?: string;
}) {
  if (!weather || (!weather.departure && !weather.arrival)) {
    return <span className="text-muted-foreground">—</span>;
  }
  const cat = (c: WeatherCheck | undefined) => c?.category ?? "?";
  const bonus = weather.bonus ?? 0;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 font-mono text-xs", className)}
      data-testid="weather-bonus-pill"
      data-bonus={bonus}
      title={[weather.departure?.message, weather.arrival?.message].filter(Boolean).join(" · ")}
    >
      <span className="text-foreground">
        {cat(weather.departure)} → {cat(weather.arrival)}
      </span>
      {bonus > 0 ? (
        <span className="rounded-sm border border-success/40 bg-success/10 px-1.5 py-0.5 text-[0.625rem] font-semibold text-success">
          {pct(bonus)}
        </span>
      ) : null}
    </span>
  );
}

/** Full weather line (logbook flight detail). */
export function WeatherBonusLine({
  weather,
  className,
}: {
  weather: MissionWeather | null | undefined;
  className?: string;
}) {
  if (!weather || (!weather.departure && !weather.arrival)) return null;
  const bonus = weather.bonus;
  const earned = [weather.departure, weather.arrival].some(
    (c) => c?.eligible && (c.category === "IFR" || c.category === "LIFR"),
  );
  return (
    <div
      className={cn("mt-2 flex flex-col gap-1 text-xs", className)}
      data-testid="weather-bonus"
      data-bonus={bonus ?? ""}
    >
      <p className="flex flex-wrap items-center gap-2">
        <CloudFog className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="label-eyebrow">Weather · frozen at departure and arrival</span>
      </p>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <End check={weather.departure} label="Dep" />
        <End check={weather.arrival} label="Arr" />
      </p>
      <p className="text-muted-foreground" data-testid="weather-bonus-result">
        {bonus === undefined
          ? "Weather bonus is decided at a delivered arrival."
          : bonus > 0
            ? `Weather bonus ${pct(bonus)} on the conditions line (live METAR, IFR/LIFR).`
            : earned
              ? "Weather bonus withheld: this flight paid no bonuses (sim rate or payload)."
              : "No weather bonus: only live, current IFR/LIFR METARs count; sample or unknown weather never does."}
      </p>
    </div>
  );
}
