import { describe, expect, it } from "vitest";

import { KNOWN_COMMANDS, EVENT_NAMES, parseServerMessage } from "./messages";
import { AIRCRAFT_STATUSES, LEDGER_CATEGORIES } from "./company";
import {
  hiredPilotSchema,
  pilotAssignArgsSchema,
  pilotFireArgsSchema,
  pilotHireArgsSchema,
  pilotUnassignArgsSchema,
  pilotsDomainSchema,
  type PilotsState,
} from "./pilots";

const pilot = {
  id: "HP-1",
  name: "Sawyer Ibarra",
  rating: "turboprop",
  wageMonthly: 7_500,
  hiredGameMs: 0,
  status: "flying",
  assignment: {
    aircraftId: "AC-1",
    registration: "N124JD",
    typeName: "Cessna 208B Grand Caravan",
    origin: "KMEM",
    destination: "KATL",
    distanceNm: 287.7,
    sinceGameMs: 0,
    legs: 0,
    leg: { from: "KMEM", to: "KATL", departGameMs: 21_600_000, arriveGameMs: 29_520_000 },
  },
  legsFlown: 0,
  pnl: [
    {
      month: 0,
      income: 0,
      wages: 7_500,
      fuel: 0,
      fees: 0,
      net: -7_500,
      legs: 0,
      wear: 0,
      wearValue: 0,
    },
  ],
  recent: [],
  simulated: true,
} as const;

const domain: PilotsState = {
  simulated: true,
  pilots: [pilot as never],
  servedAirports: ["KATL", "KMEM"],
  options: [],
  wages: { turboprop: 7_500, jet: 14_000 },
  payoutShare: 0.5,
  maxPilots: 10,
  monthIncome: 0,
  monthCosts: 7_500,
};

describe("hired pilots protocol", () => {
  it("the pilots domain parses and is always marked simulated", () => {
    expect(pilotsDomainSchema.parse(domain)).toEqual(domain);
    expect(pilotsDomainSchema.safeParse({ ...domain, simulated: false }).success).toBe(false);
    expect(hiredPilotSchema.safeParse({ ...pilot, simulated: false }).success).toBe(false);
  });

  it("rides in snapshots as an optional domain; older frames without it still parse", () => {
    const frame = {
      type: "snapshot",
      v: 1,
      seq: 1,
      source: "sim",
      state: { pilots: domain },
    };
    expect(parseServerMessage(frame).ok).toBe(true);
    expect(parseServerMessage({ ...frame, state: {} }).ok).toBe(true);
    const delta = { type: "delta", v: 1, seq: 2, source: "replay", patch: { pilots: null } };
    expect(parseServerMessage(delta).ok).toBe(true);
  });

  it("commands, events, ledger categories and the hired status are known", () => {
    for (const c of ["pilot.hire", "pilot.fire", "pilot.assign", "pilot.unassign"]) {
      expect(KNOWN_COMMANDS).toContain(c);
    }
    expect(EVENT_NAMES).toContain("pilot.route_stopped");
    expect(LEDGER_CATEGORIES).toContain("pilot_wage");
    expect(LEDGER_CATEGORIES).toContain("hired_income");
    expect(AIRCRAFT_STATUSES).toContain("hired");
  });

  it("command arguments are strict", () => {
    expect(pilotHireArgsSchema.safeParse({ rating: "jet" }).success).toBe(true);
    expect(pilotHireArgsSchema.safeParse({ rating: "piston" }).success).toBe(false);
    expect(pilotHireArgsSchema.safeParse({ rating: "jet", wage: 1 }).success).toBe(false);
    expect(pilotFireArgsSchema.safeParse({ pilotId: "HP-1" }).success).toBe(true);
    expect(pilotFireArgsSchema.safeParse({}).success).toBe(false);
    expect(pilotUnassignArgsSchema.safeParse({ pilotId: "" }).success).toBe(false);
    expect(
      pilotAssignArgsSchema.safeParse({ pilotId: "HP-1", aircraftId: "AC-1", destination: "KATL" })
        .success,
    ).toBe(true);
    expect(
      pilotAssignArgsSchema.safeParse({
        pilotId: "HP-1",
        aircraftId: "AC-1",
        origin: "KMEM",
        destination: "KATL",
        income: 1,
      }).success,
    ).toBe(false);
    expect(pilotAssignArgsSchema.safeParse({ pilotId: "HP-1", aircraftId: "AC-1" }).success).toBe(
      false,
    );
  });
});
