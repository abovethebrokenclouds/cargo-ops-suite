// WCAG 2.x contrast for the design tokens (P6 accessibility pass). Tokens are oklch() in
// src/styles.css; `color-mix(in oklab, …)` utilities are reproduced by mixing in OKLab.
// Used by contrast.test.ts, which fails when a text/background pair drops below AA.

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

export interface Oklab {
  l: number;
  a: number;
  b: number;
}

export function oklchToOklab(l: number, c: number, h: number): Oklab {
  const hr = (h * Math.PI) / 180;
  return { l, a: c * Math.cos(hr), b: c * Math.sin(hr) };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function gamma(x: number): number {
  return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
}

/** OKLab → sRGB channels 0–1, clipped to gamut. */
export function oklabToRgb({ l, a, b }: Oklab): Rgb {
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return {
    r: clamp01(gamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_)),
    g: clamp01(gamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_)),
    b: clamp01(gamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_)),
  };
}

/** `color-mix(in oklab, x p, y)`: p is the share of x (0–1). */
export function mixOklab(x: Oklab, y: Oklab, p: number): Oklab {
  return { l: x.l * p + y.l * (1 - p), a: x.a * p + y.a * (1 - p), b: x.b * p + y.b * (1 - p) };
}

/** Composite a colour with `alpha` over an opaque background (sRGB, as browsers do). */
export function over(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return {
    r: fg.r * alpha + bg.r * (1 - alpha),
    g: fg.g * alpha + bg.g * (1 - alpha),
    b: fg.b * alpha + bg.b * (1 - alpha),
  };
}

function linear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance({ r, g, b }: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export function toHex({ r, g, b }: Rgb): string {
  const h = (x: number) =>
    Math.round(clamp01(x) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** Read `--name: oklch(L C H)` declarations from the first `:root { … }` block of a stylesheet. */
export function readOklchTokens(css: string): Record<string, Oklab> {
  const root = /:root\s*\{([\s\S]*?)\n\}/.exec(css)?.[1] ?? "";
  const out: Record<string, Oklab> = {};
  const re = /--([a-z-]+):\s*oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)\s*;/g;
  for (const m of root.matchAll(re)) {
    out[m[1] as string] = oklchToOklab(Number(m[2]), Number(m[3]), Number(m[4]));
  }
  return out;
}
