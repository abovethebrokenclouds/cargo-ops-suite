import { Clock, Gauge, Landmark, MapPin, Repeat, Wrench } from "lucide-react";
import type { ReactNode } from "react";

import type { FleetAircraft, Source } from "@cargo-ops/protocol";
import { aircraftTypeByKey } from "@cargo-ops/protocol";
import { MIN_DISPATCH_CONDITION, formatGameTime } from "@cargo-ops/economy";
import { SourceTag } from "@/components/status/SourceTag";
import { OWNERSHIP_LABELS } from "@/lib/economy/company";
import { formatInt, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

import { AirworthinessBadge } from "./Airworthiness";
import { TypeSilhouette } from "./TypeSilhouette";

/** Condition 0–100 % as an illuminated bar; red under the 20 % dispatch limit. */
export function ConditionGauge({ value, className }: { value: number; className?: string }) {
  const tone =
    value < MIN_DISPATCH_CONDITION
      ? "text-destructive"
      : value < 60
        ? "text-warning"
        : "text-success";
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <div className="flex items-baseline justify-between">
        <span className="label-eyebrow">Condition</span>
        <span
          className={cn("font-mono text-sm font-semibold font-tabular", tone)}
          data-testid="aircraft-condition"
        >
          {value.toFixed(1)} %
        </span>
      </div>
      <div
        className="relative h-2 overflow-hidden rounded-full bg-secondary"
        role="meter"
        aria-label="Condition"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(value)}
      >
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full bg-current shadow-glow", tone)}
          style={{ width: `${Math.max(0, Math.min(100, value))}%` }}
        />
        <span
          className="absolute inset-y-0 w-px bg-destructive/70"
          style={{ left: `${MIN_DISPATCH_CONDITION}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

const statusTone = {
  available: "text-success",
  in_flight: "text-accent",
  maintenance: "text-warning",
  sold: "text-muted-foreground",
  returned: "text-muted-foreground",
  repossessed: "text-destructive",
  written_off: "text-destructive",
} as const;

const statusLabel = {
  available: "Ready",
  in_flight: "Flying",
  maintenance: "Maintenance",
  sold: "Sold",
  returned: "Returned",
  repossessed: "Repossessed",
  written_off: "Written off",
} as const;

export function FleetCard({
  aircraft: a,
  source,
  selected,
  actions,
  focused = false,
}: {
  aircraft: FleetAircraft;
  source: Source | null;
  selected: boolean;
  actions?: ReactNode;
  /** Shown in the systems panel below. */
  focused?: boolean;
}) {
  const type = aircraftTypeByKey(a.typeKey);
  const grounded = !a.airworthy;
  const gate = a.airworthiness?.status;
  const gateLabel =
    gate === "ferry_only" ? "Ferry only" : gate === "annual_due" ? "Annual due" : "Grounded";
  return (
    <article
      className={cn(
        "panel-elevated relative flex flex-col gap-5 p-5 md:p-6",
        selected && "ring-1 ring-primary/50",
        focused && "ring-2 ring-accent/60",
      )}
      data-testid="fleet-card"
      data-aircraft-id={a.id}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="metric-md" data-testid="aircraft-registration">
            {a.registration}
          </p>
          <p className="mt-2 truncate text-sm text-foreground">{a.typeName}</p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          {a.ownership !== "owned" ? (
            <span
              className="rounded-sm bg-tertiary/20 px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-foreground"
              data-testid="lease-badge"
            >
              {OWNERSHIP_LABELS[a.ownership]}
            </span>
          ) : null}
          {a.financed ? (
            <span
              className="inline-flex items-center gap-1 rounded-sm bg-primary/15 px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-primary"
              data-testid="financed-badge"
            >
              <Landmark className="size-3" aria-hidden="true" /> Financed
            </span>
          ) : null}
          {gate ? <AirworthinessBadge status={gate} /> : null}
          {selected ? (
            <span className="rounded-sm bg-accent/15 px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-accent">
              Active
            </span>
          ) : null}
          <SourceTag source={source} />
        </div>
      </div>

      <div className="panel-inset relative grid h-28 place-items-center overflow-hidden">
        <span
          aria-hidden="true"
          className="aircraft-marker-halo absolute left-1/2 top-1/2 size-24 -translate-x-1/2 -translate-y-1/2 rounded-full"
        />
        <TypeSilhouette
          category={type?.category ?? "single-turboprop"}
          className={cn(
            "aircraft-marker-glyph relative size-20 rotate-45",
            grounded ? "text-destructive" : "text-accent",
          )}
        />
      </div>

      <ConditionGauge value={a.condition} />

      <dl className="grid grid-cols-2 gap-3 text-sm">
        <div>
          <dt className="label-eyebrow">Location</dt>
          <dd
            className="mt-1 flex items-center gap-1.5 font-mono text-foreground"
            data-testid="aircraft-location"
          >
            <MapPin className="size-3.5 text-accent" aria-hidden="true" />
            {a.location}
          </dd>
        </div>
        <div>
          <dt className="label-eyebrow">Status</dt>
          <dd className={cn("mt-1 flex items-center gap-2", statusTone[a.status])}>
            <span className="status-dot" aria-hidden="true" />
            {grounded && a.status === "available" ? gateLabel : statusLabel[a.status]}
          </dd>
        </div>
        <div>
          <dt className="label-eyebrow">Hours</dt>
          <dd className="mt-1 flex items-center gap-1.5 font-mono text-foreground font-tabular">
            <Clock className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {a.hours.toFixed(1)} h
          </dd>
        </div>
        <div>
          <dt className="label-eyebrow">Cycles</dt>
          <dd className="mt-1 flex items-center gap-1.5 font-mono text-foreground font-tabular">
            <Repeat className="size-3.5 text-muted-foreground" aria-hidden="true" />
            {formatInt(a.cycles)}
          </dd>
        </div>
        <div>
          <dt className="label-eyebrow">{a.ownership === "owned" ? "Value" : "Lease"}</dt>
          <dd className="mt-1 font-mono text-foreground font-tabular">
            {a.ownership === "owned"
              ? formatUsd(a.value)
              : type
                ? a.ownership === "dry_lease"
                  ? `${formatUsd(type.dryLeaseUsdPerEngineHour)}/eng-h`
                  : `${formatUsd(type.wetLeaseUsdPerBlockHour)}/h`
                : "—"}
          </dd>
        </div>
        <div>
          <dt className="label-eyebrow">Repair</dt>
          <dd className="mt-1 flex items-center gap-1.5 font-mono text-foreground font-tabular">
            {a.status === "maintenance" && a.readyAtGameMs !== undefined ? (
              <span className="text-warning">until {formatGameTime(a.readyAtGameMs)}</span>
            ) : a.repairCost > 0 ? (
              <>
                <Wrench className="size-3.5 text-muted-foreground" aria-hidden="true" />
                {formatUsd(a.repairCost)} · {a.repairHours.toFixed(1)} h
              </>
            ) : (
              <>
                <Gauge className="size-3.5 text-success" aria-hidden="true" /> none
              </>
            )}
          </dd>
        </div>
      </dl>
      {actions ? (
        <div className="flex flex-wrap gap-2 border-t border-border pt-4">{actions}</div>
      ) : null}
    </article>
  );
}
