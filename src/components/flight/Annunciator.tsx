import { cn } from "@/lib/utils";

export type AnnunciatorTone = "success" | "accent" | "warning" | "destructive";

export type AnnunciatorProps = {
  label: string;
  /** on = illuminated, off = dark, unknown = no data (dashed, em dash value). */
  state: "on" | "off" | "unknown";
  tone?: AnnunciatorTone;
  /** Secondary text, e.g. "1/1" or "×2". */
  value?: string;
  pulse?: boolean;
  className?: string;
};

const litClass: Record<AnnunciatorTone, string> = {
  success: "text-success",
  accent: "text-accent",
  warning: "text-warning",
  destructive: "text-destructive",
};

/** Cockpit-style status light. Unknown never renders as lit or as a definite "off". */
export function Annunciator({
  label,
  state,
  tone = "success",
  value,
  pulse = false,
  className,
}: AnnunciatorProps) {
  return (
    <div
      className={cn(
        "annunciator flex min-w-0 items-center gap-2 px-3 py-2",
        state === "on" ? litClass[tone] : "text-muted-foreground",
        state === "unknown" && "border-dashed opacity-70",
        className,
      )}
      data-state={state}
      data-annunciator={label}
    >
      <span
        aria-hidden="true"
        className={cn("status-dot size-2", state !== "on" && "opacity-25")}
        data-live={state === "on" && pulse ? "true" : undefined}
      />
      <span className="truncate font-mono text-[0.6875rem] font-semibold uppercase tracking-[0.14em]">
        {label}
      </span>
      {value !== undefined || state === "unknown" ? (
        <span className="ml-auto pl-1 font-mono text-[0.6875rem] font-semibold font-tabular">
          {state === "unknown" ? "—" : value}
        </span>
      ) : null}
    </div>
  );
}

/** Small label/value pair used under the hero readouts. */
export function SubReadout({
  label,
  value,
  unit,
  tone = "default",
  className,
}: {
  label: string;
  value: string;
  unit?: string;
  tone?: "default" | "warning";
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)} data-readout={label}>
      <p className="font-mono text-[0.625rem] uppercase tracking-[0.18em] text-muted-foreground">
        {label}
      </p>
      <p
        className={cn(
          "mt-1 truncate font-mono text-sm font-semibold font-tabular transition-colors",
          tone === "warning" ? "text-warning" : "text-foreground",
        )}
      >
        {value}
        {unit && value !== "—" ? (
          <span className="ml-1 text-xs font-medium text-muted-foreground">{unit}</span>
        ) : null}
      </p>
    </div>
  );
}
