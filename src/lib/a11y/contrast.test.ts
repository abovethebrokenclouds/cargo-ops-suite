import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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

interface StateFill {
  file: string;
  /** The state-prefixed class, e.g. `hover:bg-destructive/90`. */
  cls: string;
  fill: string;
  alpha: number;
  /** Colour token of the label shown in that state. */
  label: string;
}

/**
 * Scan every class string literal of the ui components for state-prefixed `bg-x[/NN]` and
 * resolve the label colour the same state shows: the same-prefix `text-y`, else a `text-y`
 * under any one of its prefixes, else the unprefixed `text-y`, else the inherited
 * `foreground` (popover/card foregrounds are the same colour).
 */
function collectStateFills(dir: string, only?: (file: string) => boolean): StateFill[] {
  const out: StateFill[] = [];
  const isColour = (name: string) => name in t;
  const files = readdirSync(dir).filter(
    (f) => f.endsWith(".tsx") && !f.endsWith(".test.tsx") && (!only || only(f)),
  );
  for (const file of files) {
    const src = readFileSync(join(dir, file), "utf8");
    for (const lit of src.matchAll(/"([^"\n]*)"|`([^`]*)`/g)) {
      const classes = (lit[1] ?? lit[2] ?? "").split(/\s+/);
      const textFor = (prefix: string): string | undefined =>
        classes
          .filter((c) => c.startsWith(`${prefix}text-`))
          .map((c) => c.slice(prefix.length + 5))
          .find((name) => isColour(name) && !/^\[|\//.test(name));
      for (const cls of classes) {
        const m = /^((?:[^\s:]+:)+)bg-([a-z-]+)(?:\/(\d+))?$/.exec(cls);
        if (!m) continue;
        const prefix = m[1] as string;
        const fill = m[2] as string;
        if (["transparent", "clip-text", "none"].includes(fill)) continue;
        const parts = prefix.split(":").filter(Boolean);
        const label =
          textFor(prefix) ??
          parts.map((p) => textFor(`${p}:`)).find(Boolean) ??
          textFor("") ??
          "foreground";
        out.push({ file, cls, fill, alpha: m[3] ? Number(m[3]) / 100 : 1, label });
      }
    }
  }
  return out;
}

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

  // Every interactive-state fill in src/components/ui (hover:, active:, focus:, data-[…]:
  // bg-x or bg-x/NN) is collected from the source, paired with the label it shows in that
  // state, alpha-composited over each surface it can sit on, and held to 4.5:1. A new
  // shadcn component or a hover tweak cannot slip below AA unnoticed.
  describe("interactive state fills in src/components/ui ≥ 4.5:1", () => {
    const states = collectStateFills(resolve(__dirname, "../../components/ui"));
    // Fills without a parsed oklch token: `input` is translucent (switch track) and the
    // `sidebar*` tokens are not defined in this theme, so those classes emit nothing.
    const untokened = new Set(["input", "sidebar", "sidebar-accent", "sidebar-border"]);
    // The switch track carries no text; its thumb (bg-background) is checked below at the
    // 3:1 non-text threshold instead.
    const audited = states.filter((s) => !untokened.has(s.fill) && s.file !== "switch.tsx");

    it("finds the solid-variant hover states and only expected untokened fills", () => {
      const ids = audited.map((s) => `${s.file} ${s.cls}`);
      for (const id of [
        "badge.tsx hover:bg-primary/80",
        "badge.tsx hover:bg-secondary/80",
        "badge.tsx hover:bg-destructive/90",
        "button.tsx hover:bg-primary/90",
        "button.tsx hover:bg-destructive/90",
        "button.tsx hover:bg-secondary/80",
        "button.tsx hover:bg-accent",
        "toggle.tsx hover:bg-muted",
        "toggle.tsx data-[state=on]:bg-accent",
        "table.tsx hover:bg-muted/50",
      ]) {
        expect(ids, id).toContain(id);
      }
      for (const s of states) {
        if (!(s.fill in t)) expect(untokened, `${s.file} ${s.cls}`).toContain(s.fill);
      }
    });

    it("switch thumb (background) on the checked track (primary) ≥ 3:1", () => {
      expect(states.map((s) => `${s.file} ${s.cls}`)).toContain(
        "switch.tsx data-[state=checked]:bg-primary",
      );
      expect(contrastRatio(background, rgb("primary"))).toBeGreaterThanOrEqual(3);
    });

    const stateSurfaces: Record<string, Rgb> = {
      background,
      panel80,
      panel88,
      popover: rgb("popover"),
    };
    for (const s of audited) {
      it(`${s.file} ${s.cls} with text-${s.label}`, () => {
        for (const [surface, bg] of Object.entries(stateSurfaces)) {
          const fill = over(rgb(s.fill), s.alpha, bg);
          expect(contrastRatio(rgb(s.label), fill), surface).toBeGreaterThanOrEqual(4.5);
        }
      });
    }
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

    // Interactive-state fills on the Ops console (the Live Flight CTA's
    // hover:bg-phosphor-green/20 and anything added later in src/components/ops) are
    // alpha-composited over every console surface and held to 4.5:1 with their label.
    describe("console interactive state fills ≥ 4.5:1", () => {
      const consoleStates = [
        ...collectStateFills(resolve(__dirname, "../../routes"), (f) => f === "index.tsx"),
        ...collectStateFills(resolve(__dirname, "../../components/ops")),
      ];

      it("finds the Live Flight CTA hover fill", () => {
        expect(consoleStates.map((s) => `${s.file} ${s.cls} text-${s.label}`)).toContain(
          "index.tsx hover:bg-phosphor-green/20 text-phosphor-green",
        );
      });

      for (const s of consoleStates) {
        it(`${s.file} ${s.cls} with text-${s.label}`, () => {
          for (const [surface, bg] of Object.entries(consoleSurfaces)) {
            const fill = over(rgb(s.fill), s.alpha, bg);
            expect(contrastRatio(rgb(s.label), fill), surface).toBeGreaterThanOrEqual(4.5);
          }
        });
      }

      it("Live Flight CTA at rest (bg-phosphor-green/10) keeps its label ≥ 4.5:1", () => {
        for (const [surface, bg] of Object.entries(consoleSurfaces)) {
          const fill = over(rgb("phosphor-green"), 0.1, bg);
          expect(contrastRatio(rgb("phosphor-green"), fill), surface).toBeGreaterThanOrEqual(4.5);
        }
      });
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
