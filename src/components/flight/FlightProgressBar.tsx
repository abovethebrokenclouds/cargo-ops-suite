import { Plane } from "lucide-react";

import { EMPTY } from "@/lib/format";

export type FlightProgressBarProps = {
  origin: string | null;
  destination: string | null;
  /** 0–1, or null when there is no active flight. */
  progress: number | null;
  ete?: string | null;
};

/** Origin → destination rail with an aircraft marker. Null progress shows an idle rail. */
export function FlightProgressBar({
  origin,
  destination,
  progress,
  ete = null,
}: FlightProgressBarProps) {
  const pct = progress === null ? null : Math.min(1, Math.max(0, progress)) * 100;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-end justify-between gap-4">
        <div>
          <p className="label-eyebrow">Origin</p>
          <p className="metric-md mt-1" data-empty={origin ? undefined : ""}>
            {origin ?? EMPTY}
          </p>
        </div>
        <div className="text-center">
          <p className="label-eyebrow">ETE</p>
          <p className="mt-1 font-mono text-sm text-foreground font-tabular">{ete ?? EMPTY}</p>
        </div>
        <div className="text-right">
          <p className="label-eyebrow">Destination</p>
          <p className="metric-md mt-1" data-empty={destination ? undefined : ""}>
            {destination ?? EMPTY}
          </p>
        </div>
      </div>
      <div
        className="panel-inset relative h-3 rounded-full"
        role="progressbar"
        aria-label="Route progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct === null ? undefined : Math.round(pct)}
        aria-valuetext={pct === null ? "No active flight" : `${Math.round(pct)}%`}
      >
        {pct === null ? (
          <div className="absolute inset-x-3 top-1/2 border-t border-dashed border-muted-foreground/30" />
        ) : (
          <>
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-gradient-brand shadow-glow"
              style={{ width: `${pct}%` }}
            />
            <Plane
              aria-hidden="true"
              className="absolute top-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rotate-45 text-foreground"
              style={{ left: `${pct}%` }}
            />
          </>
        )}
      </div>
    </div>
  );
}
