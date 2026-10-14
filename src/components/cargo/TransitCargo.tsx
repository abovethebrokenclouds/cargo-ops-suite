import { Warehouse } from "lucide-react";
import { useState } from "react";

import type { Job, Source } from "@cargo-ops/protocol";
import { Panel } from "@/components/dashboard/Panel";
import { SourceTag } from "@/components/status/SourceTag";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { transitDeadlineText, transitView } from "@/lib/economy/format";
import { formatInt, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

import { KindBadge } from "./MissionCard";

/**
 * Cargo stored at an intermediate airport (docs/ECONOMY.md "Transit cargo"): where it is,
 * where it goes, how much of its chain deadline is left on the company clock, the payout
 * estimate with the late penalty accrued so far, and a box to load it on the onward leg (from
 * that airport). Abandoning asks for confirmation first.
 */
export function TransitCargo({
  jobs,
  nowGameMs,
  reputation,
  source,
  selected,
  onSelect,
  onAbandon,
  disabled,
  className,
}: {
  jobs: readonly Job[];
  nowGameMs: number | null;
  reputation: number | null;
  source: Source | null;
  selected: readonly string[];
  onSelect: (jobId: string, checked: boolean) => void;
  onAbandon?: (jobId: string) => void;
  disabled: boolean;
  className?: string;
}) {
  const [pending, setPending] = useState<Job | null>(null);
  if (jobs.length === 0) return null;
  return (
    <Panel
      {...(className ? { className } : {})}
      eyebrow="Transit cargo"
      title="Stored for the onward leg"
      icon={Warehouse}
      action={<SourceTag source={source} />}
    >
      <ul className="flex flex-col gap-2" data-testid="transit-jobs">
        {jobs.map((j) => {
          const v = transitView(j, nowGameMs, reputation);
          if (!v) return null;
          return (
            <li
              key={j.id}
              className="panel-inset flex items-start gap-3 px-3 py-2.5"
              data-testid="transit-job"
              data-job-id={j.id}
              data-location={v.location}
              data-late={v.late ? "" : undefined}
            >
              <input
                type="checkbox"
                aria-label={`Select ${j.id}`}
                className="mt-1 size-4 accent-primary"
                disabled={disabled}
                checked={selected.includes(j.id)}
                onChange={(e) => onSelect(j.id, e.target.checked)}
              />
              <div className="min-w-0 flex-1">
                <p className="font-mono text-sm text-foreground">
                  <span data-testid="transit-location">at {v.location}</span>{" "}
                  <span className="text-gradient">→</span> {v.destination}
                </p>
                <p className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <KindBadge kind={j.kind} className="px-1.5 py-0" />
                  <span className="font-tabular">{formatInt(j.weightKg)} kg</span>
                  <span
                    className="font-tabular"
                    data-testid="transit-payout"
                    title="Estimate: landing 1.00, current reputation, late penalty accrued so far"
                  >
                    {v.payoutEstimate === null
                      ? "est. payout unknown"
                      : `est. ${formatUsd(v.payoutEstimate)} on delivery`}
                  </span>
                </p>
                <p
                  className={cn(
                    "mt-1 text-xs font-tabular",
                    v.late ? "text-destructive" : "text-muted-foreground",
                  )}
                  data-testid="transit-deadline"
                >
                  {transitDeadlineText(v)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {v.storageLabel}
                  {v.freeHours > 0 ? ` · first ${v.freeHours} h stored free of the deadline` : ""}
                  {` · ${v.legs} leg${v.legs === 1 ? "" : "s"} flown`}
                </p>
              </div>
              {onAbandon ? (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-destructive disabled:opacity-50"
                  disabled={disabled}
                  title="Abandon this cargo here: no payout, −3 reputation"
                  data-testid="transit-abandon"
                  onClick={() => setPending(j)}
                >
                  Abandon
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-xs text-muted-foreground">
        Paid in full on the final delivery only. The time limit covers every leg and the ground time
        in between. Load it from the airport where it is stored.
      </p>
      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Abandon this cargo?</AlertDialogTitle>
            <AlertDialogDescription>
              <span className="font-mono">{pending?.id}</span> stays at{" "}
              {pending?.transit?.location ?? "its stop"} and is never delivered: no payout and −3
              reputation.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Keep it</AlertDialogCancel>
            <AlertDialogAction
              data-testid="transit-abandon-confirm"
              onClick={() => {
                if (pending && onAbandon) onAbandon(pending.id);
                setPending(null);
              }}
            >
              Abandon cargo
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Panel>
  );
}
