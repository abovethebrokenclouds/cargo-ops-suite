import { PlaneLanding } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { SourceTag } from "@/components/status/SourceTag";
import { EMPTY, formatFpm, formatInt, formatKnots } from "@/lib/format";
import type { TouchdownView } from "@/lib/flight/flight-view";
import { GRADE_LABELS } from "@/lib/flight/landing-grade";
import { cn } from "@/lib/utils";

function signedDeg(n: number | null): string {
  if (n === null) return EMPTY;
  const r = Math.round(n * 10) / 10;
  if (r === 0) return "0.0°";
  return `${r > 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}°`;
}

/** Touchdown summary from the latest `touchdown` event, with a provisional client-side grade. */
export function LandingCard({ touchdown }: { touchdown: TouchdownView | null }) {
  if (!touchdown) {
    return (
      <EmptyState
        icon={PlaneLanding}
        title="Awaiting touchdown"
        description="Rate, G, ground speed and grade are recorded the moment the wheels touch."
      />
    );
  }
  const { grade } = touchdown;
  const severe = grade === "E" || grade === "F";
  const items: Array<[string, string]> = [
    ["Rate", touchdown.rateFpm === null ? EMPTY : formatFpm(touchdown.rateFpm)],
    ["G load", touchdown.gForce === null ? EMPTY : `${touchdown.gForce.toFixed(2)} G`],
    ["Ground speed", formatKnots(touchdown.gsKt)],
  ];
  if (touchdown.bankDeg !== null) items.push(["Bank", signedDeg(touchdown.bankDeg)]);
  if (touchdown.pitchDeg !== null) items.push(["Pitch", signedDeg(touchdown.pitchDeg)]);

  return (
    <div className="flex flex-col gap-5" data-testid="landing-card">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="@container min-w-0">
          <div className="flex items-center gap-2">
            <p className="label-eyebrow">Landing grade</p>
            <SourceTag source={touchdown.source} />
          </div>
          <div className="mt-2 flex items-baseline gap-3">
            <span
              className={cn("metric-xl metric-glow", severe && "metric-critical")}
              data-empty={grade ? undefined : ""}
              data-testid="landing-grade"
            >
              {grade ?? EMPTY}
            </span>
            {grade ? (
              <span className="font-display text-xl font-semibold text-foreground">
                {GRADE_LABELS[grade]}
              </span>
            ) : null}
          </div>
        </div>
        <div className="text-right">
          <p className="label-eyebrow">Sink rate</p>
          <p className="mt-2 flex items-baseline justify-end gap-1.5">
            <span className="metric-md" data-empty={touchdown.rateFpm === null ? "" : undefined}>
              {touchdown.rateFpm === null ? EMPTY : formatInt(Math.abs(touchdown.rateFpm))}
            </span>
            <span className="font-mono text-sm font-medium uppercase text-muted-foreground">
              fpm
            </span>
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {items.map(([label, value]) => (
          <div key={label} className="panel-inset px-3 py-2.5">
            <dt className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground">
              {label}
            </dt>
            <dd className="mt-1 font-mono text-sm font-semibold text-foreground font-tabular">
              {value}
            </dd>
          </div>
        ))}
      </dl>

      <p className="text-xs text-muted-foreground">
        <span className="font-semibold text-warning">
          Provisional — connector analyser arrives in P2.
        </span>{" "}
        Graded in the browser as the worse of the rate and G grades (plan §6.3 bands).
      </p>
    </div>
  );
}
