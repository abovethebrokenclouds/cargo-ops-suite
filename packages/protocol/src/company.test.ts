import { describe, expect, it } from "vitest";
import {
  EVENT_NAMES,
  KNOWN_COMMANDS,
  PROTOCOL_VERSION,
  fleetBuyArgsSchema,
  loanTakeArgsSchema,
  parseClientMessage,
  parseServerMessage,
} from "./index";

// P4 protocol additions must be backward compatible: frames a P3 connector sends still
// parse, and the new domains, events and commands validate.

const p3Company = {
  name: "Cargo Ops Logistics",
  base: "KMEM",
  cash: 257_124,
  reputation: 52,
  reputationTier: 2,
};

const p3Mission = {
  id: "M-1",
  status: "delivered",
  origin: "KMEM",
  destination: "KATL",
  jobIds: ["J-1"],
  jobs: [],
  aircraftKey: "c208b",
  payloadKg: 840,
  distanceNm: 287.7,
  timeLimitMin: 600,
  expectedPayout: 7124,
  createdAt: "2026-10-13T12:00:00.000Z",
  payout: {
    total: 7124,
    jobs: [
      {
        base: 6849.98,
        factors: [],
        gross: 7123.98,
        deductions: 0,
        total: 7124,
        estimate: false,
        noBonus: false,
      },
    ],
  },
};

const fleet = {
  aircraft: [
    {
      id: "AC-1",
      registration: "N124JD",
      typeKey: "c208b",
      typeName: "Cessna 208B Grand Caravan",
      ownership: "owned",
      status: "available",
      location: "KATL",
      hours: 1.67,
      cycles: 1,
      condition: 99.17,
      airworthy: true,
      purchasePrice: 0,
      value: 2_691_906,
      repairCost: 1_792.8,
      repairHours: 3.25,
      financed: true,
      loanId: "LN-1",
      acquiredAt: "2026-10-13T12:00:00.000Z",
    },
  ],
  selectedId: "AC-1",
  selection: "title",
  ambiguous: false,
  value: 2_691_906,
};

const loans = {
  loans: [
    {
      id: "LN-1",
      lenderId: "jetwash",
      lenderName: "Jetwash Credit",
      principal: 400_000,
      apr: 16.91,
      termMonths: 36,
      payment: 14_237.48,
      balance: 400_000,
      collateral: { type: "aircraft", id: "AC-1" },
      nextDueGameMs: 2_592_000_000,
      missedCount: 0,
      paymentsMade: 0,
      status: "active",
      takenAt: "2026-10-13T12:00:00.000Z",
      takenGameMs: 0,
    },
  ],
  creditScore: 400,
  defaultUntilGameMs: null,
  offers: [],
  monthlyDebtService: 14_237.48,
  monthlyIncome: 0,
  debtToIncome: null,
};

const ledger = {
  recent: [
    {
      at: "2026-10-13T12:00:00.000Z",
      gameMs: 0,
      category: "loan_disbursement",
      amount: 400_000,
      balance: 650_000,
      refType: "loan",
      refId: "LN-1",
      memo: null,
    },
  ],
  months: [{ month: 0, revenue: 0, expense: 4000, net: -4000 }],
  startingCash: 250_000,
  entries: 2,
};

const frame = (state: unknown) => ({
  type: "snapshot",
  v: PROTOCOL_VERSION,
  seq: 1,
  source: "replay",
  state,
});

describe("P4 protocol (additive)", () => {
  it("P3 frames still parse: minimal company, mission payout without costs, no fleet", () => {
    const r = parseServerMessage(frame({ company: p3Company, mission: p3Mission }));
    expect(r.ok).toBe(true);
    const delta = parseServerMessage({
      type: "delta",
      v: PROTOCOL_VERSION,
      seq: 2,
      source: "sim",
      patch: { company: { cash: 1 } },
    });
    expect(delta.ok).toBe(true);
    for (const name of ["job.completed", "mission.delivered", "mission.failed"]) {
      expect(
        parseServerMessage({
          type: "event",
          v: PROTOCOL_VERSION,
          seq: 3,
          source: "sim",
          name,
          data: {},
        }).ok,
      ).toBe(true);
    }
  });

  it("the P4 company fields, fleet, loans and ledger domains validate", () => {
    const company = {
      ...p3Company,
      tierName: "Established",
      creditScore: 400,
      netWorth: 2_941_906,
      debt: 400_000,
      startingCash: 250_000,
      clock: { gameMs: 0, month: 1, day: 1 },
    };
    const mission = {
      ...p3Mission,
      aircraftId: "AC-1",
      registration: "N124JD",
      wear: 0.83,
      payout: {
        ...p3Mission.payout,
        costs: [
          { key: "fuel", label: "Fuel at KATL", amount: 541.24 },
          { key: "landing_fee", label: "Landing fee KATL", amount: 300 },
        ],
        net: 6282.76,
      },
    };
    const r = parseServerMessage(frame({ company, mission, fleet, loans, ledger }));
    expect(r.ok, r.ok ? "" : r.error).toBe(true);
    const bad = parseServerMessage(
      frame({ fleet: { ...fleet, aircraft: [{ ...fleet.aircraft[0], condition: 140 }] } }),
    );
    expect(bad.ok).toBe(false);
    const badCategory = parseServerMessage(
      frame({ ledger: { ...ledger, recent: [{ ...ledger.recent[0], category: "bribe" }] } }),
    );
    expect(badCategory.ok).toBe(false);
    const patch = parseServerMessage({
      type: "delta",
      v: PROTOCOL_VERSION,
      seq: 2,
      source: "sim",
      patch: { fleet: { selectedId: null }, loans: { creditScore: 380 } },
    });
    expect(patch.ok).toBe(true);
  });

  it("new events and commands", () => {
    for (const name of [
      "loan.payment",
      "loan.missed",
      "aircraft.repossessed",
      "repair.completed",
    ]) {
      expect(EVENT_NAMES).toContain(name);
    }
    for (const name of [
      "fleet.buy",
      "fleet.sell",
      "fleet.lease",
      "fleet.return",
      "fleet.repair",
      "fleet.select",
      "loan.quote",
      "loan.take",
      "loan.payoff",
    ]) {
      expect(KNOWN_COMMANDS).toContain(name);
      expect(
        parseClientMessage({ type: "command", v: PROTOCOL_VERSION, id: "1", name, args: {} }).ok,
      ).toBe(true);
    }
    expect(
      fleetBuyArgsSchema.safeParse({
        typeKey: "kodiak100",
        financing: { lenderId: "jetwash", termMonths: 60, principal: 2_000_000 },
      }).success,
    ).toBe(true);
    expect(fleetBuyArgsSchema.safeParse({ typeKey: "kodiak100", extra: 1 }).success).toBe(false);
    expect(
      loanTakeArgsSchema.safeParse({
        lenderId: "jetwash",
        principal: 1,
        termMonths: 12,
        collateral: { type: "boat", id: "x" },
      }).success,
    ).toBe(false);
  });
});
