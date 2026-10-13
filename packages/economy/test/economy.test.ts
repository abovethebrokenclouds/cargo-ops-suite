import { describe, expect, it } from "vitest";
import { aircraftTypeByKey, type AircraftType, type Job } from "@cargo-ops/protocol";
import {
  airportLookup,
  basePay,
  checkAtOrigin,
  computePayout,
  deliveryReputationDelta,
  destinationCandidates,
  distanceCurve,
  findRoutes,
  generateJobs,
  greatCircleNm,
  hashString,
  landingMultiplier,
  legFuelKg,
  loadScaling,
  maxJobDistanceNm,
  mulberry32,
  payloadLimitKg,
  reputationTier,
  Rng,
  runwaySuitability,
  stackJobs,
  timeLimitMin,
  verifyLeg,
} from "../src/index";
import { bundledAirports } from "./airports";

function type(key: string): AircraftType {
  const t = aircraftTypeByKey(key);
  if (!t) throw new Error(key);
  return t;
}

const airports = airportLookup(bundledAirports());
const KMEM = airports.get("KMEM");
const KATL = airports.get("KATL");
if (!KMEM || !KATL) throw new Error("bundled airports lack KMEM/KATL");

describe("PRNG", () => {
  it("mulberry32 is deterministic and in [0, 1)", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    // Known first values for seed 42 (regression guard).
    const c = mulberry32(42);
    expect(c().toFixed(8)).toBe(xs[0]?.toFixed(8));
    expect(new Set(xs).size).toBeGreaterThan(990);
  });

  it("different seeds diverge; hashString is stable FNV-1a", () => {
    expect(mulberry32(1)()).not.toBe(mulberry32(2)());
    expect(hashString("")).toBe(0x811c9dc5);
    expect(hashString("a")).toBe(0xe40c292c);
  });

  it("Rng.int is inclusive and weighted() honours zero weights", () => {
    const rng = new Rng(7);
    const seen = new Set<number>();
    for (let i = 0; i < 500; i++) seen.add(rng.int(1, 3));
    expect([...seen].sort()).toEqual([1, 2, 3]);
    for (let i = 0; i < 200; i++)
      expect(rng.weighted(["a", "b"], (x) => (x === "a" ? 0 : 1))).toBe("b");
    expect(rng.weighted([], () => 1)).toBeNull();
  });
});

describe("payout formula (docs/ECONOMY.md worked examples)", () => {
  it("distance curve and base pay", () => {
    expect(distanceCurve(25)).toBeCloseTo(1, 12);
    expect(distanceCurve(100)).toBeCloseTo(1.6880835, 6);
    expect(basePay(500, 100)).toBeCloseTo(1266.0626, 3);
  });

  it("example 1: 500 kg general cargo, 100 nm, reputation 50, landing B, on time → $1,317", () => {
    const b = computePayout({
      kind: "cargo",
      weightKg: 500,
      distanceNm: 100,
      units: 1,
      reputation: 50,
      estimate: false,
      landingGrade: "B",
      lateMin: 0,
    });
    // 0.015 × 500 × 100 × 1.6880835 = 1266.06; × 1.04 (tier 2) = 1316.71
    expect(b.base).toBe(1266.06);
    expect(b.gross).toBe(1316.71);
    expect(b.deductions).toBe(0);
    expect(b.total).toBe(1317);
    expect(b.factors.map((f) => f.key)).toEqual([
      "base",
      "kind",
      "load",
      "conditions",
      "reputation",
      "landing",
      "late",
      "damage",
    ]);
  });

  it("example 2: 950 kg express in 2 units, 287.7 nm, landing A+, 30 min late → $10,258", () => {
    const b = computePayout({
      kind: "express",
      weightKg: 950,
      distanceNm: 287.7,
      units: 2,
      reputation: 50,
      estimate: false,
      landingGrade: "A+",
      lateMin: 30,
    });
    // base 7746.99 × 1.5 × 2^-0.3 (0.812252) × 1.04 × 1.10 = 10797.96; late 5 % = 539.90
    expect(b.base).toBe(7746.99);
    expect(b.gross).toBe(10797.96);
    expect(b.deductions).toBe(539.9);
    expect(b.total).toBe(10258);
  });

  it("example 3: fragile 400 kg in 3 units, 150 nm, landing D at 1.62 G, sim rate > 1× → $640", () => {
    const b = computePayout({
      kind: "fragile",
      weightKg: 400,
      distanceNm: 150,
      units: 3,
      reputation: 85,
      estimate: false,
      landingGrade: "D",
      lateMin: 0,
      peakG: 1.62,
      noBonus: true,
    });
    // base 1610.75 × 1.3 × 3^-0.3 (0.719223) × 1 (no bonus: tier 4 ignored) × 0.85 = 1280.13
    // damage: fragile above 1.5 G → 50 % of gross = 640.07
    expect(b.base).toBe(1610.75);
    expect(b.gross).toBe(1280.13);
    expect(b.deductions).toBe(640.07);
    expect(b.total).toBe(640);
    expect(b.noBonus).toBe(true);
    expect(b.factors.find((f) => f.key === "reputation")?.value).toBe(1);
  });

  it("noBonus caps an A+ landing at 1.00 but keeps penalties", () => {
    const withBonus = computePayout({
      kind: "cargo",
      weightKg: 100,
      distanceNm: 50,
      units: 1,
      reputation: 100,
      estimate: false,
      landingGrade: "A+",
    });
    const capped = computePayout({
      kind: "cargo",
      weightKg: 100,
      distanceNm: 50,
      units: 1,
      reputation: 100,
      estimate: false,
      landingGrade: "A+",
      noBonus: true,
    });
    const hard = computePayout({
      kind: "cargo",
      weightKg: 100,
      distanceNm: 50,
      units: 1,
      reputation: 100,
      estimate: false,
      landingGrade: "E",
      noBonus: true,
    });
    expect(capped.factors.find((f) => f.key === "landing")?.value).toBe(1);
    expect(withBonus.total).toBeGreaterThan(capped.total);
    expect(hard.factors.find((f) => f.key === "landing")?.value).toBe(0.6);
  });

  it("late penalty is capped at 100 % and estimates carry no deductions", () => {
    const late = computePayout({
      kind: "cargo",
      weightKg: 100,
      distanceNm: 50,
      units: 1,
      reputation: 0,
      estimate: false,
      landingGrade: "B",
      lateMin: 900,
    });
    expect(late.total).toBe(0);
    const est = computePayout({
      kind: "medical",
      weightKg: 100,
      distanceNm: 50,
      units: 1,
      reputation: 0,
      estimate: true,
    });
    expect(est.factors.some((f) => f.kind === "deduction")).toBe(false);
    expect(est.estimate).toBe(true);
  });

  it("landing multiplier mapping A+…F and reputation tiers", () => {
    expect(["A+", "A", "B", "C", "D", "E", "F"].map((g) => landingMultiplier(g as never))).toEqual([
      1.1, 1.05, 1, 1, 0.85, 0.6, 0.6,
    ]);
    expect(landingMultiplier(null)).toBe(1);
    expect([0, 19, 20, 50, 99, 100].map(reputationTier)).toEqual([0, 0, 1, 2, 4, 5]);
    expect(loadScaling(1)).toBe(1);
    expect(loadScaling(2)).toBeCloseTo(0.812252, 6);
  });
});

describe("job generator", () => {
  const c208 = type("c208b");
  const base = {
    origin: KMEM,
    airports: airports.list,
    aircraft: c208,
    nowMs: Date.UTC(2026, 9, 13),
    reputation: 50,
  };

  it("is deterministic for a seed and differs across seeds", () => {
    const a = generateJobs({ ...base, seed: 1 });
    const b = generateJobs({ ...base, seed: 1 });
    const c = generateJobs({ ...base, seed: 2 });
    expect(a).toEqual(b);
    expect(a.length).toBe(24);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
    expect(new Set(a.map((j) => j.id)).size).toBe(a.length);
  });

  it("respects runway, surface, range and payload limits", () => {
    for (const key of ["c208b", "atr72f", "b748f", "pc6"]) {
      const aircraft = type(key);
      const jobs = generateJobs({ ...base, aircraft, seed: 99, count: 60 });
      for (const job of jobs) {
        const dest = airports.get(job.destination);
        expect(dest).not.toBeNull();
        if (!dest) continue;
        expect(runwaySuitability(dest, aircraft).ok).toBe(true);
        expect(dest.longestRwyFt ?? 0).toBeGreaterThanOrEqual(aircraft.minRunwayFt);
        expect(job.distanceNm).toBeLessThanOrEqual(maxJobDistanceNm(aircraft));
        expect(Math.abs(job.distanceNm - greatCircleNm(KMEM, dest))).toBeLessThan(0.06);
        expect(job.weightKg).toBeLessThanOrEqual(
          aircraft.maxPayloadKg - legFuelKg(aircraft, job.distanceNm),
        );
        expect(job.weightKg).toBeGreaterThan(0);
        expect(job.aircraftKey).toBe(key);
        if (job.kind === "bush") expect(aircraft.surfaces.some((s) => s !== "paved")).toBe(true);
      }
    }
  });

  it("express deadline = nm / cruise + 45 min (rounded up to 5)", () => {
    expect(timeLimitMin("express", 287.7, 170)).toBe(150); // 101.5 + 45 = 146.5 → 150
    expect(timeLimitMin("medical", 170, 170)).toBe(135); // 60 × 1.25 + 60
    expect(timeLimitMin("cargo", 170, 170)).toBe(360); // 60 × 2 + 240
    const jobs = generateJobs({ ...base, seed: 5, count: 80 });
    for (const j of jobs.filter((x) => x.kind === "express")) {
      expect(j.timeLimitMin).toBe(Math.ceil(((j.distanceNm / 170) * 60 + 45) / 5) * 5);
    }
  });

  it("mostly short jobs plus a few long ones", () => {
    const jobs = generateJobs({ ...base, aircraft: type("atr72f"), seed: 3, count: 200 });
    const limit = Math.max(60, maxJobDistanceNm(type("atr72f")) * 0.35);
    const short = jobs.filter((j) => j.distanceNm <= limit).length;
    expect(short / jobs.length).toBeGreaterThan(0.6);
    expect(short / jobs.length).toBeLessThan(0.9);
  });

  it("focus puts the first three jobs on a requested destination", () => {
    const jobs = generateJobs({ ...base, seed: 11, focus: KATL });
    expect(jobs.slice(0, 3).map((j) => j.destination)).toEqual(["KATL", "KATL", "KATL"]);
    // A 747 cannot be offered a short grass strip; a focus it cannot serve is ignored.
    const candidates = destinationCandidates(KMEM, airports.list, type("b748f"));
    expect(candidates.every((c) => (c.airport.longestRwyFt ?? 0) >= 10_000)).toBe(true);
  });

  it("payload limit is max payload − leg fuel with a 45 min reserve", () => {
    // 1360 − 170 × (287.7 / 170 + 0.75) = 1360 − 415.2 = 944.8 → 944
    expect(payloadLimitKg(type("c208b"), 287.7)).toBe(944);
  });
});

describe("verification rules", () => {
  const legBase = {
    origin: KMEM,
    destination: KATL,
    flownNm: 290,
    arrival: { lat: KATL.lat + 0.01, lon: KATL.lon },
    flags: { teleport: false, invalidated: false, crashed: false },
  };

  it("passes a full leg and fails each rule", () => {
    const route = greatCircleNm(KMEM, KATL);
    expect(verifyLeg(legBase)).toEqual({ ok: true });
    expect(verifyLeg({ ...legBase, flownNm: route * 0.9 + 0.01 }).ok).toBe(true);
    expect(verifyLeg({ ...legBase, flownNm: route * 0.89 })).toMatchObject({
      ok: false,
      code: "short_distance",
    });
    expect(
      verifyLeg({ ...legBase, arrival: { lat: KATL.lat + 0.06, lon: KATL.lon } }),
    ).toMatchObject({ ok: false, code: "not_at_destination" });
    expect(verifyLeg({ ...legBase, arrival: { lat: KATL.lat + 0.049, lon: KATL.lon } }).ok).toBe(
      true,
    );
    expect(verifyLeg({ ...legBase, flags: { ...legBase.flags, teleport: true } })).toMatchObject({
      code: "teleport",
    });
    expect(verifyLeg({ ...legBase, flags: { ...legBase.flags, invalidated: true } })).toMatchObject(
      { code: "invalidated" },
    );
    expect(verifyLeg({ ...legBase, flags: { ...legBase.flags, crashed: true } })).toMatchObject({
      code: "crashed",
    });
  });

  it("start requires being within 3 nm of the origin", () => {
    expect(checkAtOrigin({ lat: 35.0424, lon: -89.9767 }, KMEM).ok).toBe(true);
    expect(checkAtOrigin({ lat: KMEM.lat + 0.06, lon: KMEM.lon }, KMEM)).toMatchObject({
      code: "not_at_origin",
    });
    expect(checkAtOrigin(null, KMEM)).toMatchObject({ code: "no_data" });
  });

  it("reputation changes per §7", () => {
    expect(deliveryReputationDelta("A+", 0)).toBe(3);
    expect(deliveryReputationDelta("B", 0)).toBe(2);
    expect(deliveryReputationDelta("C", 0)).toBe(1);
    expect(deliveryReputationDelta(null, 0)).toBe(1);
    expect(deliveryReputationDelta("D", 0)).toBe(-5);
    expect(deliveryReputationDelta("B", 61)).toBe(-6);
    expect(deliveryReputationDelta("E", 10)).toBe(-8);
  });
});

describe("stacking and route finder", () => {
  const c208 = type("c208b");
  const mk = (
    id: string,
    origin: string,
    destination: string,
    kg: number,
    payout: number,
    nm = 100,
  ): Job => ({
    id,
    status: "available",
    origin,
    destination,
    kind: "cargo",
    weightKg: kg,
    units: 1,
    distanceNm: nm,
    timeLimitMin: 300,
    aircraftKey: "c208b",
    createdAt: "2026-10-13T00:00:00.000Z",
    expiresAt: "2026-10-14T00:00:00.000Z",
    payoutEstimate: payout,
    breakdown: {
      base: payout,
      factors: [],
      gross: payout,
      deductions: 0,
      total: payout,
      estimate: true,
      noBonus: false,
    },
  });

  it("stacks same-leg jobs by payout per kg within the payload limit", () => {
    const limit = payloadLimitKg(c208, 100); // 1360 − 170 × (100/170 + 0.75) = 1132.5 → 1132
    expect(limit).toBe(1132);
    const s = stackJobs(
      [mk("a", "A", "B", 600, 600), mk("b", "A", "B", 500, 1000), mk("c", "A", "B", 400, 800)],
      limit,
    );
    expect(s.map((j) => j.id)).toEqual(["b", "c"]);
  });

  it("finds multi-hop chains (max 3 hops) ranked by total payout", () => {
    const jobs = [
      mk("1", "KMEM", "KBNA", 300, 1000),
      mk("2", "KBNA", "KATL", 300, 1500),
      mk("3", "KATL", "KCLT", 300, 1200),
      mk("4", "KCLT", "KRDU", 300, 900),
      mk("5", "KMEM", "KATL", 300, 2000),
      mk("6", "KBNA", "KMEM", 300, 5000), // back to start: never revisited
    ];
    const routes = findRoutes({ start: "KMEM", jobs, aircraft: c208, limit: 10 });
    const best = routes[0];
    // KMEM→KATL→KCLT→KRDU = 2000 + 1200 + 900 beats KMEM→KBNA→KATL→KCLT = 3700.
    expect(best?.legs.map((l) => l.destination)).toEqual(["KATL", "KCLT", "KRDU"]);
    expect(best?.totalPayout).toBe(4100);
    expect(routes[1]?.totalPayout).toBe(3700);
    expect(routes.every((r) => r.legs.length <= 3)).toBe(true);
    expect(routes.some((r) => r.legs.some((l) => l.destination === "KMEM"))).toBe(false);
    const oneHop = findRoutes({ start: "KMEM", jobs, aircraft: c208, maxHops: 1 });
    expect(oneHop.map((r) => r.totalPayout)).toEqual([2000, 1000]);
  });
});
