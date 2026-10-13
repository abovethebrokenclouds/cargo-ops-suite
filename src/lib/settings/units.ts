import { useCallback, useEffect, useState } from "react";

import { EMPTY, formatInt } from "@/lib/format";

// Per-browser display units (P6, /settings → Units). Stored in localStorage; every access is
// guarded (private mode, blocked storage, SSR). They change how Live Flight and the map show
// simulator readouts; the connector always stores and computes in its own units (feet, knots,
// pounds for telemetry, kilograms for cargo and the economy).

export const UNITS_KEY = "cargo-ops.units";
const CHANGE_EVENT = "cargo-ops:units";

export type WeightUnit = "lb" | "kg";
export type AltitudeUnit = "ft" | "m";
export type SpeedUnit = "kt";

export interface UnitPreferences {
  weight: WeightUnit;
  altitude: AltitudeUnit;
  /** Knots only: every aviation speed in the app is in knots. */
  speed: SpeedUnit;
}

export const DEFAULT_UNITS: UnitPreferences = { weight: "lb", altitude: "ft", speed: "kt" };

const LB_PER_KG = 2.2046226218;
const FT_PER_M = 3.28084;

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Parse a stored value; anything unknown falls back to the defaults field by field. */
export function parseUnits(raw: string | null | undefined): UnitPreferences {
  if (!raw) return { ...DEFAULT_UNITS };
  try {
    const v = JSON.parse(raw) as Partial<Record<keyof UnitPreferences, unknown>>;
    return {
      weight: v.weight === "kg" || v.weight === "lb" ? v.weight : DEFAULT_UNITS.weight,
      altitude: v.altitude === "m" || v.altitude === "ft" ? v.altitude : DEFAULT_UNITS.altitude,
      speed: "kt",
    };
  } catch {
    return { ...DEFAULT_UNITS };
  }
}

export function getUnits(): UnitPreferences {
  try {
    return parseUnits(storage()?.getItem(UNITS_KEY));
  } catch {
    return { ...DEFAULT_UNITS };
  }
}

export function setUnits(next: UnitPreferences): void {
  try {
    storage()?.setItem(UNITS_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

/** Pounds → the chosen weight unit. */
export function weightFromLb(lb: number, unit: WeightUnit): number {
  return unit === "kg" ? lb / LB_PER_KG : lb;
}

/** Feet → the chosen altitude unit. */
export function altitudeFromFt(ft: number, unit: AltitudeUnit): number {
  return unit === "m" ? ft / FT_PER_M : ft;
}

export function formatWeightLb(lb: number | null | undefined, unit: WeightUnit): string {
  if (lb === null || lb === undefined || !Number.isFinite(lb)) return EMPTY;
  return `${formatInt(weightFromLb(lb, unit))} ${unit}`;
}

export function formatAltitudeFt(ft: number | null | undefined, unit: AltitudeUnit): string {
  if (ft === null || ft === undefined || !Number.isFinite(ft)) return EMPTY;
  return `${formatInt(altitudeFromFt(ft, unit))} ${unit}`;
}

/**
 * [units, setUnits]. Defaults during SSR and the first client render (so markup matches),
 * then the stored choice; follows changes from other tabs.
 */
export function useUnits(): [UnitPreferences, (next: UnitPreferences) => void] {
  const [units, set] = useState<UnitPreferences>(DEFAULT_UNITS);
  useEffect(() => {
    const sync = () => set(getUnits());
    sync();
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const update = useCallback((next: UnitPreferences) => setUnits(next), []);
  return [units, update];
}
