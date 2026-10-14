// Token classes per flight category (colours live in src/styles.css: --vfr/--mvfr/--ifr/--lifr).

import type { FlightCategory } from "@cargo-ops/weather";

/** Solid fill (timeline segments, dots). */
export const CATEGORY_FILL: Record<FlightCategory, string> = {
  VFR: "bg-vfr",
  MVFR: "bg-mvfr",
  IFR: "bg-ifr",
  LIFR: "bg-lifr",
};

/** Outline with a soft fill (forecast change bars). */
export const CATEGORY_OUTLINE: Record<FlightCategory, string> = {
  VFR: "border-vfr bg-vfr/25",
  MVFR: "border-mvfr bg-mvfr/25",
  IFR: "border-ifr bg-ifr/25",
  LIFR: "border-lifr bg-lifr/25",
};

export const CATEGORY_TEXT: Record<FlightCategory, string> = {
  VFR: "text-vfr",
  MVFR: "text-mvfr",
  IFR: "text-ifr",
  LIFR: "text-lifr",
};

export const UNKNOWN_FILL = "bg-muted-foreground/30";
