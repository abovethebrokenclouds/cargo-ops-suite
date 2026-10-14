import { cn } from "@/lib/utils";

import { simStatusLabel, type SimStatus } from "./sim-status";

export type { SimStatus };

export type SimStatusChipProps = {
  status: SimStatus;
  simName?: string;
  protocol?: string;
  detail?: string;
  /** Overrides the default label for the status (e.g. "CONNECTOR OFFLINE"). */
  label?: string;
  className?: string;
  /** No pulsing dot (the in-sim toolbar panel shows nothing animated). */
  still?: boolean;
};

type Look = { chip: string; dot: string; pulse: boolean };

// Token classes only. Demo uses a filled warning treatment so it can never read as live.
const looks: Record<SimStatus, Look> = {
  live: {
    chip: "border-success/40 bg-success/10 text-success",
    dot: "text-success",
    pulse: true,
  },
  demo: {
    chip: "border-warning bg-warning text-warning-foreground shadow-[0_0_24px_-6px_var(--warning)]",
    dot: "text-warning-foreground",
    pulse: false,
  },
  replay: {
    chip: "border-tertiary/50 bg-tertiary/15 text-foreground",
    dot: "text-tertiary",
    pulse: false,
  },
  disconnected: {
    chip: "border-destructive/40 bg-destructive/10 text-destructive",
    dot: "text-destructive",
    pulse: false,
  },
  connecting: {
    chip: "border-border bg-secondary/60 text-muted-foreground",
    dot: "text-muted-foreground",
    pulse: true,
  },
  error: {
    chip: "border-destructive/60 bg-destructive/20 text-foreground",
    dot: "text-destructive",
    pulse: false,
  },
};

export function SimStatusChip({
  status,
  simName,
  protocol,
  detail,
  label: labelOverride,
  className,
  still = false,
}: SimStatusChipProps) {
  const look = looks[status];
  const label = labelOverride ?? simStatusLabel(status, simName, protocol);
  return (
    <span
      role="status"
      aria-live="polite"
      data-status={status}
      title={detail}
      className={cn(
        "inline-flex max-w-full items-center gap-2 rounded-full border px-3 py-1.5 font-mono text-[0.6875rem] font-semibold uppercase leading-none tracking-[0.14em] whitespace-nowrap",
        look.chip,
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn("status-dot", look.dot)}
        data-live={look.pulse && !still ? "true" : undefined}
      />
      <span className="truncate">{label}</span>
      {detail ? <span className="sr-only">{`: ${detail}`}</span> : null}
    </span>
  );
}
