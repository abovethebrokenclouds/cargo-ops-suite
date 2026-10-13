import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  contrastRatio,
  mixOklab,
  oklabToRgb,
  over,
  readOklchTokens,
  toHex,
  type Rgb,
} from "./contrast";

// WCAG 2.x AA for the token pairs the components actually use (P6 accessibility pass).
// Normal text needs 4.5:1, large/bold display text and UI glyphs 3:1.
const css = readFileSync(resolve(__dirname, "../../styles.css"), "utf8");
const t = readOklchTokens(css);
const rgb = (name: string): Rgb => {
  const v = t[name];
  if (!v) throw new Error(`token --${name} missing`);
  return oklabToRgb(v);
};

const background = rgb("background");
// .panel / .panel-elevated: card at 80–88 % over the page; 80 % is the darker-contrast case
// for light text only marginally, so check both ends.
const panel80 = over(rgb("card"), 0.8, background);
const panel88 = over(rgb("card"), 0.88, background);
const secondary = rgb("secondary");
// .panel-inset: background at 70 % over a panel.
const inset = over(background, 0.7, panel80);
const surfaces: Record<string, Rgb> = { background, panel80, panel88, secondary, inset };

// label-eyebrow: color-mix(in oklab, accent 55 %, muted-foreground).
const eyebrow = (() => {
  const a = t["accent"];
  const m = t["muted-foreground"];
  if (!a || !m) throw new Error("tokens missing");
  return oklabToRgb(mixOklab(a, m, 0.55));
})();

const textOn: Array<[string, Rgb, number]> = [
  ["foreground", rgb("foreground"), 4.5],
  ["muted-foreground", rgb("muted-foreground"), 4.5],
  ["label-eyebrow", eyebrow, 4.5],
  ["accent", rgb("accent"), 4.5],
  ["primary", rgb("primary"), 4.5],
  ["success", rgb("success"), 4.5],
  ["warning", rgb("warning"), 4.5],
  // Destructive is used for short status words and error lines at text-xs/sm.
  ["destructive", rgb("destructive"), 4.5],
];

describe("token contrast (WCAG AA)", () => {
  for (const [name, fg, min] of textOn) {
    for (const [surface, bg] of Object.entries(surfaces)) {
      it(`${name} on ${surface} ≥ ${min}:1`, () => {
        expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
      });
    }
  }

  it("button foregrounds on their fills ≥ 4.5:1", () => {
    const dark = rgb("primary-foreground");
    for (const fill of ["primary", "accent", "success", "warning"]) {
      expect(contrastRatio(dark, rgb(fill)), fill).toBeGreaterThanOrEqual(4.5);
    }
    // The brand gradient runs primary → accent → tertiary; its dark label must clear the
    // darkest stop at the large-text/UI threshold (labels are semibold 14 px+ on the CTA).
    expect(contrastRatio(dark, rgb("tertiary"))).toBeGreaterThanOrEqual(3);
    // The only destructive fill with text is the error status chip: bg-destructive/20 over the
    // header with text-destructive-foreground (solid destructive buttons are not used).
    const chip = over(rgb("destructive"), 0.2, background);
    expect(contrastRatio(rgb("destructive-foreground"), chip)).toBeGreaterThanOrEqual(4.5);
  });

  it("focus ring (primary) is visible against the page and panels ≥ 3:1", () => {
    for (const bg of [background, panel80, secondary]) {
      expect(contrastRatio(rgb("primary"), bg)).toBeGreaterThanOrEqual(3);
    }
  });

  it("documents the hex equivalents used by the web app manifest", () => {
    expect(toHex(background)).toBe("#030713");
    expect(toHex(rgb("primary"))).toMatch(/^#[0-9a-f]{6}$/);
  });
});
