import type { Source } from "@cargo-ops/protocol";
import type { ReactNode } from "react";

import { SourceTag, StaleTag } from "@/components/status/SourceTag";
import { EMPTY } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A control-room console station: bezel, a call-sign header strip (e.g. NAV, SYSTEMS) and
 * a dark screen. The source tag (DEMO / REPLAY) sits on the strip for every station that
 * shows telemetry or company data.
 */
export function ConsolePanel({
  callsign,
  title,
  source,
  stale = false,
  action,
  className,
  bodyClassName,
  testId,
  children,
}: {
  callsign: string;
  title: string;
  source?: Source | null | undefined;
  stale?: boolean;
  action?: ReactNode;
  className?: string | undefined;
  bodyClassName?: string | undefined;
  testId?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section
      className={cn("console-panel", className)}
      aria-label={`${callsign}: ${title}`}
      data-testid={testId}
      data-console={callsign}
      data-stale={stale ? "" : undefined}
    >
      <header className="console-strip">
        <h2 className="flex min-w-0 items-baseline gap-2">
          <span>{callsign}</span>
          <span className="truncate text-[0.625rem] font-medium tracking-[0.16em] text-muted-foreground">
            {title}
          </span>
        </h2>
        <span className="flex shrink-0 items-center gap-1.5">
          {action}
          {stale ? <StaleTag /> : null}
          <SourceTag source={source ?? null} />
        </span>
      </header>
      <div className={cn("flex-1 p-3 md:p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

export type ReadoutTone = "green" | "amber" | "cyan" | "red" | "plain";

const TONE: Record<ReadoutTone, string> = {
  green: "text-phosphor-green",
  amber: "text-phosphor-amber",
  cyan: "text-phosphor-cyan",
  red: "text-phosphor-red",
  plain: "text-console-foreground",
};

const SIZE = {
  sm: "text-base",
  md: "text-xl md:text-2xl",
  lg: "text-2xl md:text-3xl",
  xl: "text-3xl sm:text-4xl xl:text-5xl",
} as const;

/** Labelled phosphor readout. `value` null renders "—" in grey, never a number. */
export function Readout({
  label,
  value,
  unit,
  tone = "green",
  size = "md",
  className,
  testId,
}: {
  label: string;
  value: string | null;
  unit?: string;
  tone?: ReadoutTone;
  size?: keyof typeof SIZE;
  className?: string;
  testId?: string;
}) {
  const empty = value === null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)} data-testid={testId}>
      <dt className="readout-label">{label}</dt>
      <dd className="flex min-w-0 items-baseline gap-1.5">
        <span
          className={cn("readout truncate", SIZE[size], !empty && TONE[tone])}
          data-empty={empty ? "" : undefined}
          data-testid={testId ? `${testId}-value` : undefined}
        >
          {value ?? EMPTY}
        </span>
        {unit ? (
          <span className="font-mono text-[0.625rem] uppercase text-muted-foreground">{unit}</span>
        ) : null}
      </dd>
    </div>
  );
}

/** Key/value row on a console screen (mono, thin rule). */
export function ConsoleRow({
  label,
  value,
  tone = "plain",
  testId,
}: {
  label: string;
  value: ReactNode;
  tone?: ReadoutTone;
  testId?: string;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div
      className="console-rule flex items-baseline justify-between gap-3 border-b py-1.5 last:border-b-0"
      data-testid={testId}
    >
      <dt className="readout-label shrink-0">{label}</dt>
      <dd
        className={cn(
          "min-w-0 truncate text-right font-mono text-sm tabular-nums",
          empty ? "text-muted-foreground" : TONE[tone],
        )}
      >
        {empty ? EMPTY : value}
      </dd>
    </div>
  );
}
