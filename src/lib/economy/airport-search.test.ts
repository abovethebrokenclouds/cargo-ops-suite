import { describe, expect, it } from "vitest";

import { airportLookup, type EconomyAirport } from "@cargo-ops/economy";

import { searchAirports } from "./airport-search";

const lookup = airportLookup([
  {
    ident: "KATL",
    iata: "ATL",
    name: "Hartsfield-Jackson Atlanta",
    type: "large",
    lat: 33.6,
    lon: -84.4,
  },
  { ident: "KATW", name: "Appleton International", type: "medium", lat: 44.3, lon: -88.5 },
  {
    ident: "KBNA",
    iata: "BNA",
    name: "Nashville International",
    type: "large",
    lat: 36.1,
    lon: -86.7,
  },
] satisfies EconomyAirport[]);

describe("searchAirports", () => {
  it("needs two characters", () => {
    expect(searchAirports(lookup, "k")).toEqual([]);
  });

  it("puts the exact ident first, then ident prefixes, IATA and names", () => {
    expect(searchAirports(lookup, "katl").map((a) => a.ident)).toEqual(["KATL"]);
    expect(searchAirports(lookup, "KAT").map((a) => a.ident)).toEqual(["KATL", "KATW"]);
    expect(searchAirports(lookup, "bna").map((a) => a.ident)).toEqual(["KBNA"]);
    expect(searchAirports(lookup, "international").map((a) => a.ident)).toEqual(["KATW", "KBNA"]);
  });

  it("caps the result count", () => {
    expect(searchAirports(lookup, "K", 1)).toEqual([]);
    expect(searchAirports(lookup, "KA", 1)).toHaveLength(1);
  });
});
