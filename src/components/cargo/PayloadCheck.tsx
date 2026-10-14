import { CircleHelp, Scale, TriangleAlert } from "lucide-react";

import type { PayloadCheck } from "@cargo-ops/protocol";
import { SourceTag } from "@/components/status/SourceTag";
import { payloadCheckAdvice } from "@/lib/economy/payload-check";
import { formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

// Cargo vs the payload stations the simulator reports (docs/ECONOMY.md "Payload check").
// Numbers come only from the check the connector computed; an `unknown` check shows no
// numbers at all.

const LABEL: Record<PayloadCheck["status"], string> = {
  ok: "Payload OK",
  underloaded: "Underloaded",
  overloaded: "Over max gross",
  unknown: "Payload unknown",
};

const SHORT: Record<PayloadCheck["status"], string> = {
  ok: "OK",
  underloaded: "Under",
  overloaded: "Over MTOW",
  unknown: "Unknown",
};

const TONE: Record<PayloadCheck["status"], string> = {
  ok: "border-success/40 bg-success/10 text-success",
  underloaded: "border-warning/40 bg-warning/10 text-warning",
  overloaded: "border-destructive/40 bg-destructive/10 text-destructive",
  unknown: "border-border bg-secondary text-muted-foreground",
};

const CREW: Record<NonNullable<PayloadCheck["crewBasis"]>, string> = {
  stations: "crew stations",
  setting: "your crew allowance",
  default: "no crew station",
};

/** Compact status pill (logbook rows). */
export function PayloadCheckPill({
  check,
  className,
}: {
  check: PayloadCheck | null | undefined;
  className?: string;
}) {
  if (!check) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={cn("inline-flex items-center gap-1.5", className)}
      data-testid="payload-check-pill"
      data-status={check.status}
      data-source={check.source}
      title={check.message}
    >
      <span
        className={cn(
          "rounded-sm border px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em]",
          TONE[check.status],
        )}
      >
        {SHORT[check.status]}
      </span>
      <SourceTag source={check.source} />
    </span>
  );
}

/** Full line for the mission strip (/jobs, /flight, dashboard). */
export function PayloadCheckLine({
  check,
  className,
}: {
  check: PayloadCheck | null | undefined;
  className?: string;
}) {
  if (!check) return null;
  const Icon =
    check.status === "unknown" ? CircleHelp : check.status === "ok" ? Scale : TriangleAlert;
  const advice = payloadCheckAdvice(check);
  const numbers = check.loadedKg !== undefined && check.crewKg !== undefined;
  return (
    <div
      className={cn("mt-2 flex flex-col gap-1 text-xs", className)}
      data-testid="payload-check"
      data-status={check.status}
      data-stage={check.stage}
      data-source={check.source}
      role={check.status === "ok" || check.status === "unknown" ? undefined : "status"}
    >
      <p className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.12em]",
            TONE[check.status],
          )}
        >
          <Icon className="size-3" aria-hidden="true" />
          {LABEL[check.status]}
        </span>
        <span className="label-eyebrow">
          {check.stage === "preview"
            ? "Payload check · before departure"
            : "Payload check · at departure"}
        </span>
        <SourceTag source={check.source} />
      </p>
      {numbers ? (
        <p
          className="font-mono text-muted-foreground font-tabular"
          data-testid="payload-check-numbers"
        >
          Sim {formatInt(check.loadedKg)} kg (stations {formatInt(check.simPayloadKg)} kg −{" "}
          {formatInt(check.crewKg)} kg {check.crewBasis ? CREW[check.crewBasis] : "crew"}) · cargo{" "}
          {formatInt(check.cargoKg)} kg ± {formatInt(check.toleranceKg)} kg
          {check.totalLb !== undefined && check.maxGrossLb !== undefined
            ? ` · gross ${formatInt(check.totalLb)} / ${formatInt(check.maxGrossLb)} lb`
            : ""}
        </p>
      ) : null}
      {advice ? (
        <p
          className={cn(
            check.status === "underloaded"
              ? "text-warning"
              : check.status === "overloaded"
                ? "text-destructive"
                : "text-muted-foreground",
          )}
          data-testid="payload-check-advice"
        >
          {advice}
        </p>
      ) : null}
    </div>
  );
}
