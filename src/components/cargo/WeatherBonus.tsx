import { CloudFog } from "lucide-react";

import { WEATHER_BONUS } from "@cargo-ops/economy";
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

const stageWord = (c: WeatherCheck) => (c.stage === "departure" ? "departure" : "arrival");

/** The ends the payout counted: the transit chain's on a final leg, else the mission's own. */
function countedEnds(weather: MissionWeather): {
  departure?: WeatherCheck | undefined;
  arrival?: WeatherCheck | undefined;
} {
  return weather.chain ?? { departure: weather.departure, arrival: weather.arrival };
}

/** The counted end that set the bonus, as recorded by the connector (null = none/older save). */
function bonusEnd(weather: MissionWeather): WeatherCheck | null {
  if (!weather.bonusFrom) return null;
  return countedEnds(weather)[weather.bonusFrom] ?? null;
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
  const from = bonusEnd(weather);
  return (
    <span
      className={cn("inline-flex items-center gap-1.5 font-mono text-xs", className)}
      data-testid="weather-bonus-pill"
      data-bonus={bonus}
      title={
        from
          ? from.message
          : [weather.departure?.message, weather.arrival?.message].filter(Boolean).join(" · ")
      }
    >
      <span className="text-foreground">
        {cat(weather.departure)} → {cat(weather.arrival)}
      </span>
      {bonus > 0 ? (
        <span className="rounded-sm border border-success/40 bg-success/10 px-1.5 py-0.5 text-[0.625rem] font-semibold text-success">
          {pct(bonus)}
          {from ? ` ${from.station}` : null}
        </span>
      ) : null}
    </span>
  );
}

/**
 * The explanation under the weather line, driven by what the connector recorded at the
 * delivery (outcome, the end that set the bonus, the chain's ends). Older saves without an
 * outcome only get statements their fields support.
 */
function resultText(weather: MissionWeather): string {
  const { bonus, outcome, chain } = weather;
  const from = bonusEnd(weather);
  const fromText = from
    ? `${from.category ?? "unknown"} at ${from.station} ${stageWord(from)} (live METAR)`
    : null;
  const fromChain =
    chain && from && weather.bonusFrom === "departure"
      ? `, first leg of this ${chain.legs}-leg transit chain`
      : "";
  const earned = from?.category ? WEATHER_BONUS[from.category] : 0;
  const counted = countedEnds(weather);
  const stop =
    chain && weather.departure && weather.departure.station !== chain.departure?.station
      ? ` ${weather.departure.station} is a transit stop and never counts.`
      : "";
  switch (outcome) {
    case "applied":
      return `Weather bonus ${pct(bonus ?? 0)} on the conditions line: ${fromText ?? "live METAR, IFR/LIFR"}${fromChain}.`;
    case "withheld_rate":
      return `Weather bonus withheld: ${fromText ?? "an IFR/LIFR end"}${fromChain} earned ${pct(earned)}, but the sim rate was above 1× on ${chain ? "a leg of the chain" : "this flight"}.`;
    case "withheld_payload":
      return `Weather bonus withheld: ${fromText ?? "an IFR/LIFR end"}${fromChain} earned ${pct(earned)}, but a departure payload check found too little payload${chain ? " on a leg of the chain" : ""}.`;
    case "no_ifr": {
      const ends = [counted.departure, counted.arrival]
        .filter((c): c is WeatherCheck => c !== undefined)
        .map((c) => `${c.station} ${stageWord(c)} ${c.category ?? "unknown"}`)
        .join(", ");
      return `No weather bonus: the ${chain ? "chain's ends" : "ends"} counted (${ends}) were not IFR/LIFR.${stop}`;
    }
    case "not_live":
      return `No weather bonus: only live, current IFR/LIFR METARs under sim telemetry count; sample, replay/demo or unknown weather never does.${stop}`;
    case "in_transit":
      return "Weather bonus is decided at the cargo's final delivery: the chain counts its first departure and final arrival, never a stop.";
    default:
      // Older saves: no outcome recorded, so no reason is claimed.
      return bonus === undefined
        ? "Weather bonus is decided at a delivered arrival."
        : bonus > 0
          ? `Weather bonus ${pct(bonus)} on the conditions line (live METAR, IFR/LIFR).`
          : "No weather bonus was paid on this delivery.";
  }
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
  const chain = weather.chain;
  return (
    <div
      className={cn("mt-2 flex flex-col gap-1 text-xs", className)}
      data-testid="weather-bonus"
      data-bonus={weather.bonus ?? ""}
      data-outcome={weather.outcome ?? ""}
    >
      <p className="flex flex-wrap items-center gap-2">
        <CloudFog className="size-3.5 text-muted-foreground" aria-hidden="true" />
        <span className="label-eyebrow">Weather · frozen at departure and arrival</span>
      </p>
      <p className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <End check={weather.departure} label="Dep" />
        <End check={weather.arrival} label="Arr" />
      </p>
      {chain ? (
        <p
          className="flex flex-wrap items-center gap-x-4 gap-y-1"
          data-testid="weather-bonus-chain"
        >
          <span className="text-muted-foreground">Counted · transit chain, {chain.legs} legs</span>
          <End check={chain.departure} label="First dep" />
          <End check={chain.arrival} label="Final arr" />
        </p>
      ) : null}
      <p className="text-muted-foreground" data-testid="weather-bonus-result">
        {resultText(weather)}
      </p>
    </div>
  );
}
