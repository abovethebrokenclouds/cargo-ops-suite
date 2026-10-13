import type { PayloadState } from "@cargo-ops/protocol";

import { EMPTY, formatInt } from "@/lib/format";
import type { WeightsView } from "@/lib/flight/flight-view";
import { cn } from "@/lib/utils";

export type PayloadBarProps = {
  weights: WeightsView | null;
  stations?: PayloadState["stations"] | null;
};

function lb(n: number | null | undefined) {
  return n === null || n === undefined ? EMPTY : `${formatInt(n)} lb`;
}

/**
 * Stacked weight bar: empty weight, payload and fuel (plus anything else) against max
 * gross weight. No CG. Null weights render an idle rail with em dashes.
 */
export function PayloadBar({ weights, stations }: PayloadBarProps) {
  const scale = weights ? Math.max(weights.maxGrossLb, weights.totalLb, 1) : 1;
  const pct = (n: number) => `${(n / scale) * 100}%`;
  const loadPct =
    weights && weights.maxGrossLb > 0
      ? Math.round((weights.totalLb / weights.maxGrossLb) * 100)
      : null;

  return (
    <div className="flex flex-col gap-5" data-testid="payload-bar">
      <div className="@container grid grid-cols-2 gap-4 sm:grid-cols-4">
        <div className="min-w-0">
          <p className="label-eyebrow">Payload</p>
          <p className="mt-2 flex items-baseline gap-1.5">
            <span
              className="metric-md metric-live"
              data-empty={weights ? undefined : ""}
              data-testid="payload-lb"
            >
              {weights ? formatInt(weights.payloadLb) : EMPTY}
            </span>
            {weights ? (
              <span className="font-mono text-sm font-medium uppercase text-muted-foreground">
                lb
              </span>
            ) : null}
          </p>
        </div>
        <Stat label="Total" value={lb(weights?.totalLb)} />
        <Stat label="Max gross" value={lb(weights?.maxGrossLb)} />
        <Stat
          label={weights?.overweight ? "Over max" : "Margin"}
          value={weights ? lb(Math.abs(weights.marginLb)) : EMPTY}
          tone={weights?.overweight ? "critical" : "default"}
        />
      </div>

      <div
        className="panel-inset relative h-4 overflow-hidden rounded-full"
        role="meter"
        aria-label="Gross weight versus maximum"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={loadPct ?? undefined}
        aria-valuetext={loadPct === null ? "No weight data" : `${loadPct}% of max gross`}
      >
        {weights ? (
          <>
            <div className="absolute inset-y-0 left-0 flex w-full">
              <span
                className="h-full bg-muted-foreground/35 transition-[width] duration-700 ease-out"
                style={{ width: pct(weights.emptyLb) }}
                title={`Empty ${lb(weights.emptyLb)}`}
              />
              <span
                className="h-full bg-gradient-brand shadow-glow transition-[width] duration-700 ease-out"
                style={{ width: pct(weights.payloadLb) }}
                title={`Payload ${lb(weights.payloadLb)}`}
              />
              <span
                className="h-full bg-accent/45 transition-[width] duration-700 ease-out"
                style={{ width: pct(weights.fuelAndOtherLb) }}
                title={`Fuel and other ${lb(weights.fuelAndOtherLb)}`}
              />
            </div>
            <span
              aria-hidden="true"
              className={cn(
                "absolute inset-y-0 w-0.5",
                weights.overweight ? "bg-destructive" : "bg-foreground/80",
              )}
              style={{ left: `calc(${pct(weights.maxGrossLb)} - 1px)` }}
            />
          </>
        ) : (
          <div className="absolute inset-x-3 top-1/2 border-t border-dashed border-muted-foreground/30" />
        )}
      </div>

      <ul className="flex flex-wrap gap-x-5 gap-y-2 font-mono text-[0.6875rem] text-muted-foreground">
        <Legend swatch="bg-muted-foreground/35" label="Empty" value={lb(weights?.emptyLb)} />
        <Legend swatch="bg-gradient-brand" label="Payload" value={lb(weights?.payloadLb)} />
        <Legend swatch="bg-accent/45" label="Fuel + other" value={lb(weights?.fuelAndOtherLb)} />
        <Legend
          swatch={weights?.overweight ? "bg-destructive" : "bg-foreground/80"}
          label="Max gross"
          value={loadPct === null ? EMPTY : `${loadPct}% used`}
        />
      </ul>

      {stations && stations.length > 0 ? (
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2" aria-label="Payload stations">
          {stations.map((s, i) => (
            <li
              key={`${s.name}-${i}`}
              className="panel-inset flex items-center justify-between gap-3 px-3 py-2"
            >
              <span className="truncate text-xs text-muted-foreground">{s.name}</span>
              <span className="font-mono text-xs font-semibold text-foreground font-tabular">
                {lb(s.weightLb)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "critical";
}) {
  return (
    <div className="min-w-0">
      <p className="label-eyebrow">{label}</p>
      <p
        className={cn(
          "mt-2 truncate font-mono text-base font-semibold font-tabular md:text-lg",
          tone === "critical" ? "text-destructive" : "text-foreground",
        )}
      >
        {value}
      </p>
    </div>
  );
}

function Legend({ swatch, label, value }: { swatch: string; label: string; value: string }) {
  return (
    <li className="flex items-center gap-2">
      <span aria-hidden="true" className={cn("h-2 w-3 rounded-sm", swatch)} />
      <span className="uppercase tracking-[0.14em]">{label}</span>
      <span className="text-foreground font-tabular">{value}</span>
    </li>
  );
}
