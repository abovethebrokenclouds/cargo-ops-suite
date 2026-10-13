// Number formatters for cockpit-style readouts. All output is locale-stable (en-US) so
// tabular numerals line up and tests are deterministic. Non-finite input renders "—".

export const EMPTY = "—";

const intFormat = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });
const usdFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function finite(n: number | null | undefined): n is number {
  return typeof n === "number" && Number.isFinite(n);
}

/** Integer with thousands separators: 12345.6 → "12,346". */
export function formatInt(n: number | null | undefined): string {
  if (!finite(n)) return EMPTY;
  // Avoid "-0" after rounding small negatives.
  const r = Math.round(n);
  return intFormat.format(r === 0 ? 0 : r);
}

/** Altitude in feet: 35000 → "35,000 ft". */
export function formatFeet(n: number | null | undefined): string {
  return finite(n) ? `${formatInt(n)} ft` : EMPTY;
}

/** Speed in knots: 248.4 → "248 kt". */
export function formatKnots(n: number | null | undefined): string {
  return finite(n) ? `${formatInt(n)} kt` : EMPTY;
}

/** Vertical speed with explicit sign: 1200 → "+1,200 fpm", -800 → "−800 fpm", 0 → "0 fpm". */
export function formatFpm(n: number | null | undefined): string {
  if (!finite(n)) return EMPTY;
  const r = Math.round(n);
  if (r === 0) return "0 fpm";
  const sign = r > 0 ? "+" : "−";
  return `${sign}${intFormat.format(Math.abs(r))} fpm`;
}

/** Heading/bearing, normalised to 0–359 and zero-padded: 5 → "005°", 360 → "000°". */
export function formatDegrees(n: number | null | undefined): string {
  if (!finite(n)) return EMPTY;
  const d = ((Math.round(n) % 360) + 360) % 360;
  return `${String(d).padStart(3, "0")}°`;
}

/** Whole US dollars: 248500 → "$248,500", -1200 → "-$1,200". */
export function formatUsd(n: number | null | undefined): string {
  if (!finite(n)) return EMPTY;
  const r = Math.round(n);
  return usdFormat.format(r === 0 ? 0 : r);
}

const usdCentsFormat = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** Dollars and cents: 541.236 → "$541.24", -300 → "-$300.00". */
export function formatUsdCents(n: number | null | undefined): string {
  if (!finite(n)) return EMPTY;
  return usdCentsFormat.format(Math.abs(n) < 0.005 ? 0 : n);
}

/** Duration from minutes: 83 → "1h 23m", 45 → "45m", 120 → "2h 00m". */
export function formatMinutes(n: number | null | undefined): string {
  if (!finite(n)) return EMPTY;
  const total = Math.max(0, Math.round(n));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function dms(value: number, pos: string, neg: string, degWidth: number): string {
  const hemi = value < 0 ? neg : pos;
  const abs = Math.abs(value);
  let deg = Math.floor(abs);
  let min = Math.round((abs - deg) * 60 * 100) / 100;
  if (min >= 60) {
    deg += 1;
    min = 0;
  }
  return `${hemi}${String(deg).padStart(degWidth, "0")}°${min.toFixed(2).padStart(5, "0")}′`;
}

/** Latitude in degrees and decimal minutes: 35.0424 → "N35°02.54′". */
export function formatLat(n: number | null | undefined): string {
  if (!finite(n) || Math.abs(n) > 90) return EMPTY;
  return dms(n, "N", "S", 2);
}

/** Longitude in degrees and decimal minutes: -89.9767 → "W089°58.60′". */
export function formatLon(n: number | null | undefined): string {
  if (!finite(n) || Math.abs(n) > 180) return EMPTY;
  return dms(n, "E", "W", 3);
}

/** Position pair: "N35°02.54′ W089°58.60′". */
export function formatLatLon(lat: number | null | undefined, lon: number | null | undefined) {
  const a = formatLat(lat);
  const b = formatLon(lon);
  return a === EMPTY || b === EMPTY ? EMPTY : `${a} ${b}`;
}
