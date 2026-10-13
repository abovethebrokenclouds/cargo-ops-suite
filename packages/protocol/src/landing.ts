import { z } from "zod";

// Landing grading (plan §6.3), shared by the connector's landing analyser and the
// web app. Pure functions; the only schema here is the `touchdown` event payload.
//
// grade = min(rate grade, G grade, speed grade). The speed grade needs a reference
// touchdown speed for the aircraft type, which arrives with the aircraft catalogue
// (P4); until then it is null and the grade is the worse of rate and G.

export const LANDING_GRADES = ["A+", "A", "B", "C", "D", "E", "F"] as const;
export type LandingGrade = (typeof LANDING_GRADES)[number];
export const landingGradeSchema = z.enum(LANDING_GRADES);

/** Upper bounds (inclusive) of |rate| in fpm for each grade, best first; above the last is F. */
export const RATE_BANDS_FPM = [60, 120, 200, 300, 400, 600] as const;

/** Upper bounds (inclusive) of peak G and the grade each caps the landing at. */
export const G_BANDS: ReadonlyArray<readonly [number, LandingGrade]> = [
  [1.1, "A+"],
  [1.4, "A"],
  [1.7, "C"],
];

/**
 * Upper bounds (inclusive) of touchdown ground speed above the type's reference
 * speed, in knots, and the grade each caps the landing at; above the last is E.
 */
export const SPEED_EXCESS_BANDS_KT: ReadonlyArray<readonly [number, LandingGrade]> = [
  [5, "A+"],
  [10, "A"],
  [20, "C"],
  [30, "D"],
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

/**
 * Grade cap for touchdown ground speed against a reference speed for the aircraft
 * type. Null when either is unknown (no reference speeds exist before P4).
 */
export function speedGrade(
  gsKt: number | null | undefined,
  referenceKt: number | null | undefined,
): LandingGrade | null {
  if (!finite(gsKt) || !finite(referenceKt) || referenceKt <= 0) return null;
  const excess = gsKt - referenceKt;
  for (const [limit, grade] of SPEED_EXCESS_BANDS_KT) if (excess <= limit) return grade;
  return "E";
}

/** The worse of the grades; null inputs are ignored. */
export function worstGrade(...grades: Array<LandingGrade | null>): LandingGrade | null {
  let worst = -1;
  for (const g of grades) {
    if (g === null) continue;
    worst = Math.max(worst, LANDING_GRADES.indexOf(g));
  }
  return worst === -1 ? null : (LANDING_GRADES[worst] ?? null);
}

/**
 * Landing grade from touchdown rate, peak G and (optionally) the speed grade. A
 * missing rate means no grade at all (G alone cannot describe a landing); missing
 * G or speed grades on what is known.
 */
export function landingGrade(
  rateFpm: number | null | undefined,
  gForce: number | null | undefined,
  speed: LandingGrade | null = null,
): LandingGrade | null {
  const rate = rateGrade(rateFpm);
  if (rate === null) return null;
  return worstGrade(rate, gGrade(gForce), speed);
}

/**
 * Where the touchdown rate came from:
 * - `touchdownVelocity`: the simulator's PLANE TOUCHDOWN NORMAL VELOCITY;
 * - `verticalSpeed`: the last airborne VERTICAL SPEED sample before contact
 *   (used when the simulator does not report the touchdown SimVar, e.g. replays).
 */
export const RATE_SOURCES = ["touchdownVelocity", "verticalSpeed"] as const;
export const rateSourceSchema = z.enum(RATE_SOURCES);
export type RateSource = z.infer<typeof rateSourceSchema>;

const finiteNum = () => z.number().finite();

/** Payload of the `touchdown` event, computed by the connector's landing analyser. */
export const touchdownSchema = z.object({
  /** Sink rate at touchdown, fpm; negative = descending. */
  rateFpm: finiteNum(),
  rateSource: rateSourceSchema,
  /** Highest G FORCE sample within 800 ms after first contact. */
  peakG: finiteNum(),
  /** Ground speed at first contact, knots. */
  gsKt: finiteNum(),
  /** Bank/pitch at touchdown, degrees; null when the simulator did not report them. */
  bankDeg: finiteNum().nullable(),
  pitchDeg: finiteNum().nullable(),
  /** Position at first contact, degrees. */
  lat: finiteNum().min(-90).max(90),
  lon: finiteNum().min(-180).max(180),
  /** AGL rose above 35 ft and came back below 5 ft after first contact. */
  bounces: z.number().int().nonnegative(),
  grade: landingGradeSchema,
  rateGrade: landingGradeSchema,
  gGrade: landingGradeSchema,
  /** Null until reference speeds per aircraft type exist (P4). */
  speedGrade: landingGradeSchema.nullable(),
});
export type Touchdown = z.infer<typeof touchdownSchema>;
