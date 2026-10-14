import { Link } from "@tanstack/react-router";
import { ArrowRight, PackageCheck, PackageX, Timer, Truck } from "lucide-react";

import type { Mission, Source } from "@cargo-ops/protocol";
import { KIND_LABELS } from "@cargo-ops/economy";
import { SourceTag } from "@/components/status/SourceTag";
import { PayloadCheckLine } from "./PayloadCheck";
import { missionTimeLeftMin } from "@/lib/economy/format";
import { formatInt, formatMinutes, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<Mission["status"], string> = {
  loaded: "Loaded · awaiting departure",
  in_progress: "In flight",
  delivered: "Delivered",
  failed: "Failed",
  aborted: "Aborted",
};

/** Active mission summary for / and /flight: route, cargo, deadline, expected payout. */
export function MissionStrip({
  mission,
  source,
  className,
}: {
  mission: Mission | null;
  source: Source | null;
  className?: string;
}) {
  if (!mission) return null;
  const left = missionTimeLeftMin(mission);
  const kinds = [...new Set(mission.jobs.map((j) => KIND_LABELS[j.kind]))].join(", ");
  const done = mission.status === "delivered";
  const bad = mission.status === "failed" || mission.status === "aborted";
  const Icon = done ? PackageCheck : bad ? PackageX : Truck;
  return (
    <section
      className={cn(
        "panel-instrument flex flex-col gap-4 p-5 md:flex-row md:items-center md:justify-between md:p-6",
        className,
      )}
      data-testid="mission-strip"
      data-status={mission.status}
      aria-label="Active mission"
    >
      <div className="flex min-w-0 items-center gap-4">
        <span
          className={cn(
            "grid size-11 shrink-0 place-items-center rounded-xl border",
            done
              ? "border-success/40 bg-success/10 text-success"
              : bad
                ? "border-destructive/40 bg-destructive/10 text-destructive"
                : "border-primary/40 bg-primary/10 text-accent",
          )}
        >
          <Icon className="size-5" aria-hidden="true" />
        </span>
        <div className="min-w-0">
          <p className="label-eyebrow flex items-center gap-2">
            Mission {mission.id} · {STATUS_LABEL[mission.status]} <SourceTag source={source} />
          </p>
          <p className="mt-1 font-display text-2xl font-bold tracking-tight md:text-3xl">
            {mission.origin} <span className="text-gradient">→</span> {mission.destination}
          </p>
          <p className="mt-1 truncate text-sm text-muted-foreground">
            {mission.jobs.length} job{mission.jobs.length === 1 ? "" : "s"} · {kinds} ·{" "}
            <span className="font-tabular">{formatInt(mission.payloadKg)} kg</span> ·{" "}
            {mission.distanceNm} nm
          </p>
          {mission.transitJobIds?.length ? (
            <p className="mt-1 text-xs text-accent" data-testid="mission-strip-transit">
              Transit leg: {mission.transitJobIds.length} job
              {mission.transitJobIds.length === 1 ? " goes" : "s go"} beyond {mission.destination}
              {" · stored there, paid on final delivery"}
            </p>
          ) : null}
          {mission.startBlocked && mission.status === "loaded" ? (
            <p className="mt-1 text-xs text-warning" data-testid="mission-start-blocked">
              Not started: {mission.startBlocked.message}
            </p>
          ) : null}
          {mission.failure ? (
            <p className="mt-1 text-xs text-destructive">{mission.failure.message}</p>
          ) : null}
          <PayloadCheckLine check={mission.payloadCheck} />
        </div>
      </div>
      <div className="flex flex-wrap items-end gap-6">
        <div>
          <p className="label-eyebrow flex items-center gap-1.5">
            <Timer className="size-3" aria-hidden="true" /> Deadline
          </p>
          <p
            className={cn(
              "mt-1 font-mono text-lg font-tabular",
              left !== null && left < 0 ? "text-destructive" : "text-foreground",
            )}
            data-testid="mission-deadline"
          >
            {left === null
              ? `${formatMinutes(mission.timeLimitMin)} from block-out`
              : left >= 0
                ? `${formatMinutes(left)} left`
                : `${formatMinutes(-left)} late`}
          </p>
        </div>
        <div className="text-right">
          <p className="label-eyebrow">{done ? "Paid" : "Expected payout"}</p>
          <p className="metric-md mt-1" data-testid="mission-payout">
            {formatUsd(done ? (mission.payout?.total ?? 0) : bad ? 0 : mission.expectedPayout)}
          </p>
        </div>
        <Link
          to="/jobs"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-accent hover:text-foreground"
        >
          Jobs <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </div>
    </section>
  );
}
