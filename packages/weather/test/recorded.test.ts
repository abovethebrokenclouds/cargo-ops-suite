import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  formatObservationAge,
  formatVisibility,
  fromAwcResponse,
  hpaToInHg,
  parseMetar,
} from "@cargo-ops/weather";

// RECORDED live aviationweather.gov response (metar-live workflow, run 38491010466).
const RECORDED = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../connector/fixtures/awc-metar.recorded-2026-10-14.json"),
    "utf8",
  ),
) as { response: Array<Record<string, unknown>> };
const RAW = RECORDED.response;
const REF = new Date("2026-10-14T00:30:00Z");

describe("aviationweather.gov JSON (recorded 2026-10-14)", () => {
  const reports = fromAwcResponse(RAW, REF);
  const by = (id: string) => reports.find((r) => r.station === id);

  it("maps every station from the API's decoded fields", () => {
    expect(reports.map((r) => r.station).sort()).toEqual(["EGLL", "KATL", "KJFK", "KMEM"]);
    for (const r of reports) {
      expect(r.decodedBy).toBe("api");
      expect(r.category).toBe("VFR");
      expect(r.rawText.startsWith(`METAR ${r.station} `)).toBe(true);
    }
  });

  it("takes the observation time from obsTime (unix seconds)", () => {
    for (const item of RAW) {
      const r = by(item["icaoId"] as string);
      expect(r?.observedAt).toBe(new Date((item["obsTime"] as number) * 1000).toISOString());
    }
    expect(by("KMEM")?.observedAt).toBe("2026-10-13T23:54:00.000Z"); // raw 132354Z
    expect(by("EGLL")?.observedAt).toBe("2026-10-14T00:20:00.000Z"); // raw 140020Z
    // The age readout is computed from that time.
    const now = 1791935640 * 1000 + 12 * 60_000;
    expect(formatObservationAge(by("KMEM")?.observedAt ?? null, now)).toBe("12 min ago");
    // obsTime wins over the raw DDHHMMZ group when they differ.
    const shifted = fromAwcResponse([{ ...RAW[3], obsTime: 1791935640 - 3600 }], REF)[0];
    expect(shifted?.observedAt).toBe("2026-10-13T22:54:00.000Z");
  });

  it("treats altim as hPa and converts to inHg matching the raw A-group", () => {
    expect(by("EGLL")?.altimeterHpa).toBe(1028); // Q1028
    expect(by("KATL")?.altimeterHpa).toBe(1019);
    expect(hpaToInHg(1019)).toBe(30.09); // raw A3009
    expect(by("KMEM")?.altimeterHpa).toBe(1015.3);
    expect(hpaToInHg(1015.3)).toBe(29.98); // raw A2998
    expect(hpaToInHg(1012.6)).toBe(29.9); // KJFK raw A2990
  });

  it('reads visib "10+" and "6+" as "at least"', () => {
    expect(by("KMEM")?.visibilitySm).toBe(10);
    expect(by("KMEM")?.visibilityPlus).toBe(true);
    expect(formatVisibility(10, true)).toBe("≥ 10 SM");
    expect(by("EGLL")?.visibilitySm).toBe(6);
    expect(by("EGLL")?.visibilityPlus).toBe(true);
  });

  it("wind, sky and ceiling", () => {
    expect(by("KJFK")?.wind).toMatchObject({ directionDeg: 190, speedKt: 10, gustKt: null });
    expect(by("KJFK")?.clouds).toEqual([{ cover: "SCT", baseFt: 25000 }]);
    expect(by("KJFK")?.ceilingFt).toBeNull();
    expect(by("KATL")?.clouds).toEqual([]);
    expect(by("KMEM")?.clouds).toEqual([{ cover: "FEW", baseFt: 5500 }]);
  });

  it("our parser on rawOb agrees with AWC's fltCat and decoded fields", () => {
    for (const item of RAW) {
      const parsed = parseMetar(item["rawOb"] as string, REF);
      expect(parsed?.category).toBe(item["fltCat"]);
      expect(parsed?.wind?.speedKt).toBe(item["wspd"]);
      expect(parsed?.observedAt).toBe(new Date((item["obsTime"] as number) * 1000).toISOString());
      expect(Math.abs((parsed?.altimeterHpa ?? 0) - (item["altim"] as number))).toBeLessThan(0.6);
    }
  });
});
