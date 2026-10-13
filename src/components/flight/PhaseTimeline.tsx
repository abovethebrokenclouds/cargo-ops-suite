import { cn } from "@/lib/utils";

import { FLIGHT_PHASES, PHASE_LABELS, type FlightPhase } from "./phases";

/** Horizontal phase rail. With `current` null every phase is pending (no fabricated state). */
export function PhaseTimeline({ current }: { current: FlightPhase | null }) {
  const index = current ? FLIGHT_PHASES.indexOf(current) : -1;
  return (
    <ol
      className="grid grid-cols-2 gap-x-3 gap-y-4 sm:grid-cols-5 lg:grid-cols-10"
      aria-label="Flight phases"
    >
      {FLIGHT_PHASES.map((phase, i) => {
        const state = i < index ? "done" : i === index ? "current" : "pending";
        return (
          <li
            key={phase}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
            className="flex min-w-0 flex-col gap-2"
          >
            <span
              className={cn(
                "h-1 rounded-full transition-colors duration-500",
                state === "done" && "bg-primary",
                state === "current" && "bg-gradient-brand shadow-glow",
                state === "pending" && "bg-secondary",
              )}
            />
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                aria-hidden="true"
                className={cn(
                  "status-dot size-1.5",
                  state === "pending" ? "text-muted-foreground/50" : "text-accent",
                )}
                data-live={state === "current" ? "true" : undefined}
              />
              <span
                className={cn(
                  "truncate font-mono text-[0.625rem] uppercase tracking-[0.12em]",
                  state === "pending" && "text-muted-foreground",
                  state === "done" && "text-foreground/80",
                  state === "current" && "font-semibold text-accent",
                )}
              >
                {PHASE_LABELS[phase]}
              </span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}
