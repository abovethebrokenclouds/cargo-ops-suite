import { describe, expect, it } from "vitest";
import {
  EVENT_NAMES,
  KNOWN_COMMANDS,
  PROTOCOL_VERSION,
  fleetAircraftSchema,
  fleetDeferArgsSchema,
  marketBuyArgsSchema,
  marketDomainSchema,
  parseClientMessage,
  parseServerMessage,
} from "./index";

// P5 protocol additions are additive: P4 fleet frames (no systems, no market) still parse;
// the systems/defects/inspection fields, the market domain, the new events, commands and
// the result error's `reasons` validate.

const p4Aircraft = {
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
  financed: false,
  acquiredAt: "2026-10-13T12:00:00.000Z",
};

const defect = {
  id: "AC-2-D1",
  system: "engines",
  severity: "grounding",
  title: "Chip detector warning",
  repairCost: 108_000,
  downtimeHours: 90,
  hidden: false,
  cause: "purchase",
  foundGameMs: 3_600_000,
};

const p5Aircraft = {
  ...p4Aircraft,
  id: "AC-2",
  status: "maintenance",
  airworthy: false,
  ageYears: 4.1,
  systems: [{ key: "engines", label: "Engine(s)", condition: 88.5, defects: [defect] }],
  airworthiness: {
    status: "grounded",
    reasons: [{ code: "grounding_defect", message: "Grounding defect", defectId: "AC-2-D1" }],
    ferryEligible: false,
    payloadPenaltyPct: 0,
    fuelPenaltyPct: 0,
  },
  annual: {
    lastGameMs: 0,
    lastHours: 1_773,
    dueGameMs: 31_104_000_000,
    dueHours: 1_873,
    due: false,
    soon: false,
    cost: 14_580,
    hours: 24,
  },
  maintenance: [
    {
      id: "MO-1",
      aircraftId: "AC-2",
      kind: "defect",
      defectIds: ["AC-2-D1"],
      label: "Chip detector warning",
      airport: "KYNG",
      shop: "field",
      cost: 145_800,
      hours: 135,
      startGameMs: 3_600_000,
      readyAtGameMs: 489_600_000,
    },
  ],
  repairAllCost: 0,
  repairAllHours: 0,
};

const listing = {
  id: "UL-1-7",
  typeKey: "c208b",
  typeName: "Cessna 208B Grand Caravan",
  category: "single-turboprop",
  ageYears: 4,
  hours: 1_773,
  cycles: 1_950,
  location: "KYNG",
  distanceFromBaseNm: 520.1,
  askingPrice: 2_279_000,
  catalogPrice: 2_700_000,
  condition: 92.4,
  systems: [{ key: "engines", condition: 93.1 }],
  knownDefects: [],
  sellerNote: "Lease return; ready to fly away.",
  inspection: { status: "none", fee: 11_395 },
  purchaseMinTier: 0,
  listedGameMs: 0,
};

const frame = (state: unknown) => ({
  type: "snapshot",
  v: PROTOCOL_VERSION,
  seq: 1,
  source: "replay",
  state,
});

describe("P5 protocol", () => {
  it("P4 fleet frames (no P5 fields, no market) still parse", () => {
    const r = parseServerMessage(
      frame({
        fleet: {
          aircraft: [p4Aircraft],
          selectedId: "AC-1",
          selection: "title",
          ambiguous: false,
          value: 1,
        },
      }),
    );
    expect(r.ok).toBe(true);
    expect(fleetAircraftSchema.safeParse(p4Aircraft).success).toBe(true);
  });

  it("systems, defects, airworthiness, annual and maintenance validate on a fleet aircraft", () => {
    expect(fleetAircraftSchema.safeParse(p5Aircraft).success).toBe(true);
    expect(fleetAircraftSchema.safeParse({ ...p5Aircraft, status: "written_off" }).success).toBe(
      true,
    );
    const bad = { ...p5Aircraft, systems: [{ ...p5Aircraft.systems[0], key: "wings" }] };
    expect(fleetAircraftSchema.safeParse(bad).success).toBe(false);
    const r = parseServerMessage(
      frame({
        fleet: {
          aircraft: [p4Aircraft, p5Aircraft],
          selectedId: "AC-1",
          selection: "manual",
          ambiguous: false,
          value: 1,
          maintenance: p5Aircraft.maintenance,
        },
        market: { listings: [listing], generation: 1, refreshedGameMs: 0, nextRefreshGameMs: 1 },
      }),
    );
    expect(r.ok).toBe(true);
  });

  it("market domain and partial market deltas", () => {
    expect(
      marketDomainSchema.safeParse({
        listings: [listing],
        generation: 1,
        refreshedGameMs: 0,
        nextRefreshGameMs: 604_800_000,
      }).success,
    ).toBe(true);
    const delta = parseServerMessage({
      type: "delta",
      v: PROTOCOL_VERSION,
      seq: 2,
      source: "sim",
      patch: { market: { generation: 2 } },
    });
    expect(delta.ok).toBe(true);
  });

  it("events, commands and refusals with reasons", () => {
    for (const name of ["defect.found", "inspection.completed", "aircraft.grounded"]) {
      expect(EVENT_NAMES).toContain(name);
      const r = parseServerMessage({
        type: "event",
        v: PROTOCOL_VERSION,
        seq: 3,
        source: "sim",
        name,
        data: { aircraftId: "AC-2" },
      });
      expect(r.ok).toBe(true);
    }
    for (const name of [
      "market.refresh",
      "market.inspect",
      "market.buy",
      "fleet.repairDefect",
      "fleet.repairAll",
      "fleet.annual",
      "fleet.ferryPermit",
      "fleet.defer",
    ]) {
      expect(KNOWN_COMMANDS).toContain(name);
      const r = parseClientMessage({
        type: "command",
        v: PROTOCOL_VERSION,
        id: "c1",
        name,
        args: {},
      });
      expect(r.ok).toBe(true);
    }
    expect(marketBuyArgsSchema.safeParse({ listingId: "UL-1-7" }).success).toBe(true);
    expect(
      marketBuyArgsSchema.safeParse({
        listingId: "UL-1-7",
        financing: { lenderId: "jetwash", termMonths: 36, principal: 1_000_000 },
      }).success,
    ).toBe(true);
    expect(fleetDeferArgsSchema.safeParse({ aircraftId: "AC-1" }).success).toBe(false);
    const refused = parseServerMessage({
      type: "result",
      v: PROTOCOL_VERSION,
      id: "c2",
      ok: false,
      error: {
        code: "aircraft_unairworthy",
        message: "N1 is not airworthy: Grounding defect (engine(s)): Chip detector warning",
        reasons: [{ code: "grounding_defect", message: "Grounding defect" }],
      },
    });
    expect(refused.ok).toBe(true);
    // P4 refusals without reasons still parse.
    expect(
      parseServerMessage({
        type: "result",
        v: PROTOCOL_VERSION,
        id: "c3",
        ok: false,
        error: { code: "no_wear", message: "x" },
      }).ok,
    ).toBe(true);
  });
});
