import { Clock, Package, Ruler, Weight } from "lucide-react";
import type { ReactNode } from "react";

import type { AircraftType, CargoKind, Job, Source } from "@cargo-ops/protocol";
import { KIND_LABELS, type AirportLookup } from "@cargo-ops/economy";
import { SourceTag } from "@/components/status/SourceTag";
import { jobSuitability, type SuitabilityBadge } from "@/lib/economy/board";
import { formatInt, formatMinutes, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const kindTone: Record<CargoKind, string> = {
  cargo: "border-border bg-secondary text-secondary-foreground",
  fragile: "border-tertiary/40 bg-tertiary/15 text-foreground",
  express: "border-primary/40 bg-primary/15 text-primary",
  medical: "border-success/40 bg-success/15 text-success",
  hazmat: "border-warning/40 bg-warning/15 text-warning",
  bush: "border-accent/40 bg-accent/10 text-accent",
};

export function KindBadge({ kind, className }: { kind: CargoKind; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md border px-2 py-0.5 font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.12em]",
        kindTone[kind],
        className,
      )}
      data-kind={kind}
    >
      {KIND_LABELS[kind]}
    </span>
  );
}

function Badge({ badge }: { badge: SuitabilityBadge }) {
  const tone =
    badge.ok === null
      ? "text-muted-foreground border-border"
      : badge.ok
        ? "text-success border-success/30"
        : "text-destructive border-destructive/40";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border bg-background/40 px-2 py-0.5 text-[0.6875rem]",
        tone,
      )}
      title={badge.detail}
      data-suitability={badge.key}
      data-ok={badge.ok === null ? "unknown" : String(badge.ok)}
    >
      <span className="status-dot size-1.5" aria-hidden="true" />
      {badge.label}
    </span>
  );
}

export type MissionCardProps = {
  job: Job;
  type: AircraftType;
  lookup: AirportLookup | null;
  source: Source | null;
  action?: ReactNode;
  selected?: boolean;
  className?: string;
};

/** One contract: route, kind, weight, payout, time limit and suitability for the type. */
export function MissionCard({
  job,
  type,
  lookup,
  source,
  action,
  selected,
  className,
}: MissionCardProps) {
  const badges = jobSuitability(job, type, lookup);
  return (
    <li
      className={cn(
        "panel-elevated grid grid-cols-1 gap-4 p-5 transition-colors md:grid-cols-[1fr_auto] md:items-center md:p-6",
        selected && "border-primary/60",
        className,
      )}
      data-testid="job-card"
      data-job-id={job.id}
      data-destination={job.destination}
      data-status={job.status}
    >
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-mono text-xs text-muted-foreground">{job.id}</span>
          <KindBadge kind={job.kind} />
          <SourceTag source={source} />
        </div>
        <p className="mt-2 font-display text-3xl font-bold tracking-tight md:text-4xl">
          {job.origin} <span className="text-gradient">→</span> {job.destination}
        </p>
        {job.destinationName ? (
          <p className="mt-1 truncate text-xs text-muted-foreground">{job.destinationName}</p>
        ) : null}
        <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
          <span className="flex items-center gap-1.5 font-tabular">
            <Weight className="size-4 text-accent" aria-hidden="true" />
            {formatInt(job.weightKg)} kg
          </span>
          <span className="flex items-center gap-1.5 font-tabular">
            <Package className="size-4 text-accent" aria-hidden="true" />
            {job.units} unit{job.units === 1 ? "" : "s"}
          </span>
          <span className="flex items-center gap-1.5 font-tabular">
            <Ruler className="size-4 text-accent" aria-hidden="true" />
            {job.distanceNm} nm
          </span>
          <span
            className="flex items-center gap-1.5 font-tabular"
            title="Simulator time from block-out to delivery"
          >
            <Clock className="size-4 text-accent" aria-hidden="true" />
            {formatMinutes(job.timeLimitMin)} limit
          </span>
        </div>
        <div className="mt-3 flex flex-wrap gap-2" aria-label={`Suitability for the ${type.name}`}>
          {badges.map((b) => (
            <Badge key={b.key} badge={b} />
          ))}
        </div>
      </div>
      <div className="flex items-end justify-between gap-4 md:flex-col md:items-end">
        <div className="md:text-right">
          <p className="label-eyebrow">Est. payout</p>
          <p className="metric-md mt-1" data-testid="job-payout">
            {formatUsd(job.payoutEstimate)}
          </p>
        </div>
        {action}
      </div>
    </li>
  );
}
