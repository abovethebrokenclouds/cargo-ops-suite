import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MAP_TOKENS,
  mix,
  oklchToRgba,
  parseCssColor,
  readMapTheme,
  resolveToken,
  toCss,
  withAlpha,
} from "./theme";

describe("oklch conversion", () => {
  it("maps white, black and grey", () => {
    expect(oklchToRgba(1, 0, 0)).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(oklchToRgba(0, 0, 0)).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    const grey = oklchToRgba(0.5, 0, 0);
    expect(grey.r).toBe(grey.g);
    expect(grey.g).toBe(grey.b);
  });

  it("matches reference sRGB values for pure primaries", () => {
    // oklch of #ff0000 and #0000ff from the CSS Color 4 reference.
    const red = oklchToRgba(0.62796, 0.25768, 29.2339);
    expect(red.r).toBe(255);
    expect(red.g).toBeLessThanOrEqual(1);
    expect(red.b).toBeLessThanOrEqual(1);
    const blue = oklchToRgba(0.45201, 0.31321, 264.052);
    expect(blue.b).toBe(255);
    expect(blue.r).toBeLessThanOrEqual(1);
  });

  it("turns the app's midnight navy background into a dark blue", () => {
    const bg = parseCssColor("oklch(0.13 0.03 262)");
    expect(bg).not.toBeNull();
    if (!bg) return;
    expect(bg.b).toBeGreaterThan(bg.r);
    expect(bg.b).toBeLessThan(50);
    expect(bg.a).toBe(1);
  });
});

describe("parseCssColor", () => {
  it("parses oklch with alpha in percent or number", () => {
    expect(parseCssColor("oklch(0.85 0.04 255 / 10%)")?.a).toBeCloseTo(0.1, 6);
    expect(parseCssColor("oklch(85% 0.04 255 / 0.5)")?.a).toBeCloseTo(0.5, 6);
    expect(parseCssColor("oklch(0.85 0.04 255deg)")).not.toBeNull();
  });
  it("parses rgb(), rgba() and hex", () => {
    expect(parseCssColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseCssColor("rgba(10, 20, 30, 0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseCssColor("rgb(10 20 30 / 25%)")).toEqual({ r: 10, g: 20, b: 30, a: 0.25 });
    expect(parseCssColor("#0a141e")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseCssColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });
  it("returns null for unsupported values", () => {
    expect(parseCssColor("")).toBeNull();
    expect(parseCssColor("color-mix(in oklab, red, blue)")).toBeNull();
    expect(parseCssColor("oklch(0.5 0.1)")).toBeNull();
  });
});

describe("helpers", () => {
  it("formats rgba() strings MapLibre accepts", () => {
    expect(toCss({ r: 1.4, g: 2.6, b: 3, a: 0.12345 })).toBe("rgba(1, 3, 3, 0.123)");
  });
  it("mixes and sets alpha", () => {
    const a = { r: 0, g: 0, b: 0, a: 1 };
    const b = { r: 200, g: 100, b: 50, a: 0 };
    expect(mix(a, b, 0.5)).toEqual({ r: 100, g: 50, b: 25, a: 0.5 });
    expect(mix(a, b, 2)).toEqual(b);
    expect(withAlpha(a, 0.3).a).toBe(0.3);
  });
});

describe("readMapTheme", () => {
  it("resolves var() chains", () => {
    const vars: Record<string, string> = { "--ring": "var(--primary)", "--primary": "#123456" };
    const style = { getPropertyValue: (n: string) => vars[n] ?? "" };
    expect(resolveToken(style, "ring")).toBe("#123456");
  });

  it("reads every map token from the real stylesheet", () => {
    const css = readFileSync(resolve(__dirname, "../../styles.css"), "utf8");
    const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
    const vars: Record<string, string> = {};
    for (const m of root.matchAll(/(--[a-z0-9-]+):\s*([^;]+);/g)) {
      if (m[1] && m[2]) vars[m[1]] = m[2].trim();
    }
    const theme = readMapTheme({ getPropertyValue: (n) => vars[n] ?? "" });
    for (const token of MAP_TOKENS) {
      expect(theme[token].a, token).toBeGreaterThan(0);
    }
    // Accent (cyan) is lighter and greener than primary (electric blue).
    expect(theme.accent.g).toBeGreaterThan(theme.primary.g);
    // Tertiary is violet: red and blue above green.
    expect(theme.tertiary.r).toBeGreaterThan(theme.tertiary.g);
    expect(theme.tertiary.b).toBeGreaterThan(theme.tertiary.g);
  });

  it("falls back to transparent when tokens are missing", () => {
    const theme = readMapTheme({ getPropertyValue: () => "" });
    expect(theme.primary).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});
