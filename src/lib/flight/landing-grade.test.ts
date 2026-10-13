import { describe, expect, it } from "vitest";

import { GRADE_LABELS, gGrade, landingGrade, rateGrade, worstGrade } from "./landing-grade";

describe("rateGrade", () => {
  it.each([
    [0, "A+"],
    [60, "A+"],
    [61, "A"],
    [120, "A"],
    [200, "B"],
    [300, "C"],
    [400, "D"],
    [600, "E"],
    [601, "F"],
    [1500, "F"],
  ] as const)("%i fpm → %s", (rate, grade) => {
    expect(rateGrade(rate)).toBe(grade);
  });

  it("ignores the sign of the sink rate", () => {
    expect(rateGrade(-142)).toBe("B");
    expect(rateGrade(-55)).toBe("A+");
  });

  it("returns null for missing or non-finite input", () => {
    expect(rateGrade(null)).toBeNull();
    expect(rateGrade(undefined)).toBeNull();
    expect(rateGrade(Number.NaN)).toBeNull();
  });
});

describe("gGrade", () => {
  it.each([
    [1.0, "A+"],
    [1.1, "A+"],
    [1.18, "A"],
    [1.4, "A"],
    [1.55, "C"],
    [1.7, "C"],
    [1.71, "F"],
  ] as const)("%f G → %s", (g, grade) => {
    expect(gGrade(g)).toBe(grade);
  });

  it("returns null when G is unknown", () => {
    expect(gGrade(null)).toBeNull();
    expect(gGrade(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("landingGrade", () => {
  it("takes the worse of the rate and G grades", () => {
    expect(landingGrade(-142, 1.18)).toBe("B");
    expect(landingGrade(-50, 1.18)).toBe("A");
    expect(landingGrade(-50, 1.6)).toBe("C");
    expect(landingGrade(-450, 1.05)).toBe("E");
    expect(landingGrade(-90, 2.1)).toBe("F");
  });

  it("grades on rate alone when G is missing", () => {
    expect(landingGrade(-250, null)).toBe("C");
  });

  it("returns null without a touchdown rate", () => {
    expect(landingGrade(null, 1.05)).toBeNull();
  });

  it("labels every grade", () => {
    expect(GRADE_LABELS.B).toBe("Good");
    expect(worstGrade(null, null)).toBeNull();
  });
});
