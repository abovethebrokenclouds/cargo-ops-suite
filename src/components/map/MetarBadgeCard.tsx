import { formatObservationAge, isObservationOld } from "@cargo-ops/weather";

import { FlightCategoryChip } from "@/components/weather/FlightCategoryChip";
import { MetarOriginTag } from "@/components/weather/MetarStation";
import type { MetarBadge } from "@/lib/map/metar-badges";
import { cn } from "@/lib/utils";

/** Map tooltip for a METAR badge: station, category, SAMPLE/LIVE, age and the raw report. */
export function MetarBadgeCard({ badge, now }: { badge: MetarBadge; now: number | null }) {
  const age = now !== null ? formatObservationAge(badge.observedAt, now) : null;
  const old = now !== null && isObservationOld(badge.observedAt, now);
  return (
    <div
      className="flex w-64 max-w-full flex-col gap-2"
      data-testid="metar-popup"
      data-station={badge.station}
      data-origin={badge.origin}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-display text-base font-bold tracking-tight">{badge.station}</span>
        <FlightCategoryChip category={badge.category} />
        <MetarOriginTag origin={badge.origin} stale={badge.stale} />
      </div>
      <p className="label-eyebrow">{badge.roles.join(" · ")}</p>
      <pre className="whitespace-pre-wrap break-words rounded-md bg-background/60 px-2 py-1.5 font-mono text-[0.6875rem] leading-snug text-foreground">
        {badge.rawText}
      </pre>
      <p
        className={cn("text-xs", old ? "text-warning" : "text-muted-foreground")}
        data-testid="metar-popup-age"
      >
        {age ? `Observed ${age}` : "Observation time unknown"}
        {badge.origin === "sample" ? " · sample, not real weather" : ""}
      </p>
    </div>
  );
}
