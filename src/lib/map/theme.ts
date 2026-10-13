// Map colours come from the app's CSS design tokens (src/styles.css), read at runtime.
// MapLibre's colour parser does not understand oklch(), so tokens are converted to
// rgba() strings here. No colour values are defined in this module or in components.

export interface Rgba {
  /** 0–255 */
  r: number;
  g: number;
  b: number;
  /** 0–1 */
  a: number;
}

export const MAP_TOKENS = [
  "background",
  "foreground",
  "card",
  "secondary",
  "muted-foreground",
  "primary",
  "accent",
  "tertiary",
  "border",
  "success",
  "warning",
  "destructive",
] as const;
export type MapToken = (typeof MAP_TOKENS)[number];
export type MapTheme = Record<MapToken, Rgba>;

const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

function parseNumber(token: string | undefined, percentScale: number): number | null {
  if (token === undefined) return null;
  const t = token.trim();
  if (t === "none") return 0;
  const pct = t.endsWith("%");
  const n = Number(pct ? t.slice(0, -1) : t);
  if (!Number.isFinite(n)) return null;
  return pct ? (n / 100) * percentScale : n;
}

function srgbGamma(x: number): number {
  const v = x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  return Math.round(clamp01(v) * 255);
}

/** OKLCH (L 0–1, C, H degrees) to sRGB, clipped to gamut. */
export function oklchToRgba(l: number, c: number, h: number, alpha = 1): Rgba {
  const hr = (h * Math.PI) / 180;
  const A = c * Math.cos(hr);
  const B = c * Math.sin(hr);
  const l_ = (l + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m_ = (l - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const s_ = (l - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return {
    r: srgbGamma(4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_),
    g: srgbGamma(-1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_),
    b: srgbGamma(-0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_),
    a: clamp01(alpha),
  };
}

/** Split "a b c / d" or "a, b, c, d" into channel tokens and an optional alpha. */
function channels(body: string): { parts: string[]; alpha: string | undefined } {
  const [main = "", alpha] = body.split("/");
  const parts = main.includes(",")
    ? main.split(",").map((p) => p.trim())
    : main.trim().split(/\s+/);
  if (alpha === undefined && parts.length === 4) {
    return { parts: parts.slice(0, 3), alpha: parts[3] };
  }
  return { parts, alpha };
}

/** Parse oklch(), rgb()/rgba() or #hex. Returns null for anything else. */
export function parseCssColor(value: string): Rgba | null {
  const v = value.trim().toLowerCase();
  if (v === "transparent") return TRANSPARENT;
  const hex = /^#([0-9a-f]{3,8})$/.exec(v)?.[1];
  if (hex) {
    const full =
      hex.length === 3 || hex.length === 4
        ? hex
            .split("")
            .map((ch) => ch + ch)
            .join("")
        : hex;
    if (full.length !== 6 && full.length !== 8) return null;
    const n = (i: number) => parseInt(full.slice(i, i + 2), 16);
    return { r: n(0), g: n(2), b: n(4), a: full.length === 8 ? n(6) / 255 : 1 };
  }
  const fn = /^(oklch|rgba?)\((.*)\)$/.exec(v);
  if (!fn) return null;
  const [, name, body = ""] = fn;
  const { parts, alpha } = channels(body);
  if (parts.length !== 3) return null;
  const a = alpha === undefined ? 1 : parseNumber(alpha, 1);
  if (a === null) return null;
  if (name === "oklch") {
    const l = parseNumber(parts[0], 1);
    const c = parseNumber(parts[1], 0.4);
    const h = parseNumber(parts[2]?.replace(/deg$/, ""), 1);
    if (l === null || c === null || h === null) return null;
    return oklchToRgba(l, c, h, a);
  }
  const [r, g, b] = parts.map((p) => parseNumber(p, 255));
  if (r == null || g == null || b == null) return null;
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: clamp01(a) };
}

/** rgba() string MapLibre accepts. */
export function toCss(c: Rgba): string {
  const a = Math.round(c.a * 1000) / 1000;
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${a})`;
}

/** Linear blend in sRGB: t = 0 → a, t = 1 → b. Alpha blends too. */
export function mix(a: Rgba, b: Rgba, t: number): Rgba {
  const k = clamp01(t);
  return {
    r: a.r + (b.r - a.r) * k,
    g: a.g + (b.g - a.g) * k,
    b: a.b + (b.b - a.b) * k,
    a: a.a + (b.a - a.a) * k,
  };
}

export function withAlpha(c: Rgba, alpha: number): Rgba {
  return { ...c, a: clamp01(alpha) };
}

type StyleSource = { getPropertyValue(name: string): string };

/** Resolve `var(--x)` chains (e.g. --ring: var(--primary)) against a computed style. */
export function resolveToken(style: StyleSource, name: string, depth = 0): string {
  const raw = style.getPropertyValue(`--${name}`).trim();
  const ref = /^var\(--([a-z0-9-]+)\)$/i.exec(raw)?.[1];
  if (ref && depth < 4) return resolveToken(style, ref, depth + 1);
  return raw;
}

/**
 * Read every map token from computed styles. Missing or unparseable tokens become
 * transparent (e.g. in tests without the stylesheet), never an invented colour.
 */
export function readMapTheme(style?: StyleSource): MapTheme {
  const source: StyleSource =
    style ??
    (typeof window !== "undefined"
      ? window.getComputedStyle(document.documentElement)
      : { getPropertyValue: () => "" });
  const theme = {} as MapTheme;
  for (const token of MAP_TOKENS) {
    theme[token] = parseCssColor(resolveToken(source, token)) ?? TRANSPARENT;
  }
  return theme;
}
