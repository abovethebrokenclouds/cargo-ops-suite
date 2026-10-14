import { describe, expect, it } from "vitest";

import { surfaceClass, type MsfsAirport } from "../../protocol/src/index";
import {
  MSFS_SURFACES,
  facilityLookup,
  longestMsfsRunway,
  mergeFacility,
  metresToFeet,
  type EconomyAirport,
} from "../src/index";

const BASE: EconomyAirport = {
  ident: "KAAA",
  name: "Alpha Field",
  type: "medium",
  lat: 35,
  lon: -90,
  elevFt: 300,
  longestRwyFt: 5000,
  surface: "ASP",
};

const rwy = (lengthFt: number, surfaceCode: number) => ({
  ident: "",
  headingTrueDeg: 90,
  lengthFt,
  widthFt: 100,
  surfaceCode,
  surface: MSFS_SURFACES[surfaceCode]?.name ?? null,
});

const msfs = (over: Partial<MsfsAirport> = {}): MsfsAirport => ({
  icao: "KAAA",
  lat: 35.01,
  lon: -90.02,
  elevFt: 310,
  runways: [],
  fetchedAt: "2026-10-14T12:00:00.000Z",
  ...over,
});

describe("MSFS surface table", () => {
  it("classifies every SURFACE value like the OurAirports codes", () => {
    const expected: Record<string, string> = {
      concrete: "paved",
      asphalt: "paved",
      bituminous: "paved",
      macadam: "paved",
      tarmac: "paved",
      grass: "turf",
      "bumpy grass": "turf",
      "short grass": "turf",
      "long grass": "turf",
      "hard turf": "turf",
      gravel: "gravel",
      coral: "gravel",
      "steel mats": "gravel",
      dirt: "dirt",
      sand: "dirt",
      "water (FSX)": "water",
      ocean: "water",
      water: "water",
      pond: "water",
      lake: "water",
      river: "water",
      "waste water": "water",
    };
    for (const { name, code } of Object.values(MSFS_SURFACES)) {
      expect([name, surfaceClass(code)]).toEqual([name, expected[name] ?? "unknown"]);
    }
  });

  it("converts metres to whole feet", () => {
    expect(metresToFeet(3389.4)).toBe(11120);
    expect(metresToFeet(0)).toBe(0);
  });
});

describe("mergeFacility", () => {
  it("keeps OurAirports when the sim returned nothing", () => {
    expect(mergeFacility(BASE, null)?.sources).toEqual({
      name: "ourairports",
      position: "ourairports",
      elevation: "ourairports",
      runway: "ourairports",
      surface: "ourairports",
    });
    expect(mergeFacility(null, null)).toBeNull();
  });

  it("never invents runway data: no MSFS runways keeps the OurAirports runway", () => {
    const m = mergeFacility(BASE, msfs());
    expect(m?.airport).toMatchObject({
      lat: 35.01,
      elevFt: 310,
      longestRwyFt: 5000,
      surface: "ASP",
    });
    expect(m?.sources).toMatchObject({ position: "msfs", runway: "ourairports" });
  });

  it("takes the longest MSFS runway (first on a tie) and its known surface", () => {
    const runways = [rwy(4000, 1), rwy(6000, 14), rwy(6000, 4)];
    expect(longestMsfsRunway(runways)?.surfaceCode).toBe(14);
    const m = mergeFacility(BASE, msfs({ runways }));
    expect(m?.airport).toMatchObject({ longestRwyFt: 6000, surface: "GRAVEL" });
    expect(m?.sources).toMatchObject({ runway: "msfs", surface: "msfs", name: "ourairports" });
    expect(m?.airport.name).toBe("Alpha Field");
  });

  it("adds an airport only the sim knows, as small, with the sim's name or its ICAO", () => {
    const addon = mergeFacility(
      null,
      msfs({ icao: "xadd", name: "Addon", runways: [rwy(3000, 1)] }),
    );
    expect(addon?.airport).toMatchObject({ ident: "XADD", name: "Addon", type: "small" });
    const nameless = mergeFacility(null, msfs({ icao: "XNON" }));
    expect(nameless?.airport.name).toBe("XNON");
    expect(nameless?.sources.runway).toBeNull();
  });

  it("facilityLookup is sorted by ident and independent of the record order", () => {
    const records = [msfs({ icao: "ZZZZ" }), msfs({ icao: "KAAA", runways: [rwy(7000, 4)] })];
    const a = facilityLookup([BASE], records);
    const b = facilityLookup([BASE], [...records].reverse());
    expect(a.list).toEqual(b.list);
    expect(a.list.map((x) => x.ident)).toEqual(["KAAA", "ZZZZ"]);
    expect(a.msfsOf("kaaa")?.runways).toHaveLength(1);
    expect(a.sourcesOf("nope")).toBeNull();
  });
});
