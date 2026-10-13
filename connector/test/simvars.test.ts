import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  fastIntervalMs,
  mapFast,
  mapFuel,
  mapMotion,
  mapPayload,
  mapPosition,
  mapSlow,
  mapZulu,
  pausedFromEx1,
  simNameFor,
} from "../src/sim/mapping";
import {
  MAX_ENGINES,
  MAX_STATIONS,
  SIMVARS,
  buildDatums,
  clampCount,
  unverifiedSimVars,
  type RawValues,
} from "../src/sim/simvars";

const fastRaw: RawValues = {
  lat: 35.0424,
  lon: -89.9767,
  altFt: 5500.4,
  aglFt: 5100,
  iasKt: 150,
  tasKt: 162,
  gsKt: 170,
  hdgMagDeg: 106.5,
  hdgTrueDeg: 105.5,
  vsFpm: -500,
  gForce: 1.02,
  isOnGround: 0,
  simOnGround: 0,
};

const counts = { engines: 2, stations: 3 };
const slowRaw: RawValues = {
  title: "Cessna 208B Grand Caravan EX\u0000\u0000\u0000",
  atcId: "N401CO",
  fuelGal: 253.7,
  fuelLb: 1700,
  "fuelFlowPph:1": 350,
  "fuelFlowPph:2": 352,
  totalWeightLb: 8430,
  emptyWeightLb: 4730,
  maxGrossWeightLb: 8750,
  "stationWeightLb:1": 170,
  "stationWeightLb:2": 450,
  "stationWeightLb:3": 380,
  "stationName:1": "Pilot",
  "stationName:2": "Cargo Zone A",
  "stationName:3": "",
  "engineCombustion:1": 1,
  "engineCombustion:2": 0,
  parkingBrake: 1,
  simRate: 2,
  zuluTimeSec: 3723.5,
  zuluDay: 13,
  zuluMonth: 10,
  zuluYear: 2026,
};

describe("SimVar table", () => {
  it("has unique keys and the plan §6.1 SimVars", () => {
    const keys = SIMVARS.map((s) => s.key);
    assert.equal(new Set(keys).size, keys.length);
    const names = new Set(SIMVARS.map((s) => s.name));
    for (const name of [
      "TITLE",
      "ATC ID",
      "PLANE LATITUDE",
      "PLANE LONGITUDE",
      "INDICATED ALTITUDE",
      "PLANE ALT ABOVE GROUND",
      "AIRSPEED INDICATED",
      "AIRSPEED TRUE",
      "GROUND VELOCITY",
      "PLANE HEADING DEGREES MAGNETIC",
      "PLANE HEADING DEGREES TRUE",
      "VERTICAL SPEED",
      "FUEL TOTAL QUANTITY",
      "FUEL TOTAL QUANTITY WEIGHT",
      "ENG FUEL FLOW PPH",
      "TOTAL WEIGHT",
      "EMPTY WEIGHT",
      "MAX GROSS WEIGHT",
      "PAYLOAD STATION COUNT",
      "PAYLOAD STATION WEIGHT",
      "PAYLOAD STATION NAME",
      "IS ON GROUND",
      "GENERAL ENG COMBUSTION",
      "BRAKE PARKING POSITION",
      "SIMULATION RATE",
      "ZULU TIME",
      "G FORCE",
    ]) {
      assert.ok(names.has(name), `missing ${name}`);
    }
  });

  it("requests the plan's units", () => {
    const unit = (name: string) => SIMVARS.find((s) => s.name === name)?.unit;
    assert.equal(unit("VERTICAL SPEED"), "feet per minute");
    assert.equal(unit("AIRSPEED INDICATED"), "knots");
    assert.equal(unit("FUEL TOTAL QUANTITY"), "gallons");
    assert.equal(unit("ENG FUEL FLOW PPH"), "pounds per hour");
    assert.equal(unit("PAYLOAD STATION WEIGHT"), "pounds");
    assert.equal(unit("PLANE LATITUDE"), "degrees");
  });

  it("flags the plan's unverified SimVars", () => {
    const unverified = unverifiedSimVars();
    for (const name of ["SIMULATION RATE", "PAYLOAD STATION WEIGHT", "ENG FUEL FLOW PPH"]) {
      assert.ok(unverified.includes(name), name);
    }
  });

  it("expands indexed SimVars from counts, in a stable order", () => {
    const datums = buildDatums("slow", { engines: 2, stations: 1 });
    const names = datums.map((d) => d.simvar);
    assert.ok(names.includes("ENG FUEL FLOW PPH:1"));
    assert.ok(names.includes("ENG FUEL FLOW PPH:2"));
    assert.ok(!names.includes("ENG FUEL FLOW PPH:3"));
    assert.ok(names.includes("PAYLOAD STATION WEIGHT:1"));
    assert.ok(names.includes("PAYLOAD STATION NAME:1"));
    assert.deepEqual(buildDatums("slow", { engines: 2, stations: 1 }), datums);
    assert.ok(buildDatums("fast", counts).every((d) => !d.simvar.includes(":")));
  });

  it("drops disabled SimVars (all indices) from definitions", () => {
    const datums = buildDatums("slow", counts, new Set(["fuelFlowPph", "simRate"]));
    assert.ok(!datums.some((d) => d.simvar.startsWith("ENG FUEL FLOW PPH")));
    assert.ok(!datums.some((d) => d.simvar === "SIMULATION RATE"));
  });

  it("clamps counts", () => {
    assert.equal(clampCount(2, MAX_ENGINES), 2);
    assert.equal(clampCount(12, MAX_ENGINES), MAX_ENGINES);
    assert.equal(clampCount(99, MAX_STATIONS), MAX_STATIONS);
    assert.equal(clampCount(-1, MAX_ENGINES), 0);
    assert.equal(clampCount(2.9, MAX_ENGINES), 2);
    assert.equal(clampCount(Number.NaN, MAX_ENGINES), 0);
    assert.equal(clampCount("3", MAX_ENGINES), 0);
  });
});

describe("raw → domain mapping", () => {
  it("maps fast data to position and motion", () => {
    assert.deepEqual(mapFast(fastRaw), {
      position: { lat: 35.0424, lon: -89.9767, altFt: 5500.4, aglFt: 5100 },
      motion: {
        iasKt: 150,
        tasKt: 162,
        gsKt: 170,
        hdgMagDeg: 106.5,
        hdgTrueDeg: 105.5,
        vsFpm: -500,
        gForce: 1.02,
        onGround: false,
      },
    });
  });

  it("uses SIM ON GROUND when IS ON GROUND is unavailable", () => {
    const { isOnGround: _drop, ...raw } = fastRaw;
    assert.equal(mapMotion({ ...raw, simOnGround: 1 })?.onGround, true);
    const { simOnGround: _drop2, ...none } = raw;
    assert.equal(mapMotion(none), undefined);
  });

  it("never invents a position", () => {
    assert.equal(mapPosition({ ...fastRaw, lat: 0, lon: 0 }), undefined);
    assert.equal(mapPosition({ ...fastRaw, lat: 91 }), undefined);
    assert.equal(mapPosition({ ...fastRaw, lat: Number.NaN }), undefined);
    const { altFt: _drop, ...noAlt } = fastRaw;
    assert.equal(mapPosition(noAlt), undefined);
    assert.deepEqual(mapFast({}), {});
  });

  it("maps slow data to aircraft, fuel, weights, payload, engines, controls", () => {
    const slow = mapSlow(slowRaw, counts);
    assert.deepEqual(slow.aircraft, { title: "Cessna 208B Grand Caravan EX", atcId: "N401CO" });
    assert.deepEqual(slow.fuel, { totalGal: 253.7, totalLb: 1700, flowPph: [350, 352] });
    assert.deepEqual(slow.payload, {
      stations: [
        { name: "Pilot", weightLb: 170 },
        { name: "Cargo Zone A", weightLb: 450 },
        { name: "Station 3", weightLb: 380 },
      ],
    });
    assert.deepEqual(slow.weights, {
      totalLb: 8430,
      emptyLb: 4730,
      maxGrossLb: 8750,
      payloadLb: 1000,
    });
    assert.deepEqual(slow.engines, { running: [true, false] });
    assert.deepEqual(slow.controls, { parkingBrake: true });
    assert.equal(slow.simRate, 2);
    assert.equal(slow.zulu, "2026-10-13T01:02:03.500Z");
  });

  it("omits the atc id when empty and the aircraft when the title is missing", () => {
    assert.deepEqual(mapSlow({ ...slowRaw, atcId: "" }, counts).aircraft, {
      title: "Cessna 208B Grand Caravan EX",
    });
    assert.equal(mapSlow({ ...slowRaw, title: "" }, counts).aircraft, undefined);
  });

  it("reports an empty flow list when fuel flow is unavailable, never zeros", () => {
    const raw = { ...slowRaw };
    delete raw["fuelFlowPph:1"];
    delete raw["fuelFlowPph:2"];
    assert.deepEqual(mapFuel(raw, counts)?.flowPph, []);
  });

  it("omits payload and weights when a station weight is missing or negative", () => {
    const raw = { ...slowRaw };
    delete raw["stationWeightLb:2"];
    const slow = mapSlow(raw, counts);
    assert.equal(slow.payload, undefined);
    assert.equal(slow.weights, undefined);
    assert.equal(mapPayload({ ...slowRaw, "stationWeightLb:1": -5 }, counts), undefined);
  });

  it("omits engines when a combustion flag is missing", () => {
    const raw = { ...slowRaw };
    delete raw["engineCombustion:2"];
    assert.equal(mapSlow(raw, counts).engines, undefined);
  });

  it("ignores a zero or missing simulation rate", () => {
    assert.equal(mapSlow({ ...slowRaw, simRate: 0 }, counts).simRate, undefined);
    const raw = { ...slowRaw };
    delete raw["simRate"];
    assert.equal(mapSlow(raw, counts).simRate, undefined);
  });

  it("validates zulu parts", () => {
    assert.equal(mapZulu({ ...slowRaw, zuluMonth: 13 }), undefined);
    assert.equal(mapZulu({ ...slowRaw, zuluTimeSec: 90000 }), undefined);
  });

  it("throttles fast data to 5 Hz, 10 Hz below 1,000 ft AGL", () => {
    assert.equal(fastIntervalMs(undefined), 200);
    assert.equal(fastIntervalMs(5000), 200);
    assert.equal(fastIntervalMs(999), 100);
  });

  it("names the simulator from the open response", () => {
    assert.equal(simNameFor("SunRise", "SunRise"), "MSFS 2024");
    assert.equal(simNameFor("KittyHawk", "KittyHawk"), "MSFS 2020");
    assert.equal(simNameFor("Something", "SunRise"), "MSFS 2024");
    assert.equal(simNameFor("Something", "KittyHawk"), "MSFS");
  });

  it("reads Pause_EX1 flags", () => {
    assert.equal(pausedFromEx1(0), false);
    assert.equal(pausedFromEx1(1), true);
    assert.equal(pausedFromEx1(2), true);
    assert.equal(pausedFromEx1(4), true);
    assert.equal(pausedFromEx1(8), false);
  });
});
