import { describe, expect, it } from "vitest";
import { payloadCheckSchema } from "@cargo-ops/protocol";
import {
  KG_PER_LB,
  checkPayload,
  crossCheckToleranceKg,
  payloadMismatch,
  type PayloadCheckInput,
} from "../src/index";

// Rule matrix of docs/ECONOMY.md "Payload entered by you" and "TOTAL WEIGHT cross-check".
// A payload the player enters can only stand in for an `unknown` station readout; it never
// overrides a sim reading, never earns a bonus and never removes one. The implied payload
// (TOTAL WEIGHT − EMPTY WEIGHT − fuel) is a second, informational source.

// Replay fixture stations: Pilot 170 lb + 1,830 lb cargo = 2,000 lb (907.2 kg, loaded 830.1 kg).
const STATIONS = [
  { name: "Pilot", weightLb: 170 },
  { name: "Cargo Zone A", weightLb: 450 },
  { name: "Cargo Zone B", weightLb: 520 },
  { name: "Cargo Zone C", weightLb: 480 },
  { name: "Cargo Pod", weightLb: 380 },
];
const LIGHT = [
  { name: "Pilot", weightLb: 170 },
  { name: "Cargo Zone A", weightLb: 50 },
];
// Fixture weights: 8,430 − 4,730 − 1,700 fuel = 2,000 lb on board besides fuel.
const WEIGHTS = { totalLb: 8430, emptyLb: 4730, maxGrossLb: 8750 };
const FUEL_LB = 1700;
const AT = "2026-10-14T12:00:00.000Z";

function check(over: Partial<PayloadCheckInput>) {
  const r = checkPayload({
    cargoKg: 840,
    stations: STATIONS,
    weights: WEIGHTS,
    fuelLb: FUEL_LB,
    source: "sim",
    stage: "departure",
    checkedAt: AT,
    ...over,
  });
  expect(payloadCheckSchema.parse(r)).toEqual(r);
  return r;
}

describe("payload entered by you: rule matrix", () => {
  it("no entered value: the check is unchanged and carries no entered fields", () => {
    const r = check({});
    expect(r.status).toBe("ok");
    expect(r.enteredKg).toBeUndefined();
    expect(r.enteredRole).toBeUndefined();
  });

  it("sim ok + entered ok → ok, the entered value agrees", () => {
    const r = check({ enteredPayloadKg: 840 });
    expect(r).toMatchObject({ status: "ok", enteredKg: 840, enteredRole: "agrees" });
    expect(r.loadedKg).toBe(830.1);
  });

  it("sim underloaded + entered ok → still underloaded: a player number never overrides the sim", () => {
    const r = check({ stations: LIGHT, enteredPayloadKg: 840 });
    expect(r).toMatchObject({ status: "underloaded", enteredKg: 840, enteredRole: "contradicts" });
    expect(payloadMismatch(r)).toBe(true);
    expect(r.message).toMatch(/entered by you.*ignored/i);
  });

  it("sim ok + entered too low → still ok: a player number never penalises either", () => {
    const r = check({ enteredPayloadKg: 100 });
    expect(r).toMatchObject({ status: "ok", enteredRole: "contradicts" });
    expect(payloadMismatch(r)).toBe(false);
  });

  it("sim underloaded + entered too low → underloaded, the values agree", () => {
    const r = check({ stations: LIGHT, enteredPayloadKg: 60 });
    expect(r).toMatchObject({ status: "underloaded", enteredRole: "agrees" });
  });

  it("unknown + entered = cargo → stays unknown (bonuses kept), the entered value is used", () => {
    const r = check({ stations: [], enteredPayloadKg: 840 });
    expect(r).toMatchObject({ status: "unknown", enteredKg: 840, enteredRole: "used" });
    expect(r.simPayloadKg).toBeUndefined();
    expect(r.loadedKg).toBeUndefined();
    expect(payloadMismatch(r)).toBe(false);
    expect(r.message).toMatch(/entered by you/i);
  });

  it("unknown + entered below the cargo → still unknown: no penalty from a player number", () => {
    const r = check({ stations: [], enteredPayloadKg: 100 });
    expect(r).toMatchObject({ status: "unknown", enteredRole: "used" });
    expect(payloadMismatch(r)).toBe(false);
    expect(r.message).toMatch(/below the 840 kg cargo/);
  });

  it("unknown + entered that puts empty + fuel + payload above max gross → overloaded (warning only)", () => {
    // 4,730 + 1,700 + 2,500 kg (5,511.6 lb) = 11,941.6 lb > 8,750 lb.
    const r = check({ stations: [], enteredPayloadKg: 2500 });
    expect(r).toMatchObject({ status: "overloaded", overBasis: "entered", enteredRole: "used" });
    expect(payloadMismatch(r)).toBe(false);
    expect(r.message).toMatch(/entered by you/i);
  });

  it("unknown + entered without empty weight or fuel → no overload estimate", () => {
    const r = check({ stations: [], enteredPayloadKg: 2500, fuelLb: null });
    expect(r.status).toBe("unknown");
    expect(r.overBasis).toBeUndefined();
  });

  it("a reported TOTAL WEIGHT above max gross is overloaded whatever was entered", () => {
    const r = check({ weights: { ...WEIGHTS, totalLb: 9000 }, enteredPayloadKg: 10 });
    expect(r).toMatchObject({ status: "overloaded", overBasis: "total_weight" });
  });

  it("unknown without an entered value is unchanged", () => {
    const r = check({ stations: [] });
    expect(r.status).toBe("unknown");
    expect(r.enteredKg).toBeUndefined();
    expect(r.enteredRole).toBeUndefined();
  });

  it("invalid entered values (negative, NaN, Infinity) are ignored", () => {
    for (const v of [-5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const r = check({ stations: [], enteredPayloadKg: v });
      expect(r.enteredKg, String(v)).toBeUndefined();
    }
  });

  it("never: an entered value turns an underloaded sim reading into ok, or anything into underloaded", () => {
    const stationSets = [STATIONS, LIGHT, [], null];
    const entered = [null, 0, 50, 500, 840, 900, 1500, 3000];
    for (const stations of stationSets) {
      const base = check({ stations });
      for (const e of entered) {
        for (const stage of ["preview", "departure"] as const) {
          const r = check({ stations, enteredPayloadKg: e, stage });
          if (base.status === "underloaded") expect(r.status).toBe("underloaded");
          if (base.status === "ok") expect(r.status).toBe("ok");
          if (base.status !== "underloaded") expect(payloadMismatch(r)).toBe(false);
          // Only `unknown` can change, and only towards the overload warning.
          if (r.status !== base.status) {
            expect(base.status).toBe("unknown");
            expect(r).toMatchObject({ status: "overloaded", overBasis: "entered" });
          }
        }
      }
    }
  });
});

describe("TOTAL WEIGHT cross-check", () => {
  it("tolerance = max(100 kg, 10 % of the implied payload)", () => {
    expect(crossCheckToleranceKg(200)).toBe(100);
    expect(crossCheckToleranceKg(907.2)).toBe(100);
    expect(crossCheckToleranceKg(2000)).toBe(200);
  });

  it("fixture: implied 2,000 lb = 907.2 kg matches the station sum", () => {
    const r = check({});
    expect(r).toMatchObject({
      impliedKg: 907.2,
      emptyLb: 4730,
      fuelLb: 1700,
      crossCheck: "match",
      crossCheckWith: "stations",
    });
  });

  it("stations far below what TOTAL WEIGHT implies → mismatch flagged, status unchanged", () => {
    const r = check({ stations: LIGHT });
    // Stations 220 lb = 99.8 kg vs implied 907.2 kg.
    expect(r).toMatchObject({ status: "underloaded", crossCheck: "mismatch", impliedKg: 907.2 });
    expect(r.message).toMatch(/TOTAL WEIGHT/);
  });

  it("unknown + entered: compared with the entered value (plus a crew setting)", () => {
    const ok = check({ stations: [], enteredPayloadKg: 830 });
    expect(ok).toMatchObject({ crossCheck: "match", crossCheckWith: "entered", impliedKg: 907.2 });
    const off = check({ stations: [], enteredPayloadKg: 300 });
    expect(off).toMatchObject({ status: "unknown", crossCheck: "mismatch" });
    const crew = check({ stations: [], enteredPayloadKg: 700, crewAllowanceKg: 200 });
    expect(crew.crossCheck).toBe("match"); // 700 + 200 = 900 vs 907.2
  });

  it("unknown without an entered value: the implied payload is shown, nothing compared", () => {
    const r = check({ stations: [] });
    expect(r.impliedKg).toBe(907.2);
    expect(r.crossCheck).toBeUndefined();
    expect(r.status).toBe("unknown");
  });

  it("no fuel or no empty weight reported → no implied payload is invented", () => {
    expect(check({ fuelLb: null }).impliedKg).toBeUndefined();
    expect(check({ weights: { totalLb: 8430, maxGrossLb: 8750 } }).impliedKg).toBeUndefined();
    expect(check({ weights: null }).impliedKg).toBeUndefined();
  });

  it("TOTAL WEIGHT below empty + fuel → inconsistent sim weights: no implied payload", () => {
    const r = check({ weights: { ...WEIGHTS, totalLb: 6000 } });
    expect(r.impliedKg).toBeUndefined();
    expect(r.crossCheck).toBeUndefined();
  });

  it("KG_PER_LB is the exact pound", () => {
    expect(KG_PER_LB).toBe(0.45359237);
  });
});
