import type { Job, Mission, TransitStorage } from "@cargo-ops/protocol";
import { formatGameTime, transitRemainingMin } from "@cargo-ops/economy";

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

export const TRANSIT_STORAGE_LABELS: Record<TransitStorage, string> = {
  airport: "Airport ramp",
  own_fbo: "Own FBO",
  own_terminal: "Own cargo terminal",
};

export interface TransitView {
  location: string;
  destination: string;
  /** Minutes of the time limit left at `nowGameMs` (negative = late). */
  leftMin: number;
  late: boolean;
  /** Company clock when the limit runs out if the cargo stays where it is. */
  dueLabel: string;
  storageLabel: string;
  /** Free storage hours at an own cargo terminal (0 elsewhere). */
  freeHours: number;
  legs: number;
}

/** What /jobs and the map show for cargo in transit (docs/ECONOMY.md "Transit cargo"). */
export function transitView(job: Job, nowGameMs: number): TransitView | null {
  const t = job.transit;
  if (!t) return null;
  const leftMin = transitRemainingMin(job, nowGameMs);
  return {
    location: t.location,
    destination: job.destination,
    leftMin,
    late: leftMin < 0,
    dueLabel: formatGameTime(t.deadlineGameMs),
    storageLabel: TRANSIT_STORAGE_LABELS[t.storage],
    freeHours: Math.round((t.freeStorageMin / 60) * 10) / 10,
    legs: t.legs.length,
  };
}
