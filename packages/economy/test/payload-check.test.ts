import { describe, expect, it } from "vitest";
import { payloadCheckSchema } from "@cargo-ops/protocol";
import {
  checkPayload,
  computePayout,
  crewStations,
  isCrewSeat,
  isPilotSeat,
  payloadMismatch,
  payloadToleranceKg,
  type PayloadCheckInput,
} from "../src/index";

// Worked examples of docs/ECONOMY.md "Payload check". The station list is the replay
// fixture's (demo-kmem-katl.jsonl): Pilot 170 lb + cargo 450/520/480/380 lb = 2,000 lb.
const FIXTURE_STATIONS = [
  { name: "Pilot", weightLb: 170 },
  { name: "Cargo Zone A", weightLb: 450 },
  { name: "Cargo Zone B", weightLb: 520 },
  { name: "Cargo Zone C", weightLb: 480 },
  { name: "Cargo Pod", weightLb: 380 },
];
const AT = "2026-10-14T12:00:00.000Z";

function check(over: Partial<PayloadCheckInput>) {
  const r = checkPayload({
    cargoKg: 840,
    stations: FIXTURE_STATIONS,
    weights: { totalLb: 8430, maxGrossLb: 8750 },
    source: "replay",
    stage: "departure",
    checkedAt: AT,
    ...over,
  });
  // Every result is a valid protocol object.
  expect(payloadCheckSchema.parse(r)).toEqual(r);
  return r;
}

describe("payload check", () => {
  it("tolerance = max(25 kg, 10 % of the cargo)", () => {
    expect(payloadToleranceKg(100)).toBe(25);
    expect(payloadToleranceKg(250)).toBe(25);
    expect(payloadToleranceKg(840)).toBe(84);
    expect(payloadToleranceKg(1234)).toBe(123.4);
  });

  it("crew seats are recognised by their whole name only", () => {
    for (const n of ["Pilot", " Co-Pilot ", "COPILOT", "Captain", "First Officer", "Pilot Seat"]) {
      expect(isPilotSeat(n), n).toBe(true);
    }
    for (const n of ["Crew", "Crew 2", "Crew Seat 1"]) expect(isCrewSeat(n), n).toBe(true);
    for (const n of [
      "Pilot Baggage",
      "Crew Baggage",
      "Pilot bag",
      "Crew compartment",
      "Cargo Zone A",
      "Passenger 1",
      "Station 3",
      "Autopilot bay",
    ]) {
      expect(isPilotSeat(n) || isCrewSeat(n), n).toBe(false);
    }
  });

  it("(a) baggage named after the pilot or crew stays cargo", () => {
    const r = check({
      stations: [
        { name: "Pilot", weightLb: 170 },
        { name: "Pilot Baggage", weightLb: 300 },
        { name: "Crew Baggage", weightLb: 300 },
        { name: "Cargo", weightLb: 1250 },
      ],
    });
    // 2,020 lb = 916.3 kg − Pilot 77.1 kg = 839.2 kg: only the seat is crew.
    expect(r).toMatchObject({ crewKg: 77.1, loadedKg: 839.2, status: "ok" });
  });

  it("(b) no crew seat reported: nothing is subtracted, exact cargo is ok", () => {
    const r = check({ stations: [{ name: "Cargo", weightLb: 441 }], cargoKg: 200 });
    expect(r).toMatchObject({
      simPayloadKg: 200,
      crewKg: 0,
      crewBasis: "default",
      loadedKg: 200,
      toleranceKg: 25,
      status: "ok",
    });
  });

  it("(c) only the first pilot seat is crew: cargo in the copilot seat counts", () => {
    const stations = [
      { name: "Pilot", weightLb: 170 },
      { name: "Pilot Baggage", weightLb: 100 },
      { name: "Copilot", weightLb: 300 },
      { name: "Cargo", weightLb: 500 },
    ];
    expect(crewStations(stations).map((s) => s.name)).toEqual(["Pilot"]);
    // docs/ECONOMY.md example 4: 1,070 lb = 485.3 kg − 77.1 kg = 408.2 kg.
    const r = check({ stations, cargoKg: 400 });
    expect(r).toMatchObject({ crewKg: 77.1, loadedKg: 408.2, status: "ok" });
    // Explicit crew seats all count; the player's setting still overrides.
    const withCrew = [...stations, { name: "Crew 2", weightLb: 180 }];
    expect(crewStations(withCrew).map((s) => s.name)).toEqual(["Pilot", "Crew 2"]);
    expect(check({ stations, cargoKg: 400, crewAllowanceKg: 213.2 }).loadedKg).toBe(272.1);
  });

  it("fixture stations vs 840 kg: 907.2 kg − 77.1 kg Pilot = 830.1 kg → ok", () => {
    const r = check({});
    expect(r).toMatchObject({
      status: "ok",
      stage: "departure",
      source: "replay",
      cargoKg: 840,
      simPayloadKg: 907.2, // 2,000 lb × 0.45359237
      crewKg: 77.1, // the Pilot station, 170 lb
      crewBasis: "stations",
      loadedKg: 830.1,
      toleranceKg: 84,
      totalLb: 8430,
      maxGrossLb: 8750,
    });
    expect(r.message).toMatch(/matches the 840 kg cargo/);
  });

  it("950 kg of cargo on the same stations is underloaded (830.1 < 950 − 95)", () => {
    const r = check({ cargoKg: 950 });
    expect(r.status).toBe("underloaded");
    expect(r.message).toBe("Sim payload 830 kg (after 77 kg crew) is below the 950 kg cargo");
    expect(payloadMismatch(r)).toBe(true);
    // The same shortfall in the live preview is a warning only.
    expect(payloadMismatch({ ...r, stage: "preview" })).toBe(false);
  });

  it("more payload than cargo is fine (extra weight is the pilot's choice)", () => {
    const r = check({ cargoKg: 400 });
    expect(r.status).toBe("ok");
    expect(r.message).toMatch(/extra weight on board/);
  });

  it("no payload stations reported → unknown, never a mismatch", () => {
    for (const stations of [null, undefined, []]) {
      const r = check({ stations, cargoKg: 950 });
      expect(r.status).toBe("unknown");
      expect(r.simPayloadKg).toBeUndefined();
      expect(r.loadedKg).toBeUndefined();
      expect(payloadMismatch(r)).toBe(false);
    }
  });

  it("unnamed stations: 0 kg crew by default", () => {
    const r = check({ stations: [{ name: "Station 1", weightLb: 400 }], cargoKg: 200 });
    expect(r).toMatchObject({ simPayloadKg: 181.4, crewKg: 0, loadedKg: 181.4, status: "ok" });
  });

  it("the player's crew allowance replaces the automatic one", () => {
    const r = check({ crewAllowanceKg: 0 });
    expect(r).toMatchObject({ crewKg: 0, crewBasis: "setting", loadedKg: 907.2 });
    const heavy = check({ crewAllowanceKg: 200 });
    expect(heavy).toMatchObject({ crewKg: 200, loadedKg: 707.2, status: "underloaded" });
  });

  it("a crew allowance above the station sum leaves 0 kg loaded, not a negative", () => {
    const r = check({ stations: [{ name: "Pilot", weightLb: 170 }], cargoKg: 300 });
    expect(r.loadedKg).toBe(0);
    expect(r.status).toBe("underloaded");
  });

  it("above MAX GROSS WEIGHT → overloaded (wins over the cargo comparison)", () => {
    const r = check({ weights: { totalLb: 9000, maxGrossLb: 8750 }, cargoKg: 950 });
    expect(r.status).toBe("overloaded");
    expect(r.message).toBe("Total weight 9000 lb is above the maximum 8750 lb");
    expect(payloadMismatch(r)).toBe(false);
    // Over MTOW is known even without stations; the cargo comparison is not.
    const noStations = check({ weights: { totalLb: 9000, maxGrossLb: 8750 }, stations: [] });
    expect(noStations.status).toBe("overloaded");
  });

  it("unknown MTOW (no weights, or max gross 0) is never reported as overloaded", () => {
    expect(check({ weights: null }).totalLb).toBeUndefined();
    expect(check({ weights: { totalLb: 9000, maxGrossLb: 0 } }).status).toBe("ok");
  });
});

describe("payout with a payload mismatch", () => {
  const job = {
    kind: "cargo" as const,
    weightKg: 500,
    distanceNm: 100,
    units: 1,
    reputation: 50,
    estimate: false,
    landingGrade: "A+" as const,
    lateMin: 0,
  };

  it("removes the bonuses exactly like noBonus, with its own note", () => {
    const clean = computePayout(job);
    const mismatch = computePayout({ ...job, payloadMismatch: true });
    const noBonus = computePayout({ ...job, noBonus: true });
    // Worked example 1 base $1,266.06; A+ and tier 2 bonuses gone → $1,266.
    expect(clean.total).toBe(Math.round(1266.0626 * 1.04 * 1.1));
    expect(mismatch.total).toBe(1266);
    expect(mismatch.total).toBe(noBonus.total);
    expect(mismatch.noBonus).toBe(true);
    expect(mismatch.payloadMismatch).toBe(true);
    expect(noBonus.payloadMismatch).toBeUndefined();
    expect(mismatch.factors.find((f) => f.key === "reputation")?.note).toBe(
      "No bonuses: the sim payload was below the cargo at departure",
    );
  });

  it("keeps the penalties (landing D still × 0.85)", () => {
    const d = computePayout({ ...job, landingGrade: "D", payloadMismatch: true });
    expect(d.factors.find((f) => f.key === "landing")?.value).toBe(0.85);
  });
});
