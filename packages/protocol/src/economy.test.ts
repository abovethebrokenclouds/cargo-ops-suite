import { describe, expect, it } from "vitest";
import {
  AIRCRAFT_TYPES,
  aircraftTypeSchema,
  EVENT_NAMES,
  jobSchema,
  jobsDomainSchema,
  matchAircraftType,
  missionLoadArgsSchema,
  parseServerMessage,
  resolveAircraftType,
  simStatePatchSchema,
  simStateSchema,
  surfaceClass,
} from "./index";

describe("aircraft type catalogue", () => {
  it("every entry is valid and keys are unique", () => {
    for (const t of AIRCRAFT_TYPES) expect(aircraftTypeSchema.safeParse(t).success).toBe(true);
    expect(new Set(AIRCRAFT_TYPES.map((t) => t.key)).size).toBe(AIRCRAFT_TYPES.length);
    expect(AIRCRAFT_TYPES.length).toBeGreaterThanOrEqual(8);
  });

  it("matches sim TITLEs case-insensitively", () => {
    expect(matchAircraftType("Cessna 208B Grand Caravan EX")?.key).toBe("c208b");
    expect(matchAircraftType("Daher Kodiak 100 Series II")?.key).toBe("kodiak100");
    expect(matchAircraftType("PMDG 737-800BCF")?.key).toBe("b738bcf");
    expect(matchAircraftType("Asobo ATR 72-600")?.key).toBe("atr72f");
    expect(matchAircraftType("Boeing 747-8 Intercontinental")?.key).toBe("b748f");
    expect(matchAircraftType("Beechcraft King Air 350i")?.key).toBe("kingair350");
    expect(matchAircraftType("Cessna Skyhawk")).toBeNull();
    expect(matchAircraftType("Coast Patrol Special")).toBeNull();
  });

  it("override beats the TITLE, which beats the default", () => {
    expect(resolveAircraftType("Kodiak 100", "pc12")).toMatchObject({ source: "override" });
    expect(resolveAircraftType("Kodiak 100", null).type.key).toBe("kodiak100");
    expect(resolveAircraftType("Unknown Jet", "nope")).toMatchObject({ source: "default" });
  });

  it("maps OurAirports surface codes", () => {
    expect(
      ["ASP", "CON", "ASP-G", "GRVL-DIRT-F", "TURF", "DIRT", "WATER", "", "XYZ"].map(surfaceClass),
    ).toEqual(["paved", "paved", "paved", "gravel", "turf", "dirt", "water", "unknown", "unknown"]);
  });
});

describe("P3 protocol additions are backward compatible", () => {
  it("a P2 snapshot without jobs/company/mission still parses", () => {
    const msg = {
      type: "snapshot",
      v: 1,
      seq: 3,
      source: "sim",
      state: { sim: { connected: true, paused: false, simRate: 1 }, phase: { current: "Cruise" } },
    };
    expect(parseServerMessage(msg).ok).toBe(true);
    expect(simStateSchema.safeParse({}).success).toBe(true);
  });

  it("new event names are accepted; existing ones still are", () => {
    for (const name of ["touchdown", "job.completed", "mission.delivered", "mission.failed"]) {
      expect(EVENT_NAMES).toContain(name);
      const ok = parseServerMessage({
        type: "event",
        v: 1,
        seq: 1,
        source: "replay",
        name,
        data: {},
      });
      expect(ok.ok).toBe(true);
    }
  });

  it("validates the company and mission domains", () => {
    const company = {
      name: "Cargo Ops",
      base: "KMEM",
      cash: 250000,
      reputation: 50,
      reputationTier: 2,
    };
    expect(simStateSchema.safeParse({ company }).success).toBe(true);
    expect(simStateSchema.safeParse({ company: { ...company, reputation: 101 } }).success).toBe(
      false,
    );
    expect(simStatePatchSchema.safeParse({ company: { cash: 1 }, mission: null }).success).toBe(
      true,
    );
  });
});

describe("transit cargo protocol additions", () => {
  const job = {
    id: "J-1",
    status: "in_transit",
    origin: "KMEM",
    destination: "KRDU",
    kind: "cargo",
    weightKg: 500,
    units: 1,
    distanceNm: 549.2,
    timeLimitMin: 630,
    aircraftKey: "c208b",
    createdAt: "2026-10-13T12:00:00.000Z",
    expiresAt: "2026-10-14T12:00:00.000Z",
    payoutEstimate: 8319,
    breakdown: {
      base: 7999.43,
      factors: [],
      gross: 8319.41,
      deductions: 0,
      total: 8319,
      estimate: true,
      noBonus: false,
    },
    transit: {
      location: "KATL",
      arrivedAt: "2026-10-13T14:00:00.000Z",
      arrivedGameMs: 0,
      elapsedMin: 119,
      storage: "airport",
      freeStorageMin: 0,
      deadlineGameMs: 30_660_000,
      legs: [
        {
          missionId: "M-1",
          origin: "KMEM",
          destination: "KATL",
          blockMin: 119,
          groundMin: 0,
          landingGrade: "B",
          arrivedAt: "2026-10-13T14:00:00.000Z",
        },
      ],
    },
  };

  it("an in-transit job and the inTransit list parse; frames without them still do", () => {
    expect(jobSchema.safeParse(job).success).toBe(true);
    const noLegs = { ...job, transit: { ...job.transit, legs: [] } };
    expect(jobSchema.safeParse(noLegs).success).toBe(false);
    const domain = {
      boards: [],
      available: [],
      accepted: [],
      inTransit: [job],
      aircraft: { typeKey: "c208b", name: "C208B", source: "default" },
    };
    expect(jobsDomainSchema.safeParse(domain).success).toBe(true);
    const { inTransit: _t, ...older } = domain;
    expect(jobsDomainSchema.safeParse(older).success).toBe(true);
  });

  it("mission.load takes an optional leg destination; transit events are known", () => {
    const load = (args: unknown) => missionLoadArgsSchema.safeParse(args).success;
    expect(load({ jobIds: ["J-1"], destination: "KATL" })).toBe(true);
    expect(load({ jobIds: ["J-1"] })).toBe(true);
    expect(load({ jobIds: ["J-1"], destination: "" })).toBe(false);
    expect(EVENT_NAMES).toContain("job.in_transit");
    expect(EVENT_NAMES).toContain("job.abandoned");
  });
});
