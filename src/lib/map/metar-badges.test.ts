import { describe, expect, it } from "vitest";
import type { MetarResponse } from "@cargo-ops/weather";

import { sampleResponse } from "@/lib/weather/use-metar";

import type { Airport, AirportIndex } from "./airports";
import { mapWeatherStations, metarBadges, metarBadgesGeoJson } from "./metar-badges";

const airport = (ident: string, lat: number, lon: number) =>
  ({ ident, lat, lon, name: ident, type: "large" }) as unknown as Airport;
const INDEX = {
  list: [],
  byIdent: new Map([
    ["KMEM", airport("KMEM", 35.04, -89.98)],
    ["KATL", airport("KATL", 33.64, -84.43)],
    ["KLIT", airport("KLIT", 34.73, -92.22)],
  ]),
} as unknown as AirportIndex;

describe("mapWeatherStations", () => {
  it("route ends first, then the mission and accepted jobs, roles merged, no duplicates", () => {
    const s = mapWeatherStations({
      origin: "kmem",
      destination: "KATL",
      missionOrigin: "KMEM",
      missionDestination: "KATL",
      acceptedJobs: [
        { origin: "KATL", destination: "KLIT" },
        { origin: "KMEM", destination: "not an id" },
      ],
    });
    expect(s).toEqual([
      { ident: "KMEM", roles: ["Origin", "Accepted job"] },
      { ident: "KATL", roles: ["Destination", "Accepted job"] },
      { ident: "KLIT", roles: ["Accepted job"] },
    ]);
  });

  it("stays within the connector's batch of 8 stations", () => {
    const jobs = Array.from({ length: 10 }, (_, i) => ({
      origin: `KA${String(i).padStart(2, "0")}`,
      destination: `KB${String(i).padStart(2, "0")}`,
    }));
    const s = mapWeatherStations({ origin: "KMEM", destination: "KATL", acceptedJobs: jobs });
    expect(s).toHaveLength(8);
    expect(s.slice(0, 2).map((x) => x.ident)).toEqual(["KMEM", "KATL"]);
  });

  it("nothing known, nothing asked", () => {
    expect(mapWeatherStations({})).toEqual([]);
  });
});

describe("metarBadges", () => {
  const stations = mapWeatherStations({ origin: "KMEM", destination: "KATL" }).concat([
    { ident: "KXYZ", roles: ["Accepted job"] },
  ]);

  it("one badge per station with a report and a position, SAMPLE origin kept", () => {
    const response = sampleResponse(["KMEM", "KATL", "KXYZ"], new Date("2026-10-13T19:07:00Z"));
    const badges = metarBadges(stations, response, INDEX);
    expect(badges.map((b) => [b.station, b.category, b.origin])).toEqual([
      ["KMEM", "VFR", "sample"],
      ["KATL", "MVFR", "sample"],
    ]);
    expect(badges[0]?.rawText).toMatch(/^KMEM 131853Z 20009KT/);
    expect(badges[0]?.roles).toEqual(["Origin"]);
  });

  it("no response, no report or no airport index: no badge (never invented)", () => {
    expect(metarBadges(stations, null, INDEX)).toEqual([]);
    const empty: MetarResponse = {
      mode: "online",
      onlineAllowed: false,
      stations: [{ station: "KMEM", report: null, note: "Online weather is off in Settings." }],
      attribution: "",
      endpoint: "",
    };
    expect(metarBadges(stations, empty, INDEX)).toEqual([]);
    expect(metarBadges(stations, sampleResponse(["KMEM"]), null)).toEqual([]);
  });

  it("GeoJSON carries station, category, origin and staleness", () => {
    const badges = metarBadges(stations, sampleResponse(["KMEM"]), INDEX);
    const fc = metarBadgesGeoJson(badges);
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0]?.geometry.coordinates).toEqual([-89.98, 35.04]);
    expect(fc.features[0]?.properties).toEqual({
      station: "KMEM",
      category: "VFR",
      origin: "sample",
      stale: false,
    });
  });
});
