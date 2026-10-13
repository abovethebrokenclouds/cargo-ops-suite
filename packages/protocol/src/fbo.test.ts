import { describe, expect, it } from "vitest";
import {
  EVENT_NAMES,
  KNOWN_COMMANDS,
  LEDGER_CATEGORIES,
  PROTOCOL_VERSION,
  companyDomainSchema,
  demandDomainSchema,
  fboBuyArgsSchema,
  fboModuleUpgradeArgsSchema,
  fboPricingArgsSchema,
  fbosDomainSchema,
  fleetAircraftSchema,
  insuranceBuyArgsSchema,
  jobSchema,
  maintenanceOrderSchema,
  parseClientMessage,
  parseServerMessage,
} from "./index";

// P5 part 2 protocol additions are additive: P5-part-1 frames (no fbos/demand domains, no
// insurance on fleet aircraft, no milestones on the company, no demandFactor on jobs) still
// parse; the new domains, fields, commands and events validate.

const p5Part1Snapshot = {
  type: "snapshot",
  v: PROTOCOL_VERSION,
  seq: 4,
  source: "replay",
  state: {
    company: {
      name: "Cargo Ops Logistics",
      base: "KMEM",
      cash: 256_282.76,
      reputation: 52,
      reputationTier: 2,
      tierName: "Established",
      creditScore: 406,
      netWorth: 2_932_000,
      debt: 0,
      startingCash: 250_000,
      clock: { gameMs: 3_600_000, month: 1, day: 1 },
    },
    fleet: {
      aircraft: [
        {
          id: "AC-1",
          registration: "N124JD",
          typeKey: "c208b",
          typeName: "Cessna 208B Grand Caravan",
          ownership: "owned",
          status: "available",
          location: "KATL",
          hours: 1.77,
          cycles: 1,
          condition: 99.12,
          airworthy: true,
          purchasePrice: 0,
          value: 2_691_906,
          repairCost: 1_900.8,
          repairHours: 3.32,
          financed: false,
          acquiredAt: "2026-10-13T12:00:00.000Z",
          ageYears: 0,
          systems: [],
          maintenance: [],
        },
      ],
      selectedId: "AC-1",
      selection: "single",
      ambiguous: false,
      value: 2_691_906,
      maintenance: [],
    },
    market: { listings: [], generation: 1, refreshedGameMs: 0, nextRefreshGameMs: 604_800_000 },
  },
};

const fbo = {
  id: "FBO-1",
  icao: "KATL",
  name: "Hartsfield Jackson Atlanta International Airport",
  airportType: "large",
  lat: 33.6367,
  lon: -84.4281,
  status: "active",
  origin: "bought",
  acquiredGameMs: 0,
  price: 774_000,
  invested: 774_000,
  value: 657_900,
  financed: true,
  loanId: "LN-1",
  landLeaseMonthly: 0,
  upkeepMonthly: 5_400,
  sizeFactor: 1.5488,
  movementsPerDay: 77.1,
  modules: [
    {
      kind: "fuel",
      label: "Fuel farm",
      level: 1,
      upkeepMonthly: 3_600,
      nextCost: 216_000,
      nextDays: 2,
      effect: "Cost 6 % under the regional price",
    },
    {
      kind: "hangar",
      label: "Hangar",
      level: 0,
      upkeepMonthly: 0,
      nextCost: 180_000,
      nextDays: 2,
      pending: { toLevel: 1, cost: 180_000, readyAtGameMs: 172_800_000 },
      effect: "Hangar not installed",
    },
  ],
  pricing: {
    fuelPriceRatio: 1,
    fuelUsdPerKg: 1.915,
    regionalUsdPerKg: 1.915,
    costUsdPerKg: 1.8,
    handlingFeeUsd: 80,
    referenceHandlingUsd: 80,
    fuelDemand: 1,
    handlingDemand: 1,
  },
  occupancy: { bays: 0, owned: 0, rented: 0, ratio: 0 },
  today: { own: 332.51, modelled: 812.4, simAi: 141.0, movements: 9 },
  daily: [{ day: 0, own: 0, modelled: 2_480.1, simAi: 0, movements: 23 }],
  pnl: [{ month: 0, income: 2_480.1, upkeep: 0, savings: 332.51, net: 2_480.1 }],
  queue: [
    {
      kind: "module",
      module: "hangar",
      toLevel: 1,
      label: "Hangar level 1",
      readyAtGameMs: 172_800_000,
    },
  ],
  aiArrivals: 1,
};

describe("P5 part 2 protocol", () => {
  it("P5-part-1 snapshots still parse (no fbos, demand, insurance, milestones)", () => {
    const r = parseServerMessage(p5Part1Snapshot);
    expect(r.ok).toBe(true);
  });

  it("fbos and demand domains, insurance, milestones and job demand factors validate", () => {
    expect(
      fbosDomainSchema.safeParse({
        fbos: [fbo],
        monthIncome: 2_621.1,
        monthUpkeep: 0,
        value: 657_900,
      }).success,
    ).toBe(true);
    expect(
      fbosDomainSchema.safeParse({
        fbos: [{ ...fbo, status: "sold" }],
        monthIncome: 0,
        monthUpkeep: 0,
        value: 0,
      }).success,
    ).toBe(false);
    expect(
      demandDomainSchema.safeParse({
        indices: [{ icao: "KIND", index: 1.2, activity: 0, eventId: "EV-3-KIND" }],
        events: [
          {
            id: "EV-3-KIND",
            icao: "KIND",
            kind: "storm",
            label: "Storm",
            startGameMs: 259_200_000,
            endGameMs: 345_600_000,
            payoutPct: 20,
            fuelPct: 8,
          },
        ],
      }).success,
    ).toBe(true);
    const aircraft = p5Part1Snapshot.state.fleet.aircraft[0];
    expect(
      fleetAircraftSchema.safeParse({
        ...aircraft,
        insurance: {
          insured: true,
          premiumMonthly: 8_075.72,
          riskFactor: 1,
          coverageShare: 0.8,
          deductible: 2_000,
          sinceGameMs: 0,
          claims: 0,
          claimsPaid: 0,
        },
      }).success,
    ).toBe(true);
    expect(
      companyDomainSchema.safeParse({
        ...p5Part1Snapshot.state.company,
        milestones: [
          {
            id: "first_delivery",
            title: "First delivery",
            description: "Deliver a mission and get paid",
            reached: true,
            gameMs: 7_140_000,
            at: "2026-10-13T14:00:00.000Z",
          },
          { id: "first_fbo", title: "First FBO", description: "Buy or build", reached: false },
        ],
      }).success,
    ).toBe(true);
    expect(maintenanceOrderSchema.shape.shop.safeParse("own").success).toBe(true);
    expect(jobSchema.shape.demandFactor.safeParse(1.12).success).toBe(true);
    expect(jobSchema.shape.demandFactor.safeParse(0).success).toBe(false);
    const delta = parseServerMessage({
      type: "delta",
      v: PROTOCOL_VERSION,
      seq: 9,
      source: "sim",
      patch: { fbos: { monthIncome: 3_000 }, demand: null },
    });
    expect(delta.ok).toBe(true);
  });

  it("new commands, events and ledger categories", () => {
    for (const c of [
      "fbo.buy",
      "fbo.build",
      "fbo.sell",
      "fbo.module.buy",
      "fbo.module.upgrade",
      "fbo.pricing",
      "insurance.buy",
      "insurance.cancel",
    ]) {
      expect(KNOWN_COMMANDS).toContain(c);
      expect(
        parseClientMessage({ type: "command", v: PROTOCOL_VERSION, id: "c1", name: c, args: {} })
          .ok,
      ).toBe(true);
    }
    for (const e of [
      "fbo.income",
      "fbo.built",
      "demand.event",
      "milestone.reached",
      "insurance.claim",
    ]) {
      expect(EVENT_NAMES).toContain(e);
      expect(
        parseServerMessage({
          type: "event",
          v: PROTOCOL_VERSION,
          seq: 1,
          source: "sim",
          name: e,
          data: {},
        }).ok,
      ).toBe(true);
    }
    for (const c of [
      "fbo_income",
      "fbo_upkeep",
      "fbo_purchase",
      "fbo_construction",
      "insurance",
      "insurance_claim",
    ]) {
      expect(LEDGER_CATEGORIES).toContain(c);
    }
    expect(fboBuyArgsSchema.safeParse({ icao: "KATL" }).success).toBe(true);
    expect(
      fboBuyArgsSchema.safeParse({
        icao: "KATL",
        financing: { lenderId: "jetwash", termMonths: 60, principal: 600_000 },
      }).success,
    ).toBe(true);
    expect(fboBuyArgsSchema.safeParse({ icao: "KATL", extra: 1 }).success).toBe(false);
    expect(fboModuleUpgradeArgsSchema.safeParse({ fboId: "FBO-1", module: "pool" }).success).toBe(
      false,
    );
    expect(fboPricingArgsSchema.safeParse({ fboId: "FBO-1", fuelPriceRatio: 1.6 }).success).toBe(
      false,
    );
    expect(fboPricingArgsSchema.safeParse({ fboId: "FBO-1", handlingFeeUsd: 95 }).success).toBe(
      true,
    );
    expect(insuranceBuyArgsSchema.safeParse({ aircraftId: "AC-1" }).success).toBe(true);
  });
});
