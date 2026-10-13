// Provisional landing grade (plan §6.3), computed client-side from the `touchdown`
// event until the connector's landing analyser (P2) reports its own grade.
// Grade = min(rate grade, G grade). The speed grade from §6.3 needs per-type
// reference speeds and arrives with the analyser.

export const LANDING_GRADES = ["A+", "A", "B", "C", "D", "E", "F"] as const;
export type LandingGrade = (typeof LANDING_GRADES)[number];

/** Upper bounds (inclusive) of |rate| in fpm for each grade, best first; above the last is F. */
export const RATE_BANDS_FPM = [60, 120, 200, 300, 400, 600] as const;

/** Upper bounds (inclusive) of peak G and the grade each caps the landing at. */
export const G_BANDS: ReadonlyArray<readonly [number, LandingGrade]> = [
  [1.1, "A+"],
  [1.4, "A"],
  [1.7, "C"],
];

export const GRADE_LABELS: Record<LandingGrade, string> = {
  "A+": "Butter",
  A: "Smooth",
  B: "Good",
  C: "Firm",
  D: "Hard",
  E: "Very hard",
  F: "Inspection required",
};

function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Grade for a touchdown rate in fpm (sign ignored), or null when unknown. */
export function rateGrade(rateFpm: number | null | undefined): LandingGrade | null {
  if (!finite(rateFpm)) return null;
  const abs = Math.abs(rateFpm);
  const index = RATE_BANDS_FPM.findIndex((limit) => abs <= limit);
  return LANDING_GRADES[index === -1 ? LANDING_GRADES.length - 1 : index] ?? "F";
}

/** Grade cap for a peak G load, or null when unknown. */
export function gGrade(gForce: number | null | undefined): LandingGrade | null {
  if (!finite(gForce)) return null;
  for (const [limit, grade] of G_BANDS) if (gForce <= limit) return grade;
  return "F";
}

/** The worse of two grades; null inputs are ignored. */
export function worstGrade(...grades: Array<LandingGrade | null>): LandingGrade | null {
  let worst = -1;
  for (const g of grades) {
    if (g === null) continue;
    worst = Math.max(worst, LANDING_GRADES.indexOf(g));
  }
  return worst === -1 ? null : (LANDING_GRADES[worst] ?? null);
}

/**
 * Landing grade from touchdown rate and peak G. A missing rate means no grade at all
 * (G alone cannot describe a landing); a missing G grades on rate alone.
 */
export function landingGrade(
  rateFpm: number | null | undefined,
  gForce: number | null | undefined,
): LandingGrade | null {
  const rate = rateGrade(rateFpm);
  if (rate === null) return null;
  return worstGrade(rate, gGrade(gForce));
}
