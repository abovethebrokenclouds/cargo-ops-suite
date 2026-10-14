// Display strings for decoded METAR fields (UI and tests share them).

import type { Wind } from "./metar";

const pad3 = (n: number) => String(Math.round(n) % 360 || (n > 0 ? 360 : 0)).padStart(3, "0");

export function formatWind(wind: Wind | null): string {
  if (!wind) return "—";
  if (wind.speedKt === 0) return "Calm";
  const dir = wind.directionDeg === null ? "VRB" : `${pad3(wind.directionDeg)}°`;
  const gust = wind.gustKt !== null ? ` G${wind.gustKt}` : "";
  const varying =
    wind.varyingFromDeg !== null && wind.varyingToDeg !== null
      ? ` (${pad3(wind.varyingFromDeg)}–${pad3(wind.varyingToDeg)}°)`
      : "";
  return `${dir} ${wind.speedKt}${gust} kt${varying}`;
}

export function formatVisibility(sm: number | null, plus: boolean): string {
  if (sm === null) return "—";
  const whole = Math.floor(sm);
  const frac = sm - whole;
  const fractions: Array<[number, string]> = [
    [0.25, "1/4"],
    [0.5, "1/2"],
    [0.75, "3/4"],
  ];
  let text = Number.isInteger(sm) ? String(sm) : sm.toFixed(1).replace(/\.0$/, "");
  for (const [v, label] of fractions) {
    if (Math.abs(frac - v) < 0.01) text = whole > 0 ? `${whole} ${label}` : label;
  }
  return `${plus ? "≥ " : ""}${text} SM`;
}

export function formatCeiling(ceilingFt: number | null, skyKnown: boolean): string {
  if (!skyKnown) return "—";
  if (ceilingFt === null) return "None";
  return `${ceilingFt.toLocaleString("en-US")} ft`;
}

/** Observation age: "just now", "12 min", "2 h 05 min"; null when unknown. */
export function formatObservationAge(observedAt: string | null, now: number): string | null {
  if (!observedAt) return null;
  const t = Date.parse(observedAt);
  if (Number.isNaN(t)) return null;
  const min = Math.max(0, Math.floor((now - t) / 60_000));
  if (min < 1) return "just now";
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h >= 48) return `${Math.floor(h / 24)} d ago`;
  return `${h} h ${String(min % 60).padStart(2, "0")} min ago`;
}

/** METARs are hourly; one older than 90 minutes is flagged as old in the UI. */
export const METAR_OLD_AFTER_MIN = 90;

export function isObservationOld(observedAt: string | null, now: number): boolean {
  if (!observedAt) return false;
  const t = Date.parse(observedAt);
  return !Number.isNaN(t) && now - t > METAR_OLD_AFTER_MIN * 60_000;
}
