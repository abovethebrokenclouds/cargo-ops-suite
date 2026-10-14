// Payout formula (plan §7), with a transparent breakdown of every factor.
//
//   base   = rate × kg × nm × atan(nm / 25) / atan(1)
//   gross  = base × kind × n^-0.3 × conditions × (1 + 0.02 × tier) × landing
//   total  = max(0, round(gross − late penalty − damage))
//
// noBonus (sim rate went above 1×) removes the bonuses: conditions and reputation
// become 1.00 and the landing multiplier is capped at 1.00 (penalties still apply).
// payloadMismatch (the departure payload check found the sim payload clearly below
// the cargo) has exactly the same effect, with its own note.
// Weather bonus: + 5 % (IFR) or + 10 % (LIFR) on the conditions line from the live METAR
// frozen at departure/arrival (weather-bonus.ts); removed by noBonus like every bonus.

import type {
  CargoKind,
  MissionWeather,
  PayoutBreakdown,
  PayoutFactor,
} from "../../protocol/src/economy";
import type { LandingGrade } from "../../protocol/src/landing";
import {
  CONDITION_BONUS,
  DISTANCE_SCALE_NM,
  FRAGILE_DAMAGE_SHARE,
  FRAGILE_G_CAP,
  KIND_LABELS,
  KIND_MULTIPLIERS,
  LANDING_MULTIPLIERS,
  LATE_PENALTY_PER_HOUR,
  LOAD_SCALING_EXPONENT,
  RATE_USD_PER_KG_NM,
  REPUTATION_STEP,
  REPUTATION_TIER_SIZE,
} from "./constants";
import { round2 } from "./geo";
import { weatherBonus } from "./weather-bonus";

/** atan(nm / 25) / atan(1): short legs pay less per nm, approaching 2 for long legs. */
export function distanceCurve(nm: number): number {
  return Math.atan(nm / DISTANCE_SCALE_NM) / Math.atan(1);
}

export function basePay(weightKg: number, distanceNm: number): number {
  return RATE_USD_PER_KG_NM * weightKg * distanceNm * distanceCurve(distanceNm);
}

export function reputationTier(reputation: number): number {
  const r = Math.max(0, Math.min(100, reputation));
  return Math.min(5, Math.floor(r / REPUTATION_TIER_SIZE));
}

/** Landing multiplier for a grade; null (no touchdown recorded) → 1.00. */
export function landingMultiplier(grade: LandingGrade | null | undefined): number {
  return grade ? LANDING_MULTIPLIERS[grade] : 1;
}

export function loadScaling(units: number): number {
  return Math.max(1, Math.floor(units)) ** LOAD_SCALING_EXPONENT;
}

export interface Conditions {
  ifr?: boolean;
  night?: boolean;
  weather?: boolean;
}

export interface PayoutInput {
  jobId?: string;
  kind: CargoKind;
  weightKg: number;
  distanceNm: number;
  units: number;
  reputation: number;
  /** IFR/night/weather flags; all false until night/weather are observed. */
  conditions?: Conditions;
  /** METAR flight category frozen at departure/arrival: the weather bonus (IFR/LIFR). */
  weather?: MissionWeather | null;
  /** Board estimate: landing 1.00, on time. */
  estimate: boolean;
  landingGrade?: LandingGrade | null;
  /** Minutes past the time limit (≤ 0 = on time). */
  lateMin?: number;
  /** Touchdown peak G, for the fragile damage check. */
  peakG?: number | null;
  noBonus?: boolean;
  /** Departure payload check underloaded: bonuses removed like noBonus (docs/ECONOMY.md). */
  payloadMismatch?: boolean;
  /**
   * P5 part 2: local demand × own cargo terminal factor fixed on the job board; absent or
   * 1 adds no line (P4/P5 payouts are unchanged).
   */
  demand?: number;
}

const fmt = (n: number, d = 2) => n.toFixed(d);

export function computePayout(input: PayoutInput): PayoutBreakdown {
  const mismatch = input.payloadMismatch === true;
  const noBonus = input.noBonus === true || mismatch;
  const noBonusNote =
    input.noBonus === true
      ? mismatch
        ? "No bonuses: sim rate went above 1× and the sim payload was below the cargo"
        : "No bonuses: sim rate went above 1×"
      : "No bonuses: the sim payload was below the cargo at departure";
  const base = basePay(input.weightKg, input.distanceNm);
  const factors: PayoutFactor[] = [
    {
      key: "base",
      kind: "base",
      value: round2(base),
      label: "Base pay",
      note: `$${RATE_USD_PER_KG_NM} × ${input.weightKg} kg × ${input.distanceNm} nm × atan(nm/25)/atan(1) (${fmt(distanceCurve(input.distanceNm), 4)})`,
    },
  ];
  let gross = base;
  const multiply = (factor: Omit<PayoutFactor, "kind">) => {
    gross *= factor.value;
    factors.push({ ...factor, kind: "multiplier", value: round2Precise(factor.value) });
  };

  multiply({
    key: "kind",
    label: `Cargo kind: ${KIND_LABELS[input.kind]}`,
    value: KIND_MULTIPLIERS[input.kind],
  });

  const units = Math.max(1, Math.floor(input.units));
  multiply({
    key: "load",
    label: "Load scaling n^-0.3",
    value: loadScaling(units),
    note: `${units} unit${units === 1 ? "" : "s"}`,
  });

  const c = input.conditions ?? {};
  const wx = weatherBonus(input.weather);
  const conditionValue = noBonus
    ? 1
    : 1 +
      (c.ifr ? CONDITION_BONUS.ifr : 0) +
      (c.night ? CONDITION_BONUS.night : 0) +
      (c.weather ? CONDITION_BONUS.weather : 0) +
      wx.bonus;
  multiply({
    key: "conditions",
    label: "Conditions (IFR / night / weather)",
    value: conditionValue,
    note: noBonus
      ? wx.bonus > 0
        ? `${noBonusNote} (weather bonus +${Math.round(wx.bonus * 100)} % withheld)`
        : noBonusNote
      : input.estimate
        ? "Estimate: no weather bonus until the flight's METARs are recorded"
        : wx.note,
  });

  const tier = reputationTier(input.reputation);
  multiply({
    key: "reputation",
    label: `Reputation tier ${tier}`,
    value: noBonus ? 1 : 1 + REPUTATION_STEP * tier,
    note: noBonus ? noBonusNote : `1 + 0.02 × ${tier} (reputation ${Math.round(input.reputation)})`,
  });

  if (input.demand !== undefined && input.demand !== 1) {
    multiply({
      key: "demand",
      label: "Local demand",
      value: input.demand,
      note: "Demand index of origin and destination (events, activity) × own cargo terminal",
    });
  }

  let landing = input.estimate ? 1 : landingMultiplier(input.landingGrade);
  if (noBonus) landing = Math.min(1, landing);
  multiply({
    key: "landing",
    label: input.estimate
      ? "Landing (estimate)"
      : `Landing grade ${input.landingGrade ?? "none recorded"}`,
    value: landing,
    ...(input.estimate
      ? { note: "Estimate assumes a B/C landing" }
      : noBonus && landingMultiplier(input.landingGrade) > 1
        ? { note: "Capped at 1.00: no bonuses" }
        : {}),
  });

  let deductions = 0;
  const lateMin = Math.max(0, input.lateMin ?? 0);
  if (!input.estimate) {
    const lateShare = Math.min(1, (lateMin / 60) * LATE_PENALTY_PER_HOUR);
    const late = gross * lateShare;
    deductions += late;
    factors.push({
      key: "late",
      kind: "deduction",
      value: round2(late),
      label: "Late penalty",
      note:
        lateMin > 0
          ? `${fmt(lateMin, 1)} min late: 10 % of gross per hour (${fmt(lateShare * 100, 1)} %)`
          : "On time",
    });
    let damage = 0;
    let damageNote = "No damage";
    if (
      input.kind === "fragile" &&
      typeof input.peakG === "number" &&
      input.peakG > FRAGILE_G_CAP
    ) {
      damage = gross * FRAGILE_DAMAGE_SHARE;
      damageNote = `Fragile cargo damaged: peak G ${input.peakG} > ${FRAGILE_G_CAP}`;
    }
    deductions += damage;
    factors.push({
      key: "damage",
      kind: "deduction",
      value: round2(damage),
      label: "Damage",
      note: damageNote,
    });
  }

  const total = Math.max(0, Math.round(gross - deductions));
  return {
    ...(input.jobId ? { jobId: input.jobId } : {}),
    base: round2(base),
    factors,
    gross: round2(gross),
    deductions: round2(deductions),
    total,
    estimate: input.estimate,
    noBonus,
    ...(mismatch ? { payloadMismatch: true } : {}),
    ...(!noBonus && wx.bonus > 0 ? { weatherBonus: wx.bonus } : {}),
  };
}

/** Multipliers keep 4 decimals (n^-0.3 is irrational). */
function round2Precise(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}
