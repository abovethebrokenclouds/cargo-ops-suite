import type { FlightCategory } from "@cargo-ops/weather";

import { cn } from "@/lib/utils";

const tone: Record<FlightCategory, string> = {
  VFR: "border-vfr/40 bg-vfr/15 text-vfr",
  MVFR: "border-mvfr/40 bg-mvfr/15 text-mvfr",
  IFR: "border-ifr/40 bg-ifr/15 text-ifr",
  LIFR: "border-lifr/40 bg-lifr/15 text-lifr",
};

const title: Record<FlightCategory, string> = {
  VFR: "VFR: ceiling above 3,000 ft and visibility above 5 SM",
  MVFR: "Marginal VFR: ceiling 1,000–3,000 ft and/or visibility 3–5 SM",
  IFR: "IFR: ceiling 500 to below 1,000 ft and/or visibility 1 to below 3 SM",
  LIFR: "Low IFR: ceiling below 500 ft and/or visibility below 1 SM",
};

/** VFR / MVFR / IFR / LIFR chip in the conventional chart colours (tokens in styles.css). */
export function FlightCategoryChip({
  category,
  className,
}: {
  category: FlightCategory | null;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 font-mono text-[0.6875rem] font-semibold tracking-[0.12em]",
        category ? tone[category] : "border-border bg-secondary text-muted-foreground",
        className,
      )}
      title={category ? title[category] : "Flight category unknown"}
      data-testid="flight-category"
      data-category={category ?? "unknown"}
    >
      <span className="status-dot size-1.5" aria-hidden="true" />
      {category ?? "N/A"}
    </span>
  );
}
