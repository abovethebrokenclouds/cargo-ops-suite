import { ArrowDownRight, ArrowRight, ArrowUpRight } from "lucide-react";
import type { ReactNode } from "react";

import { SourceTag, StaleTag } from "@/components/status/SourceTag";
import { useAnimatedNumber } from "@/hooks/use-animated-number";
import { EMPTY, formatInt } from "@/lib/format";
import { cn } from "@/lib/utils";

export type MetricSource = "sim" | "replay" | "demo";

export type MetricTileProps = {
  label: string;
  value: number | null;
  /** Pre-formatted text instead of a number (e.g. a position); null renders an em dash. */
  text?: string | null;
  unit?: string;
  format?: (n: number) => string;
  size?: "md" | "lg" | "xl";
  trend?: "up" | "down" | "flat";
  hint?: ReactNode;
  source?: MetricSource | null;
  /** Data is older than the stale threshold: dims the value and adds a STALE tag. */
  stale?: boolean;
  /** Reserve this many character widths and right-align, so changing digits never shift layout. */
  digits?: number;
  /**
   * Ease between values (giant economy figures such as cash). Off by default: live telemetry
   * is never interpolated. Respects prefers-reduced-motion.
   */
  animate?: boolean;
  /** Warning/critical colouring of the value (e.g. low endurance). */
  tone?: "default" | "warning" | "critical";
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
  text,
  unit,
  format = formatInt,
  size = "lg",
  trend,
  hint,
  source = null,
  stale = false,
  digits,
  tone = "default",
  animate = false,
  className,
  children,
}: MetricTileProps) {
  const usesText = text !== undefined;
  const empty = usesText ? text === null : value === null || !Number.isFinite(value);
  const shown = useAnimatedNumber(empty || usesText ? null : value, animate);
  const display = empty ? EMPTY : usesText ? (text ?? EMPTY) : format((shown ?? value) as number);
  const TrendIcon = trend ? trendIcon[trend] : null;

  return (
    <div
      className={cn(
        "@container panel-elevated relative flex flex-col gap-3 p-5 md:p-6",
        "animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none",
        className,
      )}
      data-metric={label}
      data-source={source ?? "none"}
      data-stale={stale ? "" : undefined}
      data-tone={tone === "default" ? undefined : tone}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="label-eyebrow">{label}</p>
        <span className="flex items-center gap-1.5">
          {stale ? <StaleTag /> : null}
          <SourceTag source={source} />
        </span>
      </div>
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1">
        <span
          className={cn(
            sizeClass[size],
            "metric-live pb-[0.06em]",
            size === "xl" && "metric-glow",
            digits !== undefined && "inline-block text-right",
          )}
          style={digits !== undefined ? { minWidth: `${digits}ch` } : undefined}
          data-empty={empty ? "" : undefined}
          data-tone={tone === "default" ? undefined : tone}
          data-value={empty || usesText ? undefined : String(value)}
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
      {hint ? <div className="text-xs text-muted-foreground">{hint}</div> : null}
      {children}
    </div>
  );
}
