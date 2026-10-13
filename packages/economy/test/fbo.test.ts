// P5 part 2: FBO pricing and module economics, the modelled traffic stream (determinism,
// price elasticity), own-arrival benefits (fuel at cost, waived landing fee, crew lounge),
// own maintenance shops in `isMaintenanceCapable` and repair rates, dynamic demand (drift
// and seeded events), hull insurance (premium, claims, write-off loan settlement) and
// milestones. Worked examples match docs/ECONOMY.md ("P5 — FBOs, demand, insurance,
// milestones").

import { describe, expect, it } from "vitest";
import { aircraftTypeByKey, type Defect } from "@cargo-ops/protocol";
import {
  CompanyBook,
  GAME_DAY_MS,
  GAME_MONTH_MS,
  HOUR_MS,
  addActivity,
  airportLookup,
  airportSize,
  boardSeed,
  decayActivity,
  demandFactor,
  demandIndex,
  elasticity,
  emptyLevels,
  eventCandidates,
  expectedDailyIncome,
  fboQuote,
  fuelEventFactor,
  fuelPrice,
  fuelPricing,
  generateJobs,
  hangarNight,
  insurancePremium,
  insuranceRisk,
  milestoneList,
  moduleCost,
  moduleUpkeep,
  movementsPerDay,
  newCompanyCore,
  ownShopCovers,
  repairClaim,
  rollDemandEvent,
  trafficHour,
  writeOffClaim,
  type BookNotice,
  type CompanyCore,
  type DemandEventRecord,
  type FlightSettlement,
} from "../src/index";
import { bundledAirports } from "./airports";

const list = bundledAirports();
const lookup = airportLookup(list);
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const KATL = lookup.get("KATL")!;
const KLIT = lookup.get("KLIT")!;
const KMEM = lookup.get("KMEM")!;
const c208 = aircraftTypeByKey("c208b")!;

function newBook(overrides: Partial<CompanyCore> = {}): CompanyBook {
  const company: CompanyCore = {
    name: "Test Air",
    base: "KMEM",
    seed: 4242,
    cash: 1_000_000,
    reputation: 50,
    ...newCompanyCore(1_000_000),
    ...overrides,
  };
  return new CompanyBook({ company, airports: lookup, now: () => NOW });
}

const names = (n: readonly BookNotice[]) => n.map((x) => x.name);
const cents = (n: number) => Math.round(n * 100);

function leg(over: Partial<FlightSettlement> = {}): FlightSettlement {
  return {
    fuelKg: 282.63,
    fuelAirport: KATL,
    landingAirport: KATL,
    blockMin: 119,
    airborneMin: 106.1,
    peakG: 1.18,
    overspeedEvents: 0,
    crashed: false,
    landings: 1,
    refType: "mission",
    refId: "M-1",
    memo: "Mission M-1",
    ...over,
  };
}

describe("FBO size, quotes and modules", () => {
  it("KATL: s = 1 × 12,390/8,000 × 1 = 1.5488 → buy $774,000, build $425,700 + $3,096/mo, 14 days", () => {
    expect(airportSize(KATL)).toEqual({ s: 1.5488, type: 1, runway: 1.5488, service: 1 });
    expect(fboQuote(KATL)).toEqual({
      icao: "KATL",
      sizeFactor: 1.5488,
      buyPrice: 774_000,
      buildCost: 425_700,
      landLeaseMonthly: 3_096,
      buildDays: 14,
      movementsPerDay: 77.1,
    });
    // KLIT (medium, 8,273 ft, IATA): 0.35 × 1.0341 = 0.3619 → $181,000, 5 days, 8.7 movements.
    expect(fboQuote(KLIT)).toMatchObject({ buyPrice: 181_000, buildDays: 5, movementsPerDay: 8.7 });
    // No IATA code (no scheduled service): × 0.6; unknown runway: 0.4.
    expect(airportSize({ type: "medium", longestRwyFt: 8_000 }).s).toBe(0.21);
    expect(airportSize({ type: "large", iata: "XXX" }).s).toBe(0.4);
    expect(movementsPerDay(1)).toBe(40);
  });

  it("module costs and upkeep scale with clamp(s, 0.4, 1.2)", () => {
    expect(moduleCost("fuel", 1, 1.5488)).toBe(144_000);
    expect(moduleCost("maintenance", 3, 1.5488)).toBe(480_000);
    expect(moduleUpkeep("fuel", 1, 1.5488)).toBe(3_600);
    expect(moduleCost("fuel", 1, 0.3619)).toBe(48_000);
    expect(moduleUpkeep("hangar", 0, 0.3619)).toBe(0);
    expect(moduleCost("ramp", 4, 1)).toBe(0);
  });

  it("price elasticity e(r) = clamp(1 − 3 (r − 1), 0, 1.3)", () => {
    expect([0.8, 0.9, 1, 1.05, 1.1, 1.2, 1.3, 1.4].map(elasticity)).toEqual([
      1.3, 1.3, 1, 0.85, 0.7, 0.4, 0.1, 0,
    ]);
    // Fuel farm L1 at KATL: cost 6 % under the regional $1.915 → $1.800; ratio 1.1 → $2.107.
    expect(fuelPricing(1.915, 1, 1)).toEqual({
      regional: 1.915,
      ratio: 1,
      price: 1.915,
      cost: 1.8,
    });
    expect(fuelPricing(1.915, 1.1, 3).price).toBe(2.107);
    expect(fuelPricing(1.915, 1.1, 3).cost).toBe(1.685);
  });

  it("own shop levels gate severities", () => {
    expect(ownShopCovers(1, "minor")).toBe(true);
    expect(ownShopCovers(1, "major")).toBe(false);
    expect(ownShopCovers(2, "major")).toBe(true);
    expect(ownShopCovers(2, "grounding")).toBe(false);
    expect(ownShopCovers(3, "grounding")).toBe(true);
    expect(ownShopCovers(0, "cosmetic")).toBe(false);
  });
});

describe("modelled traffic stream", () => {
  const s = 1.5488;
  const levels = { ...emptyLevels(), ramp: 1, fuel: 1 };
  const fuel = fuelPricing(1.915, 1, 1);
  const input = {
    companySeed: 4242,
    icao: "KATL",
    airportType: "large" as const,
    s,
    levels,
    fuel,
    handlingFeeUsd: 80,
    fuelSoldTodayKg: 0,
  };

  it("is deterministic per (seed, ICAO, hour) and independent of the modules for movements", () => {
    expect(trafficHour(input, 32)).toEqual(trafficHour(input, 32));
    const more = trafficHour({ ...input, levels: { ...levels, cargo: 3, maintenance: 3 } }, 32);
    expect(more.movements).toBe(trafficHour(input, 32).movements);
    expect(more.captured).toBe(trafficHour(input, 32).captured);
    // Another company sees other traffic.
    let differs = false;
    for (let h = 0; h < 48 && !differs; h++) {
      differs =
        trafficHour({ ...input, companySeed: 1 }, h).movements !== trafficHour(input, h).movements;
    }
    expect(differs).toBe(true);
  });

  it("follows the hour profile and the expected value over a month", () => {
    let night = 0;
    let day = 0;
    let total = 0;
    for (let h = 0; h < 30 * 24; h++) {
      const r = trafficHour(input, h);
      if (h % 24 < 5) night += r.movements;
      if (h % 24 >= 8 && h % 24 < 13) day += r.movements;
      total += r.total;
    }
    expect(day).toBeGreaterThan(night * 4);
    // Expected KATL (ramp 1, fuel farm 1, reference prices): $2,601.94 a day.
    const expected = expectedDailyIncome({
      airportType: "large",
      s,
      levels,
      fuel,
      handlingFeeUsd: 80,
    });
    expect(expected).toBe(2601.94);
    expect(total / 30).toBeGreaterThan(expected * 0.85);
    expect(total / 30).toBeLessThan(expected * 1.15);
  });

  it("too-high prices lose customers (elasticity), within the fuel capacity", () => {
    const sum = (over: Partial<typeof input>, kind: "handling" | "fuel") => {
      let v = 0;
      for (let h = 0; h < 10 * 24; h++) v += trafficHour({ ...input, ...over }, h).byKind[kind];
      return v;
    };
    const ref = sum({}, "handling");
    expect(sum({ handlingFeeUsd: 88 }, "handling")).toBeLessThan(ref * 1.1 * 0.8);
    expect(sum({ handlingFeeUsd: 120 }, "handling")).toBe(0); // r = 1.5 → e = 0
    const fuelRef = sum({}, "fuel");
    expect(sum({ fuel: fuelPricing(1.915, 1.3, 1) }, "fuel")).toBeLessThan(fuelRef);
    // Capacity: a day never sells more than 20,000 kg at level 1.
    let kg = 0;
    for (let h = 0; h < 24; h++) kg += trafficHour({ ...input, fuelSoldTodayKg: kg }, h).fuelKg;
    expect(kg).toBeLessThanOrEqual(20_000);
  });

  it("hangar nights: spare bays rented with the level's chance", () => {
    expect(hangarNight(4242, "KATL", 1, 1, 0, s)).toEqual(hangarNight(4242, "KATL", 1, 1, 0, s));
    expect(hangarNight(4242, "KATL", 1, 1, 2, s).rented).toBe(0); // both bays own aircraft
    expect(hangarNight(4242, "KATL", 1, 0, 0, s)).toEqual({ bays: 0, rented: 0, income: 0 });
    const r = hangarNight(4242, "KATL", 1, 1, 0, s);
    expect(r.income).toBe(r.rented * 108); // $90 × 1.2
  });
});

describe("FBOs in the company book", () => {
  it("buy at KATL, accrue an in-game day of modelled traffic, post it once, upkeep monthly", () => {
    const book = newBook();
    const r = book.buyFbo({ icao: "KATL" });
    if (!r.ok) throw new Error(r.message);
    expect(r.data.fbo).toMatchObject({ icao: "KATL", status: "active", price: 774_000 });
    expect(r.data.fbo.modules.find((m) => m.kind === "fuel")?.level).toBe(1);
    expect(r.data.fbo.modules.find((m) => m.kind === "ramp")?.level).toBe(1);
    expect(book.company.cash).toBe(226_000);
    expect(book.buyFbo({ icao: "KATL" })).toMatchObject({ ok: false, code: "fbo_exists" });
    expect(book.buyFbo({ icao: "ZZZZ" })).toMatchObject({ ok: false, code: "unknown_airport" });
    let d = book.drain();
    expect(d.ledger.map((e) => [e.category, e.amount])).toEqual([["fbo_purchase", -774_000]]);
    expect(names(d.notices)).toContain("milestone.reached");

    // Recompute day 0 independently: 24 seeded hours + the hangar night (none: no hangar).
    const fuel = fuelPricing(fuelPrice(KATL, list).usdPerKg, 1, 1);
    let expected = 0;
    let kg = 0;
    for (let h = 0; h < 24; h++) {
      const t = trafficHour(
        {
          companySeed: 4242,
          icao: "KATL",
          airportType: "large",
          s: 1.5488,
          levels: { ...emptyLevels(), ramp: 1, fuel: 1 },
          fuel,
          handlingFeeUsd: 80,
          fuelSoldTodayKg: kg,
        },
        h,
      );
      expected += t.total;
      kg += t.fuelKg;
    }
    book.advance(GAME_DAY_MS);
    d = book.drain();
    const income = d.ledger.filter((e) => e.category === "fbo_income");
    expect(income).toHaveLength(1);
    expect(cents(income[0]!.amount)).toBe(cents(expected));
    expect(d.fboTransactions.every((t) => t.source === "modelled")).toBe(true);
    expect(cents(d.fboTransactions.reduce((s, t) => s + t.amount, 0))).toBe(cents(expected));
    const state = book.fbosDomain().fbos[0]!;
    expect(state.daily).toHaveLength(1);
    expect(state.daily[0]?.day).toBe(0);
    expect(names(d.notices)).toContain("fbo.income");
    // Month boundary: upkeep ramp $1,800 + fuel farm $3,600.
    book.advance(GAME_MONTH_MS - GAME_DAY_MS);
    d = book.drain();
    expect(d.ledger.filter((e) => e.category === "fbo_upkeep").map((e) => e.amount)).toEqual([
      -5_400,
    ]);
    expect(book.fbosDomain().fbos[0]?.pnl.some((m) => m.upkeep === 5_400)).toBe(true);
    expect(book.netWorth()).toBeGreaterThan(book.company.cash);
  });

  it("own arrival: fuel at the farm's cost, landing fee waived, crew lounge with ramp 2", () => {
    const book = newBook();
    const starter = book.ensureStarter()!;
    book.buyFbo({ icao: "KATL" });
    const fboId = book.fbosDomain().fbos[0]!.id;
    book.drain();
    const r = book.settleFlight(starter.id, leg());
    if (!r.ok) throw new Error(r.message);
    // 282.63 kg × $1.800 = $508.73 instead of × $1.915 = $541.24; landing fee $300 waived.
    expect(r.data.costs.find((c) => c.key === "fuel")?.amount).toBe(508.73);
    expect(r.data.costs.find((c) => c.key === "landing_fee")?.amount).toBe(0);
    const d = book.drain();
    expect(d.ledger.map((e) => e.category)).toEqual(["fuel"]);
    expect(d.fboTransactions.map((t) => [t.kind, t.amount, t.source])).toEqual([
      ["fuel_at_cost", 32.51, "own"],
      ["landing_fee_waived", 300, "own"],
    ]);
    expect(book.fbosDomain().fbos[0]?.today.own).toBe(332.51);
    // Ramp level 2 → crew lounge: +1 reputation once per in-game day.
    expect(book.upgradeModule(fboId, "ramp").ok).toBe(true);
    book.advance(GAME_DAY_MS);
    const rep = book.company.reputation;
    book.settleFlight(starter.id, leg({ refId: "M-2" }));
    book.settleFlight(starter.id, leg({ refId: "M-3" }));
    expect(book.company.reputation).toBe(rep + 1);
  });

  it("an own maintenance shop makes an airport maintenance-capable and repairs cheaper", () => {
    const book = newBook();
    const a = book.ensureStarter()!;
    book.updateAircraft(a.id, { location: "KLIT" });
    expect(book.maintenance.isMaintenanceCapable("KLIT")).toBe(false);
    const fbo = book.buyFbo({ icao: "KLIT" });
    if (!fbo.ok) throw new Error(fbo.message);
    expect(book.buyModule(fbo.data.fbo.id, "maintenance")).toMatchObject({ ok: true });
    expect(book.buyModule(fbo.data.fbo.id, "maintenance")).toMatchObject({
      ok: false,
      code: "module_pending",
    });
    expect(book.maintenance.isMaintenanceCapable("KLIT")).toBe(false); // still installing
    book.advance(2 * GAME_DAY_MS);
    expect(book.maintenance.isMaintenanceCapable("KLIT")).toBe(true);
    const minor: Defect = {
      id: "AC-1-D1",
      system: "gear",
      severity: "minor",
      title: "Worn brake pads",
      repairCost: 4_860,
      downtimeHours: 8,
      hidden: false,
      cause: "wear",
    };
    const grounding: Defect = {
      ...minor,
      id: "AC-1-D2",
      severity: "grounding",
      repairCost: 67_500,
      downtimeHours: 60,
    };
    const now = book.aircraft(a.id)!;
    // Level 1 fixes minor defects at own rates (× 0.75 cost, × 0.7 time) …
    expect(book.repairQuoteFor(now, [minor])).toEqual({ shop: "own", cost: 3_645, hours: 5.6 });
    // … but not a grounding defect: KLIT is not a large airport → field rates.
    expect(book.repairQuoteFor(now, [grounding])).toEqual({
      shop: "field",
      cost: 91_125,
      hours: 90,
    });
    // An annual at the own shop.
    expect(book.shopFor("KLIT", [])).toBe("own");
  });

  it("build: construction cost now, ready after the build days, land lease monthly; modules queue", () => {
    const book = newBook({ cash: 2_000_000, startingCash: 2_000_000 });
    const r = book.buildFbo({ icao: "KLIT" });
    if (!r.ok) throw new Error(r.message);
    expect(r.data.fbo).toMatchObject({ status: "building", price: 99_550, landLeaseMonthly: 724 });
    expect(r.data.fbo.queue[0]).toMatchObject({
      kind: "construction",
      readyAtGameMs: 5 * GAME_DAY_MS,
    });
    expect(book.buyModule(r.data.fbo.id, "hangar")).toMatchObject({
      ok: false,
      code: "fbo_building",
    });
    book.advance(5 * GAME_DAY_MS);
    const d = book.drain();
    expect(d.notices.find((n) => n.name === "fbo.built")?.data).toMatchObject({
      what: "construction",
    });
    expect(book.fbosDomain().fbos[0]?.status).toBe("active");
    expect(book.buyModule(r.data.fbo.id, "hangar").ok).toBe(true);
    expect(book.upgradeModule(r.data.fbo.id, "hangar")).toMatchObject({
      code: "module_not_installed",
    });
    book.advance(2 * GAME_DAY_MS);
    expect(book.buyModule(r.data.fbo.id, "hangar")).toMatchObject({ code: "module_installed" });
    expect(book.upgradeModule(r.data.fbo.id, "hangar").ok).toBe(true);
    expect(book.upgradeModule(r.data.fbo.id, "hangar")).toMatchObject({ code: "module_pending" });
    const state = book.fbosDomain().fbos[0]!;
    // invested = 99,550 + hangar L1 60,000 + L2 80,000 (× 0.4)
    expect(state.invested).toBe(239_550);
    expect(state.queue[0]).toMatchObject({ module: "hangar", toLevel: 2 });
    book.advance(GAME_MONTH_MS);
    const lease = book.drain().ledger.filter((e) => e.category === "fbo_upkeep");
    // Land lease $724 + ramp L1 $600 + hangar L2 $1,600.
    expect(lease.map((e) => e.amount)).toEqual([-2_924]);
  });

  it("finance with an FBO as collateral; selling pays 75 % of the investment and the loan", () => {
    const book = newBook({ cash: 300_000, startingCash: 300_000 });
    const r = book.buyFbo({
      icao: "KATL",
      financing: { lenderId: "jetwash", termMonths: 60, principal: 500_000 },
    });
    if (!r.ok) throw new Error(r.message);
    expect(r.data.loan?.collateral).toEqual({ type: "fbo", id: r.data.fbo.id });
    expect(book.fbosDomain().fbos[0]?.financed).toBe(true);
    expect(
      book.takeLoan({
        lenderId: "jetwash",
        principal: 10_000,
        termMonths: 12,
        collateral: { type: "fbo", id: r.data.fbo.id },
      }),
    ).toMatchObject({ ok: false, code: "collateral_encumbered" });
    book.drain();
    const sold = book.sellFbo(r.data.fbo.id);
    if (!sold.ok) throw new Error(sold.message);
    expect(sold.data).toEqual({ price: 580_500, loanPaid: 500_000 });
    const d = book.drain();
    expect(d.ledger.map((e) => [e.category, e.amount])).toEqual([
      ["sale", 580_500],
      ["loan_payment", -500_000],
    ]);
    expect(book.fbosDomain().fbos).toHaveLength(0);
    // FBO purchases and construction are capital: no operating P&L.
    expect(book.company.pnl.every((m) => m.expense < 10_000)).toBe(true);
  });
});

describe("dynamic demand", () => {
  it("index = 1 + activity + event uplift; factor = clamp(mean, 0.8, 1.5); decay × 0.85/day", () => {
    let act = addActivity({}, "KATL", -0.03);
    act = addActivity(act, "KATL", -0.03);
    expect(act).toEqual({ KATL: -0.06 });
    const storm: DemandEventRecord = {
      id: "EV-1-KATL",
      icao: "KATL",
      kind: "storm",
      startGameMs: GAME_DAY_MS,
      endGameMs: 3 * GAME_DAY_MS,
    };
    expect(demandIndex("KATL", act, [storm], 0)).toBe(0.94);
    expect(demandIndex("KATL", act, [storm], 2 * GAME_DAY_MS)).toBe(1.14);
    expect(demandIndex("KATL", act, [storm], 3 * GAME_DAY_MS)).toBe(0.94);
    expect(demandFactor(1, 1.14)).toBe(1.07);
    expect(demandFactor(0.5, 0.5)).toBe(0.8);
    expect(fuelEventFactor("KATL", [storm], 2 * GAME_DAY_MS)).toBe(1.08);
    expect(decayActivity(act)).toEqual({ KATL: -0.051 });
    expect(decayActivity({ KATL: 0.001 })).toEqual({});
    expect(addActivity({}, "KMEM", 0.5)).toEqual({ KMEM: 0.1 });
  });

  it("events: seeded per day, at most one per airport, never on day 0", () => {
    const withFbo = eventCandidates(KMEM, list, ["KLIT"]);
    expect(withFbo.some((a) => a.ident === "KLIT")).toBe(true);
    expect(withFbo.every((a) => a.ident === "KLIT" || a.type === "large")).toBe(true);
    const cands = eventCandidates(KMEM, list, []);
    expect(cands).toHaveLength(43);
    expect(rollDemandEvent(4242, 0, cands, [])).toBeNull();
    const a: DemandEventRecord[] = [];
    const b: DemandEventRecord[] = [];
    for (let d = 1; d <= 60; d++) {
      const x = rollDemandEvent(4242, d, cands, a);
      if (x) a.push(x);
      const y = rollDemandEvent(4242, d, cands, b);
      if (y) b.push(y);
    }
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(15);
    expect(a.length).toBeLessThan(45);
    // Seed 4242, KMEM base: the first event is a storm at KIND on day 3, one day long.
    expect(a[0]).toEqual({
      id: "EV-3-KIND",
      icao: "KIND",
      kind: "storm",
      startGameMs: 3 * GAME_DAY_MS,
      endGameMs: 4 * GAME_DAY_MS,
    });
    for (const e of a) {
      const overlapping = a.filter(
        (o) =>
          o !== e &&
          o.icao === e.icao &&
          o.startGameMs < e.endGameMs &&
          e.startGameMs < o.endGameMs,
      );
      expect(overlapping).toEqual([]);
    }
  });

  it("deliveries saturate the destination; the board carries the factor into the payout", () => {
    const book = newBook();
    expect(book.jobDemand("KMEM").demand(KATL)).toBe(1);
    book.recordDelivery({ origin: "KMEM", destination: "KATL", grade: "B" });
    expect(book.demandAt("KATL")).toBe(0.97);
    expect(book.demandAt("KMEM")).toBe(1.01);
    expect(book.demandDomain().indices.map((i) => i.icao)).toEqual(["KATL", "KMEM"]);
    const demand = book.jobDemand("KMEM").demand;
    expect(demand(KATL)).toBe(0.99);
    const seed = boardSeed(4242, "KMEM", "c208b", 1);
    const base = { origin: KMEM, airports: list, aircraft: c208, seed, nowMs: NOW, reputation: 50 };
    const plain = generateJobs(base);
    const shaped = generateJobs({ ...base, demand: () => 1.2, extraJobs: 4 });
    expect(shaped).toHaveLength(plain.length + 4);
    for (const [i, j] of plain.entries()) {
      const k = shaped[i]!;
      expect(k.id).toBe(j.id);
      expect(k.weightKg).toBe(j.weightKg);
      expect(k.demandFactor).toBe(1.2);
      expect(k.breakdown.factors.find((f) => f.key === "demand")?.value).toBe(1.2);
      expect(Math.abs(k.payoutEstimate - j.payoutEstimate * 1.2)).toBeLessThanOrEqual(1);
    }
    expect(plain.every((j) => j.demandFactor === undefined)).toBe(true);
  });

  it("the company clock rolls events and storm weather wear spares aircraft in an own hangar", () => {
    const book = newBook({ cash: 5_000_000, startingCash: 5_000_000 });
    const a = book.ensureStarter()!;
    // Seed 4242: the first storm hits KIND on day 3. Park the starter there.
    book.updateAircraft(a.id, { location: "KIND" });
    book.advance(3 * GAME_DAY_MS);
    const d = book.drain();
    expect(d.demandEvents.map((e) => e.id)).toContain("EV-3-KIND");
    expect(book.demandDomain().events[0]).toMatchObject({
      icao: "KIND",
      kind: "storm",
      payoutPct: 20,
    });
    book.advance(GAME_DAY_MS);
    expect(book.aircraft(a.id)?.condition).toBe(99.6);
    // With an own hangar the same storm day costs nothing (level 3 cuts 100 %).
    const b = newBook({ cash: 5_000_000, startingCash: 5_000_000 });
    const s = b.ensureStarter()!;
    b.updateAircraft(s.id, { location: "KIND" });
    const f = b.buyFbo({ icao: "KIND" });
    if (!f.ok) throw new Error(f.message);
    b.buyModule(f.data.fbo.id, "hangar");
    b.advance(2 * GAME_DAY_MS);
    b.upgradeModule(f.data.fbo.id, "hangar");
    b.advance(0.9 * GAME_DAY_MS);
    // Level 2 still pending (3 days): level 1 → −60 % → 0.16 points.
    b.advance(1.1 * GAME_DAY_MS);
    expect(b.aircraft(s.id)?.condition).toBe(99.84);
  });
});

describe("hull insurance", () => {
  it("premium = 0.3 % × value × risk; risk from hard landings and crashes", () => {
    expect(insurancePremium(2_700_000, 1)).toBe(8_100);
    expect(insuranceRisk([{ gameMs: 0, kind: "hard_landing" }], GAME_DAY_MS)).toBe(1.25);
    expect(insuranceRisk([{ gameMs: 0, kind: "hard_landing" }], 181 * GAME_DAY_MS)).toBe(1);
    expect(
      insuranceRisk(
        [
          { gameMs: 0, kind: "crash" },
          { gameMs: 0, kind: "crash" },
          { gameMs: 0, kind: "crash" },
        ],
        1,
      ),
    ).toBe(3);
    expect(repairClaim(10_000)).toBe(6_400);
    expect(repairClaim(1_500)).toBe(0);
    expect(writeOffClaim(2_673_318.6)).toBe(2_138_654.88);
  });

  it("buy, monthly premium, incident repair claim; cancel", () => {
    const book = newBook();
    const a = book.ensureStarter()!;
    expect(book.buyInsurance(a.id)).toEqual({ ok: true, data: { premium: 8_100 } });
    expect(book.buyInsurance(a.id)).toMatchObject({ ok: false, code: "already_insured" });
    book.drain();
    // A hard landing (2.0 G) raises the risk and the next premium.
    book.settleFlight(a.id, leg({ peakG: 2.0, landingAirport: KMEM, fuelAirport: KMEM }));
    const after = book.aircraft(a.id)!;
    expect(book.insuranceState(after).riskFactor).toBe(1.25);
    book.advance(GAME_MONTH_MS);
    const d = book.drain();
    const premium = d.ledger.find((e) => e.category === "insurance");
    expect(premium?.amount).toBe(
      -Math.round(book.aircraftValue(book.aircraft(a.id)!) * 0.003 * 1.25 * 100) / 100,
    );
    // An incident repair is claimed.
    const hard: Defect = {
      id: "AC-1-D9",
      system: "gear",
      severity: "major",
      title: "Bent gear leg",
      repairCost: 19_440,
      downtimeHours: 24,
      hidden: false,
      cause: "hard_landing",
    };
    const cur = book.aircraft(a.id)!;
    book.updateAircraft(a.id, { defects: [...cur.defects, hard] });
    book.drain();
    const r = book.repairDefect(a.id, hard.id);
    expect(r.ok).toBe(true);
    const c = book.drain();
    // KMEM is a large airport: $19,440 → claim 80 % × ($19,440 − $2,000) = $13,952.
    expect(c.ledger.map((e) => [e.category, e.amount])).toEqual([
      ["repair", -19_440],
      ["insurance_claim", 13_952],
    ]);
    expect(names(c.notices)).toContain("insurance.claim");
    expect(book.cancelInsurance(a.id).ok).toBe(true);
    expect(book.cancelInsurance(a.id)).toMatchObject({ ok: false, code: "not_insured" });
  });

  it("an insured write-off pays 80 % of the hull value and settles the loan from it", () => {
    const book = newBook();
    const a = book.ensureStarter()!;
    const loan = book.takeLoan({
      lenderId: "jetwash",
      principal: 1_000_000,
      termMonths: 36,
      collateral: { type: "aircraft", id: a.id },
    });
    if (!loan.ok) throw new Error(loan.message);
    book.updateAircraft(a.id, { condition: 70 });
    book.buyInsurance(a.id);
    const value = book.aircraftValue(book.aircraft(a.id)!);
    book.drain();
    const r = book.settleFlight(a.id, leg({ crashed: true, landingAirport: null, landings: 0 }));
    if (!r.ok) throw new Error(r.message);
    expect(r.data.writtenOff).toBe(true);
    const d = book.drain();
    const claim = d.ledger.find((e) => e.category === "insurance_claim");
    expect(claim?.amount).toBe(writeOffClaim(value));
    expect(d.ledger.find((e) => e.category === "loan_payment")?.amount).toBe(-1_000_000);
    expect(book.loans.get(loan.data.id)?.status).toBe("paid_off");
    expect(names(d.notices)).toContain("insurance.claim");
    // Uninsured: the loan stays active (P5 part 1 behaviour).
    const u = newBook();
    const s = u.ensureStarter()!;
    const l2 = u.takeLoan({
      lenderId: "jetwash",
      principal: 1_000_000,
      termMonths: 36,
      collateral: { type: "aircraft", id: s.id },
    });
    if (!l2.ok) throw new Error(l2.message);
    u.updateAircraft(s.id, { condition: 70 });
    expect(
      u.settleFlight(s.id, leg({ crashed: true, landingAirport: null, landings: 0 })),
    ).toMatchObject({
      ok: true,
      data: { writtenOff: true },
    });
    expect(u.loans.get(l2.data.id)?.status).toBe("active");
  });
});

describe("milestones", () => {
  it("first delivery, landing streak, first FBO, debt-free, fleet of three — reached once, dated", () => {
    let wall = NOW;
    const book = new CompanyBook({
      company: {
        name: "Test Air",
        base: "KMEM",
        seed: 4242,
        cash: 2_000_000,
        reputation: 50,
        ...newCompanyCore(2_000_000),
      },
      airports: lookup,
      now: () => wall,
    });
    const a = book.ensureStarter()!;
    book.drain();
    for (let i = 0; i < 5; i++) {
      book.advance(HOUR_MS);
      book.recordDelivery({ origin: "KMEM", destination: "KATL", grade: i === 0 ? "A+" : "A" });
      const d = book.drain();
      const reached = d.milestones.map((m) => m.id);
      if (i === 0) expect(reached).toEqual(["first_delivery"]);
      if (i === 4) expect(reached).toEqual(["landing_streak"]);
    }
    wall += 1_000;
    book.buyFbo({ icao: "KLIT" });
    const loan = book.takeLoan({
      lenderId: "jetwash",
      principal: 100_000,
      termMonths: 12,
      collateral: { type: "aircraft", id: a.id },
    });
    if (!loan.ok) throw new Error(loan.message);
    expect(book.drain().milestones.map((m) => m.id)).toEqual(["first_fbo"]);
    book.payoff(loan.data.id);
    expect(book.lease({ typeKey: "c208b", kind: "wet" }).ok).toBe(true);
    expect(book.lease({ typeKey: "kodiak100", kind: "dry" }).ok).toBe(true);
    expect(book.drain().milestones.map((m) => m.id)).toEqual(["debt_free", "fleet_three"]);
    const list = milestoneList(book.company.milestones);
    expect(list.filter((m) => m.reached).map((m) => m.id)).toEqual([
      "first_delivery",
      "first_fbo",
      "debt_free",
      "landing_streak",
      "fleet_three",
    ]);
    expect(list.find((m) => m.id === "first_fbo")?.at).toBe(new Date(NOW + 1_000).toISOString());
    expect(list.find((m) => m.id === "first_delivery")?.gameMs).toBe(HOUR_MS);
    expect(book.drain().milestones).toEqual([]);
    // A non-A landing resets the streak.
    book.recordDelivery({ origin: "KMEM", destination: "KATL", grade: "C" });
    expect(book.company.landingStreak).toBe(0);
  });
});
