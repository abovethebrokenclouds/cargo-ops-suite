// AI traffic near own FBO airports (plan §7.3, income source 3): the pure arrival
// detection with hand-made object samples, the request radius around the user aircraft,
// and the SimConnect sampler's packet handling against a stand-in handle (the real
// simulator path is unverified until the Windows PC; see docs/VERIFICATION.md).

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RawBuffer, SimObjectType, type RecvSimObjectData } from "node-simconnect";
import {
  AiArrivalDetector,
  FakeAiTraffic,
  SIMCONNECT_MAX_RADIUS_M,
  SimConnectAiSampler,
  distanceM,
  requestRadiusM,
  type AiObjectSample,
  type AiTarget,
} from "../src/sim/ai-traffic";

const KATL: AiTarget = { fboId: "FBO-1", icao: "KATL", lat: 33.6367, lon: -84.4281 };
const KMEM: AiTarget = { fboId: "FBO-2", icao: "KMEM", lat: 35.0424, lon: -89.9767 };

const at = (
  lat: number,
  lon: number,
  onGround: boolean,
  gsKt: number,
  objectId = 1,
): AiObjectSample => ({
  objectId,
  lat,
  lon,
  onGround,
  gsKt,
});

describe("AiArrivalDetector (hand-made samples)", () => {
  it("credits a landing once: airborne in the radius → on ground and slow", () => {
    const d = new AiArrivalDetector();
    assert.deepEqual(d.update([at(33.6, -84.47, false, 150)], [KATL], 0), []);
    assert.deepEqual(d.update([at(33.63, -84.44, true, 80)], [KATL], 30_000), []);
    const arrivals = d.update([at(33.64, -84.43, true, 15)], [KATL], 60_000);
    assert.deepEqual(arrivals, [{ objectId: 1, fboId: "FBO-1", icao: "KATL", at: 60_000 }]);
    // Still slow, still there: not credited again; nor after another landing within 6 h.
    assert.deepEqual(d.update([at(33.64, -84.43, true, 0)], [KATL], 90_000), []);
    d.update([at(33.6, -84.47, false, 150)], [KATL], 2 * 3_600_000);
    assert.deepEqual(d.update([at(33.64, -84.43, true, 10)], [KATL], 2 * 3_600_000 + 30_000), []);
    // After the 6 h memory the id may be reused by the sim for a new arrival.
    d.update([at(33.6, -84.47, false, 150)], [KATL], 9 * 3_600_000);
    assert.equal(d.update([at(33.64, -84.43, true, 10)], [KATL], 9 * 3_600_000 + 30_000).length, 1);
  });

  it("never credits a parked spawn, a fast roll, or traffic outside 10 km", () => {
    const d = new AiArrivalDetector();
    // Parked at a gate since first sight.
    assert.deepEqual(d.update([at(33.64, -84.43, true, 0, 2)], [KATL], 0), []);
    assert.deepEqual(d.update([at(33.64, -84.43, true, 3, 2)], [KATL], 30_000), []);
    // Taxiing fast (35 kt): neither moving (≤ 40) nor slow (≥ 30).
    assert.deepEqual(d.update([at(33.64, -84.43, true, 35, 2)], [KATL], 60_000), []);
    assert.deepEqual(d.update([at(33.64, -84.43, true, 5, 2)], [KATL], 90_000), []);
    // 20 km away: ignored even when it lands there.
    const far = { lat: 33.82, lon: -84.43 };
    assert.ok(distanceM(far, KATL) > 10_000);
    d.update([at(far.lat, far.lon, false, 120, 3)], [KATL], 0);
    assert.deepEqual(d.update([at(far.lat, far.lon, true, 10, 3)], [KATL], 30_000), []);
    // Non-finite samples are skipped.
    assert.deepEqual(d.update([at(Number.NaN, -84.43, true, 1, 4)], [KATL], 0), []);
  });

  it("tracks each airport separately and keeps the ATC id", () => {
    const d = new AiArrivalDetector();
    const s1 = { ...at(35.03, -89.99, false, 120, 5), atcId: "FDX1" };
    d.update([s1, at(33.6, -84.47, false, 150, 5)], [KATL, KMEM], 0);
    const r = d.update([{ ...at(35.04, -89.98, true, 8, 5), atcId: "FDX1" }], [KATL, KMEM], 30_000);
    assert.deepEqual(r, [{ objectId: 5, fboId: "FBO-2", icao: "KMEM", at: 30_000, atcId: "FDX1" }]);
  });
});

describe("requestRadiusM (centred on the user aircraft)", () => {
  it("reaches the farthest FBO within 190 km plus 10 km; null when none is in reach", () => {
    const user = { lat: 33.75, lon: -84.39 }; // ~13 km from KATL
    const r = requestRadiusM(user, [KATL]);
    assert.ok(r !== null && r > 20_000 && r < 25_000);
    assert.equal(requestRadiusM(user, [KMEM]), null); // ~540 km
    assert.equal(requestRadiusM(user, []), null);
    const atKatl = requestRadiusM({ lat: KATL.lat, lon: KATL.lon }, [KATL, KMEM]);
    assert.equal(atKatl, 10_000);
    assert.ok((requestRadiusM(user, [KATL, KMEM]) ?? 0) <= SIMCONNECT_MAX_RADIUS_M);
  });
});

/** A stand-in for the SimConnect handle: records definitions and requests. */
function fakeHandle() {
  const defs: Array<[number, string, string | null, number]> = [];
  const requests: Array<[number, number, number, SimObjectType]> = [];
  return {
    defs,
    requests,
    addToDataDefinition(def: number, name: string, unit: string | null, type: number) {
      defs.push([def, name, unit, type]);
      return defs.length;
    },
    requestDataOnSimObjectType(req: number, def: number, radius: number, type: SimObjectType) {
      requests.push([req, def, radius, type]);
      return requests.length;
    },
  };
}

function packet(
  requestID: number,
  objectID: number,
  entryNumber: number,
  outOf: number,
  v: { lat: number; lon: number; onGround: number; gs: number; atc: string },
): RecvSimObjectData {
  const data = new RawBuffer(512);
  data.writeFloat64(v.lat);
  data.writeFloat64(v.lon);
  data.writeFloat64(v.onGround);
  data.writeFloat64(v.gs);
  data.writeString64(v.atc);
  data.setOffset(0);
  return {
    requestID,
    objectID,
    defineID: 1,
    flags: 0,
    entryNumber,
    outOf,
    defineCount: 5,
    data,
  } as unknown as RecvSimObjectData;
}

describe("SimConnectAiSampler (stand-in handle)", () => {
  it("defines lat/lon/ground/GS/ATC id, requests AIRCRAFT around the user, batches replies", () => {
    const h = fakeHandle();
    const batches: Array<{ samples: AiObjectSample[]; at: number }> = [];
    const sampler = new SimConnectAiSampler(
      h as never,
      { defineId: 40, requestId: 41 },
      () => {},
      (samples, at) => batches.push({ samples, at }),
    );
    assert.deepEqual(
      h.defs.map((d) => d[1]),
      ["PLANE LATITUDE", "PLANE LONGITUDE", "SIM ON GROUND", "GROUND VELOCITY", "ATC ID"],
    );
    // No FBO in reach: no request.
    sampler.sample({ lat: 51.47, lon: -0.45 }, [KATL], 0);
    assert.equal(h.requests.length, 0);
    sampler.sample({ lat: 33.75, lon: -84.39 }, [KATL], 0);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0]?.[3], SimObjectType.AIRCRAFT);
    // A request in flight is not repeated within two intervals.
    sampler.sample({ lat: 33.75, lon: -84.39 }, [KATL], 30_000);
    assert.equal(h.requests.length, 1);
    // Two entries (1/2, 2/2), then a foreign request id is ignored.
    assert.equal(
      sampler.onData(
        packet(41, 101, 1, 2, { lat: 33.6, lon: -84.4, onGround: 0, gs: 140, atc: "DAL1" }),
        1,
      ),
      true,
    );
    assert.equal(batches.length, 0);
    sampler.onData(
      packet(41, 102, 2, 2, { lat: 33.64, lon: -84.43, onGround: 1, gs: 0, atc: "" }),
      2,
    );
    assert.equal(
      sampler.onData(packet(99, 1, 1, 1, { lat: 0, lon: 0, onGround: 0, gs: 0, atc: "" }), 3),
      false,
    );
    assert.deepEqual(batches, [
      {
        at: 2,
        samples: [
          { objectId: 101, lat: 33.6, lon: -84.4, onGround: false, gsKt: 140, atcId: "DAL1" },
          { objectId: 102, lat: 33.64, lon: -84.43, onGround: true, gsKt: 0 },
        ],
      },
    ]);
    // An empty reply (outOf 0) closes an empty batch and allows the next request.
    sampler.sample({ lat: 33.75, lon: -84.39 }, [KATL], 60_000);
    sampler.onData(packet(41, 0, 0, 0, { lat: 0, lon: 0, onGround: 0, gs: 0, atc: "" }), 4);
    assert.deepEqual(batches.at(-1), { at: 4, samples: [] });
  });

  it("FakeAiTraffic replays scripted batches in order", () => {
    const seen: number[] = [];
    const fake = new FakeAiTraffic(
      [
        { at: 1, samples: [] },
        { at: 2, samples: [at(0, 0, true, 0)] },
      ],
      (_s, t) => seen.push(t),
    );
    assert.equal(fake.next(), true);
    fake.playAll();
    assert.equal(fake.next(), false);
    assert.deepEqual(seen, [1, 2]);
  });
});
