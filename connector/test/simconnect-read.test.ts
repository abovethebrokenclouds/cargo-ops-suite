import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RawBuffer } from "node-simconnect";
import { readFrame } from "../src/sim/simconnect-source";
import { mapSlow } from "../src/sim/mapping";
import { buildDatums } from "../src/sim/simvars";

// Builds a buffer in the same layout SimConnect uses for our definition (FLOAT64
// and fixed-length strings in definition order) and reads it back. This proves
// the reader follows the table; it does not prove what MSFS actually sends.
describe("readFrame (definition-order buffer reader)", () => {
  const counts = { engines: 1, stations: 1 };
  const datums = buildDatums("slow", counts);

  function encode(values: Record<string, number | string>): RawBuffer {
    const buf = new RawBuffer(4096);
    for (const d of datums) {
      const value = values[d.rawKey];
      if (d.type === "f64") buf.writeFloat64(typeof value === "number" ? value : 0);
      else if (d.type === "string64") buf.writeString64(String(value ?? ""));
      else buf.writeString256(String(value ?? ""));
    }
    buf.setOffset(0);
    return buf;
  }

  it("reads every datum in order and feeds the mapper", () => {
    const values: Record<string, number | string> = {
      title: "Test Plane",
      atcId: "N123",
      fuelGal: 100,
      fuelLb: 670,
      "fuelFlowPph:1": 40,
      totalWeightLb: 3000,
      emptyWeightLb: 2000,
      maxGrossWeightLb: 3500,
      "stationWeightLb:1": 200,
      "stationName:1": "Cargo",
      "engineCombustion:1": 1,
      parkingBrake: 0,
      simRate: 1,
      zuluTimeSec: 0,
      zuluDay: 1,
      zuluMonth: 1,
      zuluYear: 2026,
    };
    const raw = readFrame(encode(values), datums);
    assert.equal(raw["title"], "Test Plane");
    assert.equal(raw["fuelFlowPph:1"], 40);
    const slow = mapSlow(raw, counts);
    assert.deepEqual(slow.aircraft, { title: "Test Plane", atcId: "N123" });
    assert.deepEqual(slow.payload, { stations: [{ name: "Cargo", weightLb: 200 }] });
    assert.deepEqual(slow.engines, { running: [true] });
    assert.equal(slow.weights?.payloadLb, 200);
  });

  it("throws on a short buffer instead of returning garbage", () => {
    const buf = new RawBuffer(16);
    buf.writeFloat64(1);
    buf.setOffset(0);
    assert.throws(() => readFrame(buf, datums));
  });
});
