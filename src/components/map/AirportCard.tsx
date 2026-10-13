import type { Airport } from "@/lib/map/airports";
import { formatFeet } from "@/lib/format";

/** Popup content for an airport on the map (OurAirports data). */
export function AirportCard({ airport }: { airport: Airport }) {
  const place = [airport.municipality, airport.region].filter(Boolean).join(" · ");
  return (
    <div className="flex min-w-[13rem] flex-col gap-2" data-testid="airport-card">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-base font-semibold tracking-[0.12em] text-accent">
          {airport.ident}
        </span>
        <span className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-muted-foreground">
          {airport.iata ? `${airport.iata} · ` : ""}
          {airport.type}
        </span>
      </div>
      <p className="font-display text-sm font-semibold leading-tight text-foreground">
        {airport.name}
      </p>
      {place ? <p className="text-xs text-muted-foreground">{place}</p> : null}
      <dl className="grid grid-cols-2 gap-2 border-t border-border pt-2 font-mono text-xs">
        <div>
          <dt className="label-eyebrow text-[0.5625rem]">Elevation</dt>
          <dd className="font-tabular text-foreground">{formatFeet(airport.elevFt)}</dd>
        </div>
        <div>
          <dt className="label-eyebrow text-[0.5625rem]">Longest rwy</dt>
          <dd className="font-tabular text-foreground">
            {formatFeet(airport.longestRwyFt)}
            {airport.surface ? (
              <span className="ml-1 text-muted-foreground">{airport.surface}</span>
            ) : null}
          </dd>
        </div>
      </dl>
    </div>
  );
}
