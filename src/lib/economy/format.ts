import type { Mission } from "@cargo-ops/protocol";

// Payout breakdown number formatting.

/** 1 → "1.00", 1.04 → "1.04", 0.812252 → "0.8123". */
export function multiplier(n: number): string {
  const [int, frac = ""] = n.toFixed(4).split(".");
  const trimmed = frac.replace(/0+$/, "").padEnd(2, "0");
  return `${int}.${trimmed}`;
}

/** Time left before the tightest job deadline, minutes (negative = late); null before start. */
export function missionTimeLeftMin(m: Mission): number | null {
  if (m.status !== "in_progress") return null;
  return m.timeLimitMin - (m.elapsedMin ?? 0);
}
