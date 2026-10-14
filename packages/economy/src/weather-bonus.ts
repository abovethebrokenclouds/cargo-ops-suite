// Weather payout bonus (plan §7 conditions, docs/ECONOMY.md "Weather bonus").
//
// The METAR flight category is frozen at the origin when the mission departs and at the
// destination when it arrives. Flying into or out of IFR or LIFR earns a modest bonus on
// the conditions line: the larger of the two ends, never stacking beyond the cap.
//
// Only real, current weather counts. An end is eligible when ALL of these hold:
//   - the report is a live aviationweather.gov METAR (never a SAMPLE report);
//   - the telemetry is from the simulator (replays and the demo never earn it);
//   - the connector's copy is current: not stale (no failed refresh since), fetched at
//     most WEATHER_BONUS_MAX_FETCH_AGE_MIN before the check, observed at most
//     WEATHER_BONUS_MAX_OBS_AGE_MIN before the check;
//   - the flight category is known.
// Anything else is "unknown": no bonus and no penalty.

import type {
  MissionWeather,
  WeatherCheck,
  WEATHER_FLIGHT_CATEGORIES,
} from "../../protocol/src/economy";

type FlightCategory = (typeof WEATHER_FLIGHT_CATEGORIES)[number];

/** Bonus per flight category (VFR and MVFR earn nothing). */
export const WEATHER_BONUS: Readonly<Record<FlightCategory, number>> = {
  VFR: 0,
  MVFR: 0,
  IFR: 0.05,
  LIFR: 0.1,
};
/** The weather bonus never exceeds this, whatever both ends report. */
export const WEATHER_BONUS_CAP = 0.1;
/** The connector's copy must have been fetched at most this long before the check. */
export const WEATHER_BONUS_MAX_FETCH_AGE_MIN = 15;
/** The observation must be at most this old at the check (METARs are hourly). */
export const WEATHER_BONUS_MAX_OBS_AGE_MIN = 90;

/** What the check needs from a METAR report (structurally a `MetarReport`). */
export interface WeatherReportInput {
  origin: "live" | "sample";
  category: FlightCategory | null;
  rawText: string;
  observedAt: string | null;
  fetchedAt: string;
  stale: boolean;
}

export interface WeatherCheckInput {
  stage: WeatherCheck["stage"];
  station: string;
  report: WeatherReportInput | null;
  /** Telemetry source of the session. */
  source: WeatherCheck["source"];
  /** Wall clock of the check, ms. */
  nowMs: number;
}

const ageMin = (iso: string | null, nowMs: number): number | null => {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? (nowMs - t) / 60_000 : null;
};

/** Freeze the weather at one end of a mission. Pure. */
export function checkWeather(input: WeatherCheckInput): WeatherCheck {
  const { stage, station, report, source, nowMs } = input;
  const where = `${station} ${stage === "departure" ? "at departure" : "at arrival"}`;
  const base = {
    stage,
    station,
    source,
    checkedAt: new Date(nowMs).toISOString(),
  };
  if (!report) {
    return {
      ...base,
      category: null,
      metarOrigin: null,
      rawText: null,
      observedAt: null,
      fetchedAt: null,
      eligible: false,
      message: `No METAR for ${where}: weather unknown, no bonus`,
    };
  }
  const category = report.category;
  const cat = category ?? "unknown";
  const out = {
    ...base,
    category,
    metarOrigin: report.origin,
    rawText: report.rawText,
    observedAt: report.observedAt,
    fetchedAt: report.fetchedAt,
  };
  const no = (why: string): WeatherCheck => ({
    ...out,
    eligible: false,
    message: `${cat} ${where}: ${why}`,
  });
  if (report.origin !== "live") return no("sample METAR, never a bonus");
  if (source !== "sim") return no(`${source} telemetry, no weather bonus`);
  if (report.stale) return no("report is stale, no bonus");
  const fetched = ageMin(report.fetchedAt, nowMs);
  if (fetched === null || fetched > WEATHER_BONUS_MAX_FETCH_AGE_MIN) {
    return no(`report fetched more than ${WEATHER_BONUS_MAX_FETCH_AGE_MIN} min ago, no bonus`);
  }
  const observed = ageMin(report.observedAt, nowMs);
  if (observed === null || observed > WEATHER_BONUS_MAX_OBS_AGE_MIN) {
    return no(`observation older than ${WEATHER_BONUS_MAX_OBS_AGE_MIN} min, no bonus`);
  }
  if (category === null) return no("flight category unknown, no bonus");
  const bonus = WEATHER_BONUS[category];
  return {
    ...out,
    eligible: true,
    message:
      bonus > 0
        ? `${category} ${where} (live METAR): +${Math.round(bonus * 100)} %`
        : `${category} ${where} (live METAR): no bonus for ${category}`,
  };
}

export interface WeatherBonus {
  /** Fraction added to the conditions line: 0, 0.05 or 0.10. */
  bonus: number;
  /** The end that set the bonus (null = none). */
  end: WeatherCheck | null;
  note: string;
}

/** The larger of the two eligible ends, capped at WEATHER_BONUS_CAP. Pure. */
export function weatherBonus(weather: MissionWeather | null | undefined): WeatherBonus {
  const ends = [weather?.departure, weather?.arrival].filter(
    (c): c is WeatherCheck => c !== undefined,
  );
  let best: WeatherCheck | null = null;
  let bonus = 0;
  for (const c of ends) {
    const b = c.eligible && c.category ? WEATHER_BONUS[c.category] : 0;
    if (b > bonus) {
      bonus = b;
      best = c;
    }
  }
  bonus = Math.min(WEATHER_BONUS_CAP, bonus);
  if (best) {
    return {
      bonus,
      end: best,
      note: `Weather: ${best.category} at ${best.station} ${best.stage === "departure" ? "departure" : "arrival"} (live METAR) +${Math.round(bonus * 100)} %`,
    };
  }
  if (ends.length === 0) {
    return { bonus: 0, end: null, note: "No weather recorded: no weather bonus" };
  }
  const known = ends.filter((c) => c.eligible);
  return {
    bonus: 0,
    end: null,
    note:
      known.length > 0
        ? `Weather: ${known.map((c) => `${c.category} at ${c.station}`).join(", ")}, no IFR/LIFR bonus`
        : "Weather unknown or not live: no weather bonus",
  };
}
