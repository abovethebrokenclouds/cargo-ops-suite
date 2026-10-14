import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  awcMetarUrl,
  ceilingOf,
  flightCategory,
  formatCeiling,
  formatObservationAge,
  formatVisibility,
  formatWind,
  fromAwcMetar,
  fromAwcResponse,
  isObservationOld,
  normalizeStations,
  parseMetar,
  resolveDayTime,
  sampleMetar,
  sampleMetarText,
  sampleObservationTime,
} from "@cargo-ops/weather";

const REF = new Date("2026-10-13T16:05:00Z");

// HAND-MADE fixture in the documented aviationweather.gov JSON shape (see its _comment).
const FIXTURE = JSON.parse(
  readFileSync(resolve(__dirname, "../../../connector/fixtures/awc-metar.handmade.json"), "utf8"),
) as { response: unknown[] };

describe("parseMetar", () => {
  it("decodes a US METAR: wind, visibility, sky, temperature, altimeter, category", () => {
    const m = parseMetar("KMEM 131553Z 20009KT 10SM FEW040 SCT250 28/19 A2993 RMK AO2 SLP132", REF);
    expect(m).not.toBeNull();
    expect(m?.station).toBe("KMEM");
    expect(m?.observedAt).toBe("2026-10-13T15:53:00.000Z");
    expect(m?.wind).toEqual({
      directionDeg: 200,
      speedKt: 9,
      gustKt: null,
      varyingFromDeg: null,
      varyingToDeg: null,
    });
    expect(m?.visibilitySm).toBe(10);
    expect(m?.clouds).toEqual([
      { cover: "FEW", baseFt: 4000 },
      { cover: "SCT", baseFt: 25000 },
    ]);
    expect(m?.ceilingFt).toBeNull();
    expect(m?.tempC).toBe(28);
    expect(m?.dewpointC).toBe(19);
    expect(m?.altimeterHpa).toBeCloseTo(1013.5, 0);
    expect(m?.category).toBe("VFR");
  });

  it("gusts, present weather and a broken ceiling (MVFR)", () => {
    const m = parseMetar("KATL 131552Z 24012G20KT 4SM -RA BR BKN015 OVC030 21/18 A2985", REF);
    expect(m?.wind?.gustKt).toBe(20);
    expect(m?.weather).toBe("-RA BR");
    expect(m?.ceilingFt).toBe(1500);
    expect(m?.category).toBe("MVFR");
  });

  it("mixed-number visibility, varying wind, SPECI prefix (IFR)", () => {
    const m = parseMetar("SPECI KORD 131541Z 36008KT 250V320 1 1/2SM BR OVC008 12/11 A3001", REF);
    expect(m?.station).toBe("KORD");
    expect(m?.visibilitySm).toBe(1.5);
    expect(m?.wind?.varyingFromDeg).toBe(250);
    expect(m?.wind?.varyingToDeg).toBe(320);
    expect(m?.ceilingFt).toBe(800);
    expect(m?.category).toBe("IFR");
  });

  it("vertical visibility and fog (LIFR), calm and variable winds", () => {
    const fog = parseMetar("KSEA 131553Z 00000KT 1/4SM FG VV002 09/09 A3011", REF);
    expect(fog?.wind?.speedKt).toBe(0);
    expect(fog?.visibilitySm).toBe(0.25);
    expect(fog?.ceilingFt).toBe(200);
    expect(fog?.category).toBe("LIFR");
    const vrb = parseMetar("KSEA 131553Z VRB03KT M1/4SM FG VV001 09/09 A3011", REF);
    expect(vrb?.wind?.directionDeg).toBeNull();
    expect(vrb?.visibilitySm).toBe(0.25);
  });

  it("ICAO format: metres, CAVOK, Q-altimeter, negative temperatures, MPS winds", () => {
    const m = parseMetar("EGLL 131550Z AUTO 25014KT 9999 NCD 14/09 Q1009", REF);
    expect(m?.visibilityPlus).toBe(true);
    expect(m?.visibilitySm).toBeCloseTo(6.2, 1);
    expect(m?.clouds).toEqual([]);
    expect(m?.altimeterHpa).toBe(1009);
    expect(m?.category).toBe("VFR");
    const cold = parseMetar("UUEE 131530Z 03005MPS 0800 FZFG OVC002 M05/M06 Q1021", REF);
    expect(cold?.wind?.speedKt).toBe(10);
    expect(cold?.visibilitySm).toBe(0.5);
    expect(cold?.tempC).toBe(-5);
    expect(cold?.dewpointC).toBe(-6);
    expect(cold?.weather).toBe("FZFG");
    expect(cold?.category).toBe("LIFR");
    const cavok = parseMetar("LFPG 131530Z 18006KT CAVOK 20/10 Q1015", REF);
    expect(cavok?.clouds).toEqual([]);
    expect(cavok?.ceilingFt).toBeNull();
    expect(cavok?.category).toBe("VFR");
  });

  it("returns null without a station; category null when nothing is known", () => {
    expect(parseMetar("", REF)).toBeNull();
    expect(parseMetar("not a metar", REF)).toBeNull();
    expect(parseMetar("KXYZ 131553Z NIL", REF)?.category).toBeNull();
  });

  it("dates DDHHMMZ against the reference, across a month boundary", () => {
    expect(resolveDayTime(31, 23, 53, new Date("2026-11-01T00:10:00Z"))?.toISOString()).toBe(
      "2026-10-31T23:53:00.000Z",
    );
    expect(resolveDayTime(13, 15, 53, REF)?.toISOString()).toBe("2026-10-13T15:53:00.000Z");
    expect(resolveDayTime(32, 0, 0, REF)).toBeNull();
  });
});

describe("flightCategory", () => {
  it("applies the FAA thresholds at each boundary", () => {
    expect(flightCategory(10, null)).toBe("VFR");
    expect(flightCategory(5.5, 3100)).toBe("VFR");
    expect(flightCategory(5, null)).toBe("MVFR");
    expect(flightCategory(10, 3000)).toBe("MVFR");
    expect(flightCategory(3, 1000)).toBe("MVFR");
    expect(flightCategory(2.99, null)).toBe("IFR");
    expect(flightCategory(10, 999)).toBe("IFR");
    expect(flightCategory(1, 500)).toBe("IFR");
    expect(flightCategory(0.99, null)).toBe("LIFR");
    expect(flightCategory(10, 499)).toBe("LIFR");
    // The worse of the two wins.
    expect(flightCategory(10, 400)).toBe("LIFR");
    expect(flightCategory(0.5, 5000)).toBe("LIFR");
  });

  it("uses what is known", () => {
    expect(flightCategory(null, null, false)).toBeNull();
    expect(flightCategory(null, 800, true)).toBe("IFR");
    expect(flightCategory(2, null, false)).toBe("IFR");
    expect(ceilingOf(null)).toBeNull();
    expect(
      ceilingOf([
        { cover: "SCT", baseFt: 500 },
        { cover: "BKN", baseFt: 2500 },
        { cover: "OVC", baseFt: 1200 },
      ]),
    ).toBe(1200);
  });
});

describe("aviationweather.gov JSON (hand-made fixture)", () => {
  const reports = fromAwcResponse(FIXTURE.response, REF);

  it("maps every entry and prefers the API's decoded fields", () => {
    expect(reports.map((r) => r.station)).toEqual(["KMEM", "KATL", "KSEA", "KORD", "EGLL"]);
    const mem = reports[0];
    expect(mem?.decodedBy).toBe("api");
    expect(mem?.observedAt).toBe("2026-10-13T15:53:00.000Z");
    expect(mem?.visibilitySm).toBe(10);
    expect(mem?.visibilityPlus).toBe(true);
    expect(mem?.tempC).toBe(28.3); // API's decimal, not the raw group's rounded 28
    expect(mem?.altimeterHpa).toBe(1013.5);
    expect(mem?.category).toBe("VFR");
    const atl = reports[1];
    expect(atl?.wind?.gustKt).toBe(20);
    expect(atl?.ceilingFt).toBe(1500);
    expect(atl?.weather).toBe("-RA BR");
    expect(atl?.category).toBe("MVFR");
    const sea = reports[2];
    expect(sea?.wind?.directionDeg).toBeNull();
    expect(sea?.ceilingFt).toBe(200);
    expect(sea?.category).toBe("LIFR");
    const egll = reports[4];
    expect(egll?.clouds).toEqual([]); // CLR is not a layer
    expect(egll?.category).toBe("VFR");
  });

  it("falls back to the parser when decoded fields are missing", () => {
    const ord = reports[3];
    expect(ord?.decodedBy).toBe("parser");
    expect(ord?.observedAt).toBe("2026-10-13T15:41:00.000Z");
    expect(ord?.visibilitySm).toBe(1.5);
    expect(ord?.ceilingFt).toBe(800);
    expect(ord?.wind?.varyingFromDeg).toBe(250);
    expect(ord?.category).toBe("IFR");
  });

  it("ignores junk and builds the request URL", () => {
    expect(fromAwcResponse({ error: "x" })).toEqual([]);
    expect(fromAwcResponse([null, 3, { icaoId: "KMEM" }])).toEqual([]);
    expect(
      fromAwcMetar(
        { icaoId: "KMEM", rawOb: "KMEM 131553Z 20009KT 10SM CLR 28/19 A2993", altim: 29.93 },
        REF,
      )?.altimeterHpa,
    ).toBeCloseTo(1013.5, 0);
    expect(awcMetarUrl(["KMEM", "KATL"])).toBe(
      "https://aviationweather.gov/api/data/metar?ids=KMEM,KATL&format=json",
    );
  });
});

describe("stations, samples and formatting", () => {
  it("normalises station lists", () => {
    expect(normalizeStations([" kmem", "KATL", "kmem", "", null, "bad id", "X1"])).toEqual([
      "KMEM",
      "KATL",
    ]);
    expect(normalizeStations(Array.from({ length: 20 }, (_, i) => `K${100 + i}`))).toHaveLength(8);
  });

  it("builds SAMPLE reports labelled as such, observed at the last hh:53Z", () => {
    const now = new Date("2026-10-13T16:20:00Z");
    expect(sampleObservationTime(now).toISOString()).toBe("2026-10-13T15:53:00.000Z");
    expect(sampleObservationTime(new Date("2026-10-13T16:55:30Z")).toISOString()).toBe(
      "2026-10-13T16:53:00.000Z",
    );
    expect(sampleMetarText("KMEM", now)).toBe(
      "KMEM 131553Z 20009KT 10SM FEW040 SCT250 28/19 A2993",
    );
    const atl = sampleMetar("KATL", now);
    expect(atl?.origin).toBe("sample");
    expect(atl?.category).toBe("MVFR");
    expect(atl?.observedAt).toBe("2026-10-13T15:53:00.000Z");
    // Any station gets a deterministic sample.
    expect(sampleMetar("LFPG", now)?.rawText).toBe(sampleMetar("LFPG", now)?.rawText);
    expect(sampleMetar("LFPG", now)?.category).not.toBeNull();
  });

  it("formats wind, visibility, ceiling and age", () => {
    expect(
      formatWind({
        directionDeg: 240,
        speedKt: 12,
        gustKt: 20,
        varyingFromDeg: null,
        varyingToDeg: null,
      }),
    ).toBe("240° 12 G20 kt");
    expect(
      formatWind({
        directionDeg: 0,
        speedKt: 0,
        gustKt: null,
        varyingFromDeg: null,
        varyingToDeg: null,
      }),
    ).toBe("Calm");
    expect(
      formatWind({
        directionDeg: null,
        speedKt: 3,
        gustKt: null,
        varyingFromDeg: null,
        varyingToDeg: null,
      }),
    ).toBe("VRB 3 kt");
    expect(formatWind(null)).toBe("—");
    expect(formatVisibility(10, true)).toBe("≥ 10 SM");
    expect(formatVisibility(1.5, false)).toBe("1 1/2 SM");
    expect(formatVisibility(0.25, false)).toBe("1/4 SM");
    expect(formatVisibility(null, false)).toBe("—");
    expect(formatCeiling(1500, true)).toBe("1,500 ft");
    expect(formatCeiling(null, true)).toBe("None");
    expect(formatCeiling(null, false)).toBe("—");
    const now = Date.parse("2026-10-13T16:05:00Z");
    expect(formatObservationAge("2026-10-13T15:53:00Z", now)).toBe("12 min ago");
    expect(formatObservationAge("2026-10-13T13:53:00Z", now)).toBe("2 h 12 min ago");
    expect(formatObservationAge("2026-10-13T16:04:40Z", now)).toBe("just now");
    expect(formatObservationAge(null, now)).toBeNull();
    expect(isObservationOld("2026-10-13T13:53:00Z", now)).toBe(true);
    expect(isObservationOld("2026-10-13T15:53:00Z", now)).toBe(false);
  });
});
