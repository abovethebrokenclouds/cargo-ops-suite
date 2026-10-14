import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  awcTafUrl,
  formatTafTime,
  fromAwcTafResponse,
  isTafExpired,
  parseTaf,
  resolveTafTime,
  sampleTaf,
  sampleTafIssueTime,
  sampleTafText,
  sampleMetar,
  tafAt,
  tafPeriodLabel,
  type TafDecoded,
} from "@cargo-ops/weather";

// HAND-MADE response in the documented aviationweather.gov TAF JSON shape (see its _comment):
// the host is not reachable from the build container. Station ids are real, forecasts invented.
const HANDMADE = JSON.parse(
  readFileSync(resolve(__dirname, "../../../connector/fixtures/awc-taf.handmade.json"), "utf8"),
) as { response: Array<Record<string, unknown>> };
const REF = new Date("2026-10-13T18:05:00Z");

const kinds = (t: TafDecoded) => t.periods.map((p) => p.kind);
const cats = (t: TafDecoded) => t.periods.map((p) => p.category);

describe("parseTaf (US style)", () => {
  const taf = parseTaf(
    "TAF KMEM 131720Z 1318/1418 20009KT P6SM FEW040 SCT250 FM132200 22012KT P6SM SCT050 TEMPO 1401/1404 4SM -SHRA BKN030 FM140600 18006KT P6SM SCT035 BKN100 PROB30 1410/1414 2SM TSRA BKN015CB",
    REF,
  ) as TafDecoded;

  it("reads the header", () => {
    expect(taf.station).toBe("KMEM");
    expect(taf.issuedAt).toBe("2026-10-13T17:20:00.000Z");
    expect(taf.validFrom).toBe("2026-10-13T18:00:00.000Z");
    expect(taf.validTo).toBe("2026-10-14T18:00:00.000Z");
    expect(taf.amended).toBe(false);
    expect(taf.cancelled).toBe(false);
  });

  it("splits FM/TEMPO/PROB periods with times and a category each", () => {
    expect(kinds(taf)).toEqual(["BASE", "FM", "TEMPO", "FM", "PROB"]);
    expect(cats(taf)).toEqual(["VFR", "VFR", "MVFR", "VFR", "IFR"]);
    const [base, fm1, tempo, fm2, prob] = taf.periods;
    expect(base?.from).toBe("2026-10-13T18:00:00.000Z");
    expect(base?.to).toBe("2026-10-13T22:00:00.000Z");
    expect(fm1?.to).toBe("2026-10-14T06:00:00.000Z");
    expect(fm2?.to).toBe("2026-10-14T18:00:00.000Z");
    expect(tempo?.from).toBe("2026-10-14T01:00:00.000Z");
    expect(tempo?.to).toBe("2026-10-14T04:00:00.000Z");
    expect(tempo?.weather).toBe("-SHRA");
    expect(tempo?.ceilingFt).toBe(3000);
    // TEMPO states no wind: inherited from the prevailing FM group.
    expect(tempo?.wind?.speedKt).toBe(12);
    expect(prob?.probability).toBe(30);
    expect(prob?.tempo).toBe(false);
    expect(prob && tafPeriodLabel(prob)).toBe("PROB30");
    expect(prob?.text).toBe("PROB30 1410/1414 2SM TSRA BKN015CB");
    expect(base?.visibilityPlus).toBe(true);
  });

  it("answers what is forecast at a time (ETA)", () => {
    const at = (iso: string) => tafAt(taf, Date.parse(iso));
    expect(at("2026-10-13T19:00:00Z").worst).toBe("VFR");
    const tempo = at("2026-10-14T02:30:00Z");
    expect(tempo.prevailing?.kind).toBe("FM");
    expect(tempo.category).toBe("VFR");
    expect(tempo.changes.map((c) => c.kind)).toEqual(["TEMPO"]);
    expect(tempo.worst).toBe("MVFR");
    expect(at("2026-10-14T12:00:00Z").worst).toBe("IFR");
    expect(at("2026-10-15T12:00:00Z").prevailing).toBeNull();
  });

  it("knows when it has expired", () => {
    expect(isTafExpired(taf, Date.parse("2026-10-14T17:59:00Z"))).toBe(false);
    expect(isTafExpired(taf, Date.parse("2026-10-14T18:00:00Z"))).toBe(true);
  });
});

describe("parseTaf (ICAO style, BECMG merging)", () => {
  const taf = parseTaf(
    "TAF EGLL 131700Z 1318/1424 24010KT 9999 SCT030 BECMG 1320/1323 VRB03KT TEMPO 1400/1406 4000 BR BKN008 PROB30 TEMPO 1403/1407 0800 FG BKN002 BECMG 1408/1411 24012KT 9999 NSW SCT035=",
    REF,
  ) as TafDecoded;

  it("decodes metre visibility, PROB30 TEMPO and NSW", () => {
    expect(kinds(taf)).toEqual(["BASE", "BECMG", "TEMPO", "PROB", "BECMG"]);
    expect(cats(taf)).toEqual(["VFR", "VFR", "IFR", "LIFR", "VFR"]);
    const prob = taf.periods[3];
    expect(prob?.tempo).toBe(true);
    expect(prob && tafPeriodLabel(prob)).toBe("PROB30 TEMPO");
    expect(taf.periods[4]?.weather).toBeNull();
    expect(taf.validTo).toBe("2026-10-15T00:00:00.000Z");
    // BECMG with only a wind group keeps the prevailing sky and visibility.
    expect(taf.periods[1]?.wind?.directionDeg).toBeNull();
    expect(taf.periods[1]?.ceilingFt).toBeNull();
    expect(taf.periods[1]?.clouds).toEqual([{ cover: "SCT", baseFt: 3000 }]);
  });

  it("applies BECMG to the prevailing conditions and reports the worst change", () => {
    const at = tafAt(taf, Date.parse("2026-10-14T04:00:00Z"));
    expect(at.prevailing?.kind).toBe("BASE");
    expect(at.category).toBe("VFR");
    expect(at.changes.map(tafPeriodLabel)).toEqual(["TEMPO", "PROB30 TEMPO"]);
    expect(at.worst).toBe("LIFR");
  });
});

describe("parseTaf edge cases", () => {
  it("handles AMD/COR, hour 24, month rollover and line breaks", () => {
    const t = parseTaf(
      "TAF AMD KSEA 302320Z 3100/0106 00000KT 1/2SM FG VV002\n TEMPO 3100/3103 1/4SM FG VV001\n FM310400 VRB03KT 3SM BR OVC006 FM311600 18008KT P6SM BKN025 WS020/18040KT",
      new Date("2026-10-30T23:30:00Z"),
    ) as TafDecoded;
    expect(t.amended).toBe(true);
    expect(t.issuedAt).toBe("2026-10-30T23:20:00.000Z");
    expect(t.validFrom).toBe("2026-10-31T00:00:00.000Z");
    expect(t.validTo).toBe("2026-11-01T06:00:00.000Z");
    expect(cats(t)).toEqual(["LIFR", "LIFR", "IFR", "MVFR"]);
    expect(t.periods[3]?.to).toBe("2026-11-01T06:00:00.000Z");
  });

  it("writes 00Z as hour 24 of the day before", () => {
    expect(resolveTafTime(13, 24, 0, REF)?.toISOString()).toBe("2026-10-14T00:00:00.000Z");
    expect(resolveTafTime(32, 0, 0, REF)).toBeNull();
    expect(resolveTafTime(31, 0, 0, new Date("2026-11-01T00:00:00Z"))?.toISOString()).toBe(
      "2026-10-31T00:00:00.000Z",
    );
  });

  it("CAVOK, NIL and garbage", () => {
    const cavok = parseTaf("TAF LFPG 131700Z 1318/1424 22008KT CAVOK", REF) as TafDecoded;
    expect(cats(cavok)).toEqual(["VFR"]);
    const nil = parseTaf("TAF KXYZ 131720Z NIL", REF) as TafDecoded;
    expect(nil.cancelled).toBe(true);
    expect(nil.periods).toEqual([]);
    expect(parseTaf("hello world", REF)).toBeNull();
    expect(parseTaf("", REF)).toBeNull();
  });

  it("formats TAF times", () => {
    expect(formatTafTime("2026-10-13T18:00:00.000Z")).toBe("13/18Z");
    expect(formatTafTime("2026-10-14T06:30:00.000Z")).toBe("14/0630Z");
    expect(formatTafTime(null)).toBe("—");
  });
});

describe("parseTaf / tafAt review cases (hand-made TAFs)", () => {
  const at = (taf: TafDecoded, iso: string) => tafAt(taf, Date.parse(iso));

  it("inside a BECMG window the worse of before and after applies", () => {
    const t = parseTaf(
      "TAF KXYZ 131720Z 1318/1418 00000KT 1/4SM FG OVC002 BECMG 1400/1404 9999 NSW SCT030",
      REF,
    ) as TafDecoded;
    expect(t.periods[1]?.category).toBe("VFR");
    expect(at(t, "2026-10-14T00:30:00Z").category).toBe("LIFR");
    expect(at(t, "2026-10-14T00:30:00Z").worst).toBe("LIFR");
    expect(at(t, "2026-10-13T23:00:00Z").category).toBe("LIFR");
    expect(at(t, "2026-10-14T04:00:00Z").category).toBe("VFR");
  });

  it("NSW clears inherited weather on merge", () => {
    const t = parseTaf(
      "TAF KXYZ 131720Z 1318/1418 20010KT 4SM -RA BKN020 BECMG 1400/1402 9999 NSW SCT030",
      REF,
    ) as TafDecoded;
    expect(t.periods[0]?.weather).toBe("-RA");
    expect(t.periods[1]?.weather).toBeNull();
    expect(t.periods[1]?.weatherCleared).toBe(true);
    // Without NSW the weather is inherited.
    const keep = parseTaf(
      "TAF KXYZ 131720Z 1318/1418 20010KT 4SM -RA BKN020 BECMG 1400/1402 SCT030",
      REF,
    ) as TafDecoded;
    expect(keep.periods[1]?.weather).toBe("-RA");
  });

  it("a TEMPO starting at the same instant as a BECMG sees the BECMG in parser and tafAt", () => {
    const t = parseTaf(
      "TAF KXYZ 131720Z 1318/1418 18008KT P6SM OVC008 BECMG 1400/1402 BKN040 TEMPO 1400/1404 4SM",
      REF,
    ) as TafDecoded;
    const tempo = t.periods.find((p) => p.kind === "TEMPO");
    // 4SM over BKN040 (after the BECMG) = MVFR; over OVC008 it would be IFR.
    expect(tempo?.category).toBe("MVFR");
    const now = at(t, "2026-10-14T00:00:00Z");
    expect(now.changes.map((c) => c.category)).toEqual(["MVFR"]);
    // The BECMG window is open at 00Z: OVC008 (IFR) may still prevail.
    expect(now.category).toBe("IFR");
    expect(at(t, "2026-10-14T03:00:00Z").category).toBe("VFR");
    expect(at(t, "2026-10-14T03:00:00Z").worst).toBe("MVFR");
  });

  it("a change group spanning an FM is merged with the conditions in force at the time", () => {
    const t = parseTaf(
      "TAF KXYZ 131720Z 1318/1418 18008KT P6SM BKN040 FM140200 18008KT P6SM OVC008 TEMPO 1400/1404 4SM",
      REF,
    ) as TafDecoded;
    // Before the FM: 4SM over BKN040 = MVFR; after it: over OVC008 = IFR.
    expect(at(t, "2026-10-14T01:00:00Z").changes[0]?.category).toBe("MVFR");
    expect(at(t, "2026-10-14T03:00:00Z").changes[0]?.category).toBe("IFR");
    expect(at(t, "2026-10-14T03:00:00Z").worst).toBe("IFR");
  });

  it("clips periods to the validity; nothing has from after to", () => {
    const t = parseTaf(
      "TAF KXYZ 131720Z 1318/1418 18008KT P6SM BKN040 FM150300 20010KT 2SM OVC005 TEMPO 1416/1420 3SM BR",
      REF,
    ) as TafDecoded;
    expect(kinds(t)).toEqual(["BASE", "TEMPO"]);
    expect(t.periods[0]?.to).toBe("2026-10-14T18:00:00.000Z");
    expect(t.periods[1]?.to).toBe("2026-10-14T18:00:00.000Z");
    for (const p of t.periods) expect(Date.parse(p.to)).toBeGreaterThan(Date.parse(p.from));
  });
});

describe("aviationweather.gov TAF JSON (HAND-MADE fixture)", () => {
  const tafs = fromAwcTafResponse(HANDMADE.response, REF);
  const by = (id: string) => tafs.find((t) => t.station === id) as (typeof tafs)[number];

  it("builds the request URL", () => {
    expect(awcTafUrl(["KMEM", "KATL"])).toBe(
      "https://aviationweather.gov/api/data/taf?ids=KMEM,KATL&format=json",
    );
  });

  it("maps every element, header from rawTAF, API times as fallback", () => {
    expect(tafs.map((t) => t.station)).toEqual(["KMEM", "KATL", "EGLL", "KSEA"]);
    expect(by("KATL").amended).toBe(true);
    expect(by("KATL").issuedAt).toBe("2026-10-13T17:35:00.000Z");
    expect(by("KATL").validTo).toBe("2026-10-15T00:00:00.000Z");
    expect(by("KSEA").rawText).not.toMatch(/\n/);
    for (const t of tafs) {
      const item = HANDMADE.response.find((i) => i["icaoId"] === t.station);
      expect(t.validFrom).toBe(new Date((item?.["validTimeFrom"] as number) * 1000).toISOString());
      expect(t.validTo).toBe(new Date((item?.["validTimeTo"] as number) * 1000).toISOString());
    }
  });

  it("our period count matches the API's fcsts where present", () => {
    for (const t of tafs) {
      if (t.apiPeriodCount !== null) expect(t.periods.length, t.station).toBe(t.apiPeriodCount);
    }
    expect(by("KSEA").apiPeriodCount).toBeNull();
    expect(cats(by("KATL"))).toEqual(["MVFR", "IFR", "VFR", "VFR"]);
    expect(cats(by("KSEA"))).toEqual(["LIFR", "LIFR", "IFR", "MVFR", "VFR"]);
  });

  it("ignores elements without rawTAF and non-array bodies", () => {
    expect(fromAwcTafResponse([{ icaoId: "KMEM" }, null, 3])).toEqual([]);
    expect(fromAwcTafResponse({ error: "x" })).toEqual([]);
  });
});

describe("SAMPLE TAFs", () => {
  const now = new Date("2026-10-13T19:07:00Z");

  it("issues at hh:20Z on the 6-hourly schedule and covers 24 hours", () => {
    expect(sampleTafIssueTime(now).toISOString()).toBe("2026-10-13T17:20:00.000Z");
    expect(sampleTafIssueTime(new Date("2026-10-13T17:19:00Z")).toISOString()).toBe(
      "2026-10-13T11:20:00.000Z",
    );
    const t = sampleTaf("KMEM", now);
    expect(t?.origin).toBe("sample");
    expect(t?.validFrom).toBe("2026-10-13T18:00:00.000Z");
    expect(t?.validTo).toBe("2026-10-14T18:00:00.000Z");
    expect(sampleTafText("KMEM", now)).toMatch(/^TAF KMEM 131720Z 1318\/1418 /);
  });

  it("parses for every station, and agrees with the sample METAR's category at the start", () => {
    for (const id of ["KMEM", "KATL", "KORD", "KSEA", "KDFW", "KJFK", "EGLL", "KLIT", "PHNL"]) {
      const t = sampleTaf(id, now);
      expect(t, id).not.toBeNull();
      expect(t?.periods.length, id).toBeGreaterThan(1);
      for (const p of t?.periods ?? []) expect(p.category, `${id} ${p.text}`).not.toBeNull();
      if (["KMEM", "KATL", "KORD", "KSEA", "KDFW", "KJFK"].includes(id)) {
        expect(t?.periods[0]?.category, id).toBe(sampleMetar(id, now)?.category);
      }
    }
  });

  it("validity ending at 00Z is written as hour 24", () => {
    expect(sampleTafText("KATL", new Date("2026-10-13T00:30:00Z"))).toMatch(
      /^TAF KATL 122320Z 1300\/1324 /,
    );
  });
});
