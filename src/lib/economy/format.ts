import type { Job, Mission, TransitStorage } from "@cargo-ops/protocol";
import { formatGameTime, transitPayoutEstimate, transitRemainingMin } from "@cargo-ops/economy";
import { formatMinutes } from "@/lib/format";

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

/**
 * Deadline line for an active mission (MissionStrip, /panel): time left once started, the
 * limit counted from block-out before that. `late` marks a missed deadline.
 */
export function missionDeadline(m: Mission): { text: string; late: boolean } {
  const left = missionTimeLeftMin(m);
  if (left === null) {
    return m.timeLimitMin < 0
      ? { text: `${formatMinutes(-m.timeLimitMin)} late already`, late: true }
      : { text: `${formatMinutes(m.timeLimitMin)} from block-out`, late: false };
  }
  return left >= 0
    ? { text: `${formatMinutes(left)} left`, late: false }
    : { text: `${formatMinutes(-left)} late`, late: true };
}

export const TRANSIT_STORAGE_LABELS: Record<TransitStorage, string> = {
  airport: "Airport ramp",
  own_fbo: "Own FBO",
  own_terminal: "Own cargo terminal",
};

export interface TransitView {
  location: string;
  destination: string;
  /**
   * Minutes of the time limit left at `nowGameMs` (negative = late); null when the company
   * clock is not known yet (time left unknown, never guessed).
   */
  leftMin: number | null;
  late: boolean;
  /** Company clock when the limit runs out if the cargo stays where it is. */
  dueLabel: string;
  storageLabel: string;
  /** Free storage hours at an own cargo terminal (0 elsewhere). */
  freeHours: number;
  legs: number;
  /**
   * Payout estimate on delivery with the late penalty accrued so far (landing 1.00); null
   * without the company clock or reputation.
   */
  payoutEstimate: number | null;
}

/** What /jobs and the map show for cargo in transit (docs/ECONOMY.md "Transit cargo"). */
export function transitView(
  job: Job,
  nowGameMs: number | null,
  reputation: number | null = null,
): TransitView | null {
  const t = job.transit;
  if (!t) return null;
  const leftMin = nowGameMs === null ? null : transitRemainingMin(job, nowGameMs);
  return {
    location: t.location,
    destination: job.destination,
    leftMin,
    late: leftMin !== null && leftMin < 0,
    dueLabel: formatGameTime(t.deadlineGameMs),
    storageLabel: TRANSIT_STORAGE_LABELS[t.storage],
    freeHours: Math.round((t.freeStorageMin / 60) * 10) / 10,
    legs: t.legs.length,
    payoutEstimate:
      nowGameMs === null || reputation === null
        ? null
        : transitPayoutEstimate(job, nowGameMs, reputation),
  };
}

/** Deadline line: due time on the company clock and the time left (unknown without a clock). */
export function transitDeadlineText(v: TransitView): string {
  if (v.leftMin === null) return `Due ${v.dueLabel} · time left unknown`;
  if (v.leftMin < 0) return `Late by ${formatMinutes(-v.leftMin)} (penalty at delivery)`;
  return `Due ${v.dueLabel} · ${formatMinutes(v.leftMin)} left`;
}
