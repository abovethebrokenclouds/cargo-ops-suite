import { describe, expect, it } from "vitest";

import { initialSimState, simReducer, type ClientSimState } from "@/lib/sim-state";
import type { Snapshot } from "@cargo-ops/protocol";

import {
  airportsGeoJson,
  findAirport,
  indexAirports,
  nearbyAirports,
  type Airport,
} from "./airports";
import { routeEnds } from "./route";

const AIRPORTS: Airport[] = [
  {
    ident: "KMEM",
    name: "Memphis",
    type: "large",
    lat: 35.0438,
    lon: -89.9763,
    country: "US",
    region: "US-TN",
  },
  {
    ident: "KATL",
    name: "Atlanta",
    type: "large",
    lat: 33.6367,
    lon: -84.4281,
    country: "US",
    region: "US-GA",
  },
  {
    ident: "KTUP",
    name: "Tupelo",
    type: "medium",
    lat: 34.2681,
    lon: -88.7699,
    country: "US",
    region: "US-MS",
  },
];
const index = indexAirports(AIRPORTS);

function stateWith(snapshot: Snapshot["state"]): ClientSimState {
  let s = simReducer(initialSimState, {
    type: "welcome",
    msg: { type: "welcome", v: 1, session: "t", mode: "demo", sim: { connected: false } },
  });
  s = simReducer(s, {
    type: "snapshot",
    msg: { type: "snapshot", v: 1, seq: 0, source: "demo", state: snapshot },
    at: 0,
  });
  return s;
}

describe("airports", () => {
  it("finds by ident case-insensitively", () => {
    expect(findAirport(index, "kmem")?.name).toBe("Memphis");
    expect(findAirport(index, "XXXX")).toBeNull();
    expect(findAirport(null, "KMEM")).toBeNull();
  });
  it("lists nearby airports nearest first", () => {
    const near = nearbyAirports(AIRPORTS, { lat: 35.0, lon: -90.0 }, 100);
    expect(near.map((n) => n.airport.ident)).toEqual(["KMEM", "KTUP"]);
    expect(near[0]?.distanceNm).toBeLessThan(5);
  });
  it("builds GeoJSON points", () => {
    const fc = airportsGeoJson(AIRPORTS);
    expect(fc.features).toHaveLength(3);
    expect(fc.features[0]?.geometry.coordinates).toEqual([-89.9763, 35.0438]);
    expect(fc.features[0]?.properties).toEqual({ ident: "KMEM", type: "large" });
  });
});

describe("routeEnds", () => {
  it("has no endpoints without a plan", () => {
    expect(routeEnds(initialSimState, index)).toEqual({ origin: null, destination: null });
  });

  it("uses the plan's next-waypoint coordinates for the destination", () => {
    const s = stateWith({
      plan: {
        active: true,
        origin: "KMEM",
        destination: "KATL",
        nextWpId: "KATL",
        nextWpLat: 33.6,
        nextWpLon: -84.4,
      },
    });
    const ends = routeEnds(s, index);
    expect(ends.origin).toEqual({ ident: "KMEM", lat: 35.0438, lon: -89.9763 });
    expect(ends.destination).toEqual({ ident: "KATL", lat: 33.6, lon: -84.4 });
  });

  it("falls back to the airport list and never invents unknown airports", () => {
    const s = stateWith({ plan: { active: true, origin: "ZZZZ", destination: "KATL" } });
    const ends = routeEnds(s, index);
    expect(ends.origin).toBeNull();
    expect(ends.destination).toEqual({ ident: "KATL", lat: 33.6367, lon: -84.4281 });
    expect(routeEnds(s, null).destination).toBeNull();
  });
});
