import { describe, expect, it } from "vitest";
import type { MissionWeather, WeatherCheck } from "@cargo-ops/protocol";
import {
  checkWeather,
  computePayout,
  WEATHER_BONUS_CAP,
  WEATHER_BONUS_MAX_FETCH_AGE_MIN,
  WEATHER_BONUS_MAX_OBS_AGE_MIN,
  trustedWeather,
  weatherBonus,
  weatherOutcome,
  type WeatherReportInput,
} from "../src/index";

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function report(
  category: WeatherReportInput["category"],
  over: Partial<WeatherReportInput> = {},
): WeatherReportInput {
  return {
    origin: "live",
    category,
    rawText: "KXYZ 141153Z 00000KT 1/2SM FG VV002 09/09 A3012",
    observedAt: iso(7),
    fetchedAt: iso(3),
    stale: false,
    ...over,
  };
}

function check(
  stage: WeatherCheck["stage"],
  category: WeatherReportInput["category"],
  over: Partial<WeatherReportInput> = {},
  source: WeatherCheck["source"] = "sim",
): WeatherCheck {
  return checkWeather({
    stage,
    station: stage === "departure" ? "KMEM" : "KATL",
    report: report(category, over),
    source,
    nowMs: NOW,
  });
}

/** Worked example 1 of docs/ECONOMY.md (500 kg, 100 nm, tier 2, landing B) with weather. */
function example1(weather: MissionWeather | null, extra: { noBonus?: boolean } = {}) {
  return computePayout({
    kind: "cargo",
    weightKg: 500,
    distanceNm: 100,
    units: 1,
    reputation: 50,
    estimate: false,
    landingGrade: "B",
    lateMin: 0,
    weather,
    ...extra,
  });
}

describe("checkWeather: which reports may count", () => {
  it("a live, current IFR/LIFR report under sim telemetry is eligible", () => {
    const c = check("departure", "IFR");
    expect(c.eligible).toBe(true);
    expect(c.category).toBe("IFR");
    expect(c.metarOrigin).toBe("live");
    expect(c.source).toBe("sim");
    expect(c.message).toBe("IFR KMEM at departure (live METAR): +5 %");
    expect(c.checkedAt).toBe(new Date(NOW).toISOString());
  });

  it("sample reports never count", () => {
    const c = check("departure", "LIFR", { origin: "sample" });
    expect(c.eligible).toBe(false);
    expect(c.message).toMatch(/sample METAR, never a bonus/);
  });

  it("replay and demo telemetry never count, even with a live report", () => {
    expect(check("arrival", "LIFR", {}, "replay").eligible).toBe(false);
    expect(check("arrival", "LIFR", {}, "demo").eligible).toBe(false);
  });

  it("stale, old or unknown reports do not count", () => {
    const stale = check("departure", "LIFR", { stale: true });
    expect(stale.eligible).toBe(false);
    // The frozen check records that the report was stale, so the UI can say so.
    expect(stale.stale).toBe(true);
    expect(check("departure", "LIFR").stale).toBe(false);
    expect(
      check("departure", "LIFR", { fetchedAt: iso(WEATHER_BONUS_MAX_FETCH_AGE_MIN + 1) }).eligible,
    ).toBe(false);
    expect(
      check("departure", "LIFR", { fetchedAt: iso(WEATHER_BONUS_MAX_FETCH_AGE_MIN) }).eligible,
    ).toBe(true);
    expect(
      check("departure", "LIFR", { observedAt: iso(WEATHER_BONUS_MAX_OBS_AGE_MIN + 1) }).eligible,
    ).toBe(false);
    expect(check("departure", "LIFR", { observedAt: null }).eligible).toBe(false);
    expect(check("departure", null).eligible).toBe(false);
  });

  it("no report: category unknown, nothing invented", () => {
    const c = checkWeather({
      stage: "arrival",
      station: "KATL",
      report: null,
      source: "sim",
      nowMs: NOW,
    });
    expect(c).toMatchObject({
      category: null,
      metarOrigin: null,
      rawText: null,
      eligible: false,
    });
    expect(c.message).toMatch(/No METAR for KATL at arrival/);
  });
});

describe("weatherBonus: max of the two ends, capped", () => {
  it("VFR/MVFR earn nothing; IFR 5 %; LIFR 10 %", () => {
    expect(weatherBonus({ departure: check("departure", "VFR") }).bonus).toBe(0);
    expect(weatherBonus({ departure: check("departure", "MVFR") }).bonus).toBe(0);
    expect(weatherBonus({ departure: check("departure", "IFR") }).bonus).toBe(0.05);
    expect(weatherBonus({ arrival: check("arrival", "LIFR") }).bonus).toBe(0.1);
  });

  it("takes the larger end and never stacks beyond the cap", () => {
    const both = weatherBonus({
      departure: check("departure", "LIFR"),
      arrival: check("arrival", "LIFR"),
    });
    expect(both.bonus).toBe(WEATHER_BONUS_CAP);
    const mixed = weatherBonus({
      departure: check("departure", "IFR"),
      arrival: check("arrival", "LIFR"),
    });
    expect(mixed.bonus).toBe(0.1);
    expect(mixed.end?.stage).toBe("arrival");
    expect(mixed.note).toBe("Weather: LIFR at KATL arrival (live METAR) +10 %");
  });

  it("an ineligible end is ignored, unknown weather is no bonus", () => {
    const wb = weatherBonus({
      departure: check("departure", "LIFR", { origin: "sample" }),
      arrival: check("arrival", "IFR"),
    });
    expect(wb.bonus).toBe(0.05);
    expect(weatherBonus(null).bonus).toBe(0);
    expect(weatherBonus({}).note).toBe("No weather recorded: no weather bonus");
  });
});

describe("worked examples (docs/ECONOMY.md, weather bonus)", () => {
  it("W1: example 1 with live IFR at departure → × 1.05 → $1,383", () => {
    const b = example1({ departure: check("departure", "IFR"), arrival: check("arrival", "VFR") });
    // 1,266.06 × 1.05 × 1.04 = 1,382.54
    expect(b.gross).toBe(1382.54);
    expect(b.total).toBe(1383);
    expect(b.factors.find((f) => f.key === "conditions")?.value).toBe(1.05);
    expect(b.weatherBonus).toBe(0.05);
    expect(b.noBonus).toBe(false);
  });

  it("W2: IFR out, LIFR in → the larger end, × 1.10 → $1,448", () => {
    const b = example1({ departure: check("departure", "IFR"), arrival: check("arrival", "LIFR") });
    // 1,266.06 × 1.10 × 1.04 = 1,448.38
    expect(b.gross).toBe(1448.38);
    expect(b.total).toBe(1448);
  });

  it("W3: LIFR at both ends still × 1.10 (cap, no stacking) → $1,448", () => {
    const b = example1({
      departure: check("departure", "LIFR"),
      arrival: check("arrival", "LIFR"),
    });
    expect(b.total).toBe(1448);
  });

  it("W4: LIFR with sim rate above 1× (noBonus) → conditions 1.00 → $1,266", () => {
    const b = example1(
      { departure: check("departure", "LIFR"), arrival: check("arrival", "LIFR") },
      { noBonus: true },
    );
    expect(b.total).toBe(1266);
    const cond = b.factors.find((f) => f.key === "conditions");
    expect(cond?.value).toBe(1);
    expect(cond?.note).toMatch(/weather bonus \+10 % withheld/);
    expect(b.weatherBonus).toBeUndefined();
  });

  it("W5: SAMPLE LIFR and unknown weather pay exactly example 1 → $1,317", () => {
    const sample = example1({
      departure: check("departure", "LIFR", { origin: "sample" }),
      arrival: check("arrival", "LIFR", { origin: "sample" }),
    });
    expect(sample.total).toBe(1317);
    expect(sample.weatherBonus).toBeUndefined();
    expect(example1(null).total).toBe(1317);
  });

  it("W6: an underloaded departure (payloadMismatch) withholds the bonus → $1,266", () => {
    const b = computePayout({
      kind: "cargo",
      weightKg: 500,
      distanceNm: 100,
      units: 1,
      reputation: 50,
      estimate: false,
      landingGrade: "B",
      lateMin: 0,
      payloadMismatch: true,
      weather: { departure: check("departure", "IFR") },
    });
    expect(b.total).toBe(1266);
    expect(b.payloadMismatch).toBe(true);
  });

  it("a board estimate never carries a weather bonus, in value or in note", () => {
    const weather: MissionWeather = {
      departure: check("departure", "LIFR"),
      arrival: check("arrival", "LIFR"),
    };
    const est = computePayout({
      kind: "cargo",
      weightKg: 500,
      distanceNm: 100,
      units: 1,
      reputation: 50,
      estimate: true,
      weather,
    });
    const plain = computePayout({
      kind: "cargo",
      weightKg: 500,
      distanceNm: 100,
      units: 1,
      reputation: 50,
      estimate: true,
    });
    const cond = est.factors.find((f) => f.key === "conditions");
    expect(cond?.value).toBe(1);
    expect(cond?.note).toMatch(/Estimate: no weather bonus/);
    expect(est.weatherBonus).toBeUndefined();
    expect(est.total).toBe(plain.total);
  });
});

describe("only sim + live + known category ever pays (a stored flag is not trusted)", () => {
  it("a forged check (demo telemetry, SAMPLE METAR, eligible: true) pays nothing", () => {
    const forged: WeatherCheck = {
      ...check("departure", "LIFR", { origin: "sample" }, "demo"),
      eligible: true,
    };
    expect(weatherBonus({ departure: forged }).bonus).toBe(0);
    expect(example1({ departure: forged }).total).toBe(1317);
    expect(example1({ departure: forged }).weatherBonus).toBeUndefined();
  });

  it("eligible: true is ignored for replay/demo telemetry, sample METARs or unknown categories", () => {
    const live = check("arrival", "LIFR");
    expect(weatherBonus({ arrival: live }).bonus).toBe(0.1);
    expect(weatherBonus({ arrival: { ...live, source: "replay" } }).bonus).toBe(0);
    expect(weatherBonus({ arrival: { ...live, source: "demo" } }).bonus).toBe(0);
    expect(weatherBonus({ arrival: { ...live, metarOrigin: "sample" } }).bonus).toBe(0);
    expect(weatherBonus({ arrival: { ...live, metarOrigin: null } }).bonus).toBe(0);
    expect(weatherBonus({ arrival: { ...live, category: null } }).bonus).toBe(0);
  });

  it("trustedWeather clears eligible on imported checks that are not sim + live", () => {
    const live = check("departure", "IFR");
    const forged = { ...check("arrival", "LIFR", { origin: "sample" }, "demo"), eligible: true };
    const out = trustedWeather({ departure: live, arrival: forged, bonus: 0.1 });
    expect(out.departure?.eligible).toBe(true);
    expect(out.arrival?.eligible).toBe(false);
    // Everything else is kept as recorded.
    expect(out.bonus).toBe(0.1);
    expect(out.arrival?.category).toBe("LIFR");
    expect(trustedWeather({ departure: live })).toEqual({ departure: live });
    expect(trustedWeather(undefined)).toBeUndefined();
  });
});

describe("checkWeather: reports from the future are not current", () => {
  it("observedAt or fetchedAt more than 5 min ahead of the check do not count", () => {
    expect(check("departure", "LIFR", { observedAt: iso(-6) }).eligible).toBe(false);
    expect(check("departure", "LIFR", { fetchedAt: iso(-6) }).eligible).toBe(false);
    expect(check("departure", "LIFR", { observedAt: iso(-24 * 60) }).eligible).toBe(false);
    // Small clock skew is tolerated.
    expect(check("departure", "LIFR", { observedAt: iso(-4), fetchedAt: iso(-4) }).eligible).toBe(
      true,
    );
    expect(check("departure", "LIFR", { fetchedAt: iso(-6) }).message).toMatch(/in the future/);
  });
});

describe("weatherOutcome: what the mission records about the bonus", () => {
  const terms = { noBonus: false, payloadMismatch: false };
  it("applied: the end that set it", () => {
    const o = weatherOutcome(
      { departure: check("departure", "IFR"), arrival: check("arrival", "VFR") },
      terms,
    );
    expect(o).toEqual({ outcome: "applied", bonus: 0.05, bonusFrom: "departure" });
  });
  it("withheld by the sim rate or by the payload check", () => {
    const w = { arrival: check("arrival", "LIFR") };
    expect(weatherOutcome(w, { noBonus: true, payloadMismatch: false })).toEqual({
      outcome: "withheld_rate",
      bonus: 0,
      bonusFrom: "arrival",
    });
    expect(weatherOutcome(w, { noBonus: true, payloadMismatch: true }).outcome).toBe(
      "withheld_payload",
    );
  });
  it("no IFR/LIFR at live ends, or nothing live at all", () => {
    expect(weatherOutcome({ departure: check("departure", "VFR") }, terms)).toEqual({
      outcome: "no_ifr",
      bonus: 0,
    });
    expect(
      weatherOutcome({ departure: check("departure", "LIFR", { origin: "sample" }) }, terms),
    ).toEqual({ outcome: "not_live", bonus: 0 });
    expect(weatherOutcome({}, terms)).toEqual({ outcome: "not_live", bonus: 0 });
  });
});
