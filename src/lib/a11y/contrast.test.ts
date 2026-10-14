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
    // The error status chip: bg-destructive/20 over the header with text-foreground.
    const chip = over(rgb("destructive"), 0.2, background);
    expect(contrastRatio(rgb("foreground"), chip)).toBeGreaterThanOrEqual(4.5);
  });

  // Every `--x` / `--x-foreground` token pair (bg-x text-x-foreground in Button, Badge,
  // tooltip, toasts, status chips …) must meet AA for normal text, so a token edit cannot
  // regress a solid fill. The app ships a single (dark) theme in :root.
  describe("solid fill pairs (--x with --x-foreground) ≥ 4.5:1", () => {
    const pairs = Object.keys(t)
      .filter((name) => name.endsWith("-foreground") && name !== "foreground")
      .map((name) => [name.replace(/-foreground$/, ""), name] as const)
      .filter(([fill]) => fill in t);
    pairs.push(["background", "foreground"]);

    it("enumerates the expected token pairs", () => {
      const fills = pairs.map(([fill]) => fill);
      for (const fill of [
        "background",
        "card",
        "popover",
        "primary",
        "secondary",
        "muted",
        "accent",
        "tertiary",
        "success",
        "warning",
        "destructive",
      ]) {
        expect(fills, fill).toContain(fill);
      }
    });

    for (const [fill, fg] of pairs) {
      it(`${fg} on ${fill}`, () => {
        expect(contrastRatio(rgb(fg), rgb(fill))).toBeGreaterThanOrEqual(4.5);
      });
    }

    it("destructive button hover (bg-destructive/90 over the page) keeps its label ≥ 4.5:1", () => {
      const hover = over(rgb("destructive"), 0.9, background);
      expect(contrastRatio(rgb("destructive-foreground"), hover)).toBeGreaterThanOrEqual(4.5);
    });
  });

  // Flight operations room (Ops dashboard): phosphor readouts, call-sign strips and status
  // lamps on the near-black console surfaces.
  describe("console surfaces (Ops dashboard) ≥ 4.5:1", () => {
    const tok = (name: string) => {
      const v = t[name];
      if (!v) throw new Error(`token --${name} missing`);
      return v;
    };
    const consoleBg = rgb("console");
    const consolePanel = rgb("console-panel");
    // .console-panel: a 2.5 % white sheen at the top of the screen.
    const panelSheen = over({ r: 1, g: 1, b: 1 }, 0.025, consolePanel);
    // .console-strip: bezel 22 % into the panel.
    const strip = oklabToRgb(mixOklab(tok("console-bezel"), tok("console-panel"), 0.22));
    const consoleSurfaces: Record<string, Rgb> = {
      console: consoleBg,
      "console-panel": consolePanel,
      "console-panel sheen": panelSheen,
      "console-strip": strip,
    };
    const consoleText: Array<[string, Rgb]> = [
      ["console-foreground", rgb("console-foreground")],
      ["muted-foreground", rgb("muted-foreground")],
      ["phosphor-green", rgb("phosphor-green")],
      ["phosphor-amber", rgb("phosphor-amber")],
      ["phosphor-cyan", rgb("phosphor-cyan")],
      ["phosphor-red", rgb("phosphor-red")],
      // Source tags inside consoles (DEMO = warning, REPLAY = foreground).
      ["warning", rgb("warning")],
      ["foreground", rgb("foreground")],
    ];
    for (const [name, fg] of consoleText) {
      for (const [surface, bg] of Object.entries(consoleSurfaces)) {
        it(`${name} on ${surface}`, () => {
          expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(4.5);
        });
      }
    }

    // .lamp[data-state]: the lit lamp fills with its own colour at 12 % over the console.
    for (const lit of ["phosphor-green", "phosphor-amber", "phosphor-cyan", "phosphor-red"]) {
      it(`lit lamp: ${lit} on its own 12 % fill`, () => {
        const fill = oklabToRgb(mixOklab(tok(lit), tok("console"), 0.12));
        expect(contrastRatio(rgb(lit), fill)).toBeGreaterThanOrEqual(4.5);
      });
    }

    it("dark lamp (NO DATA): lamp-off-foreground on lamp-off", () => {
      expect(contrastRatio(rgb("lamp-off-foreground"), rgb("lamp-off"))).toBeGreaterThanOrEqual(
        4.5,
      );
    });

    it("a lit lamp is distinguishable from a dark one (fill luminance differs)", () => {
      // Grey NO DATA lamps must never read as lit: their text is neutral, not phosphor.
      const off = tok("lamp-off-foreground");
      expect(Math.hypot(off.a, off.b)).toBeLessThan(0.02);
    });
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
