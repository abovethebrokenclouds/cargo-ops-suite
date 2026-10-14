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
//     WEATHER_BONUS_MAX_OBS_AGE_MIN before the check, and neither time more than
//     WEATHER_BONUS_MAX_FUTURE_MIN after it (a report from the future is not current);
//   - the flight category is known.
// Anything else is "unknown": no bonus and no penalty.
//
// The payout never trusts a stored `eligible` flag on its own: an end only counts when it is
// also recorded as sim telemetry with a live METAR and a known category (a forged or
// imported check claiming eligibility without them pays nothing).

import type {
  MissionWeather,
  WeatherBonusOutcome,
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
/** Clock skew tolerated: observation or fetch times further ahead than this are not current. */
export const WEATHER_BONUS_MAX_FUTURE_MIN = 5;

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
    stale: report.stale,
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
  const observed = ageMin(report.observedAt, nowMs);
  if (
    (fetched !== null && fetched < -WEATHER_BONUS_MAX_FUTURE_MIN) ||
    (observed !== null && observed < -WEATHER_BONUS_MAX_FUTURE_MIN)
  ) {
    return no(`report time is in the future, not current, no bonus`);
  }
  if (fetched === null || fetched > WEATHER_BONUS_MAX_FETCH_AGE_MIN) {
    return no(`report fetched more than ${WEATHER_BONUS_MAX_FETCH_AGE_MIN} min ago, no bonus`);
  }
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

/**
 * An end may count toward the bonus: frozen as eligible AND recorded under sim telemetry
 * with a live METAR and a known category. The stored flag alone is never enough.
 */
export function weatherEndCounts(c: WeatherCheck | undefined): boolean {
  return (
    c !== undefined &&
    c.eligible &&
    c.source === "sim" &&
    c.metarOrigin === "live" &&
    c.category !== null
  );
}

/**
 * A mission's weather as read from outside (a career import): ends claiming eligibility
 * without sim telemetry, a live METAR and a known category are marked not eligible. Every
 * other recorded field is kept. Pure.
 */
export function trustedWeather<W extends MissionWeather | undefined>(weather: W): W {
  if (!weather) return weather;
  const fix = (c: WeatherCheck | undefined) =>
    c && c.eligible && !weatherEndCounts(c) ? { ...c, eligible: false } : c;
  const out: MissionWeather = { ...weather };
  if (weather.departure) out.departure = fix(weather.departure);
  if (weather.arrival) out.arrival = fix(weather.arrival);
  if (weather.chain) {
    out.chain = { ...weather.chain };
    if (weather.chain.departure) out.chain.departure = fix(weather.chain.departure);
    if (weather.chain.arrival) out.chain.arrival = fix(weather.chain.arrival);
  }
  return out as W;
}

/** The larger of the two counting ends, capped at WEATHER_BONUS_CAP. Pure. */
export function weatherBonus(weather: MissionWeather | null | undefined): WeatherBonus {
  const ends = [weather?.departure, weather?.arrival].filter(
    (c): c is WeatherCheck => c !== undefined,
  );
  let best: WeatherCheck | null = null;
  let bonus = 0;
  for (const c of ends) {
    const b = weatherEndCounts(c) && c.category ? WEATHER_BONUS[c.category] : 0;
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
  const known = ends.filter((c) => weatherEndCounts(c));
  return {
    bonus: 0,
    end: null,
    note:
      known.length > 0
        ? `Weather: ${known.map((c) => `${c.category} at ${c.station}`).join(", ")}, no IFR/LIFR bonus`
        : "Weather unknown or not live: no weather bonus",
  };
}

export interface WeatherOutcome {
  outcome: WeatherBonusOutcome;
  /** Fraction actually paid (0 unless applied). */
  bonus: number;
  /** The counted end that set the bonus (applied or withheld). */
  bonusFrom?: WeatherCheck["stage"];
}

/**
 * What a delivery records about the weather bonus, from the ends the payout counted (the
 * chain's ends on a final transit leg) and whether bonuses were removed. Pure.
 */
export function weatherOutcome(
  counted: MissionWeather,
  terms: { noBonus: boolean; payloadMismatch: boolean },
): WeatherOutcome {
  const wx = weatherBonus(counted);
  if (wx.bonus > 0 && wx.end) {
    const outcome: WeatherBonusOutcome = terms.payloadMismatch
      ? "withheld_payload"
      : terms.noBonus
        ? "withheld_rate"
        : "applied";
    return { outcome, bonus: outcome === "applied" ? wx.bonus : 0, bonusFrom: wx.end.stage };
  }
  const anyLive = [counted.departure, counted.arrival].some((c) => weatherEndCounts(c));
  return { outcome: anyLive ? "no_ifr" : "not_live", bonus: 0 };
}
