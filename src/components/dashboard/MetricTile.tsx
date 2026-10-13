import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import { EMPTY, formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

export type MetricSource = "sim" | "replay" | "demo";

export type MetricTileProps = {
  label: string;
  value: number | null;
  unit?: string;
  format?: (n: number) => string;
  size?: "md" | "lg" | "xl";
  trend?: "up" | "down" | "flat";
  hint?: string;
  source?: MetricSource | null;
  className?: string;
  children?: ReactNode;
};

const sizeClass = { md: "metric-md", lg: "metric-lg", xl: "metric-xl" } as const;
const unitClass = { md: "text-sm", lg: "text-base", xl: "text-xl" } as const;

const trendIcon = { up: ArrowUpRight, down: ArrowDownRight, flat: ArrowRight } as const;
const trendLabel = { up: "rising", down: "falling", flat: "steady" } as const;

export function MetricTile({
  label,
  value,
  unit,
  format = formatInt,
  size = "lg",
  trend,
  hint,
  source = null,
  className,
  children,
}: MetricTileProps) {
  const empty = value === null || !Number.isFinite(value);
  const display = empty ? EMPTY : format(value);
  const TrendIcon = trend ? trendIcon[trend] : null;
  const showSource = source === "demo" || source === "replay";

  return (
    <div
      className={cn("@container panel-elevated relative flex flex-col gap-3 p-5 md:p-6", className)}
      data-metric={label}
      data-source={source ?? "none"}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="label-eyebrow">{label}</p>
        {showSource ? (
          <span
            className={cn(
              "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold tracking-[0.16em]",
              source === "demo" ? "bg-warning/15 text-warning" : "bg-tertiary/20 text-foreground",
            )}
          >
            {source === "demo" ? "DEMO" : "REPLAY"}
          </span>
        ) : null}
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={cn(sizeClass[size], "pb-[0.06em]")}
          data-empty={empty ? "" : undefined}
          data-testid="metric-value"
        >
          {display}
        </span>
        {unit ? (
          <span
            className={cn(
              "font-mono font-medium uppercase tracking-wider text-muted-foreground",
              unitClass[size],
            )}
          >
            {unit}
          </span>
        ) : null}
        {TrendIcon && trend && !empty ? (
          <TrendIcon
            aria-label={trendLabel[trend]}
            className={cn(
              "ml-auto size-5 self-center",
              trend === "up" && "text-success",
              trend === "down" && "text-destructive",
              trend === "flat" && "text-muted-foreground",
            )}
          />
        ) : null}
      </div>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      {children}
    </div>
  );
}
