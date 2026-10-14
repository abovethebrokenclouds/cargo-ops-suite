import { describe, expect, it } from "vitest";
import {
  KNOWN_COMMANDS,
  parseServerMessage,
  planDestinationArgsSchema,
  planDomainSchema,
} from "./index";

describe("plan domain", () => {
  it("older GPS plan frames without a basis still parse", () => {
    const old = {
      active: true,
      origin: "KMEM",
      destination: "KATL",
      wpIndex: 1,
      wpCount: 2,
      nextWpId: "KATL",
      nextWpDistanceNm: 287.7,
      destDistanceNm: 287.7,
    };
    expect(planDomainSchema.safeParse(old).success).toBe(true);
  });

  it("accepts the three bases and rejects anything else", () => {
    for (const basis of ["gps", "manual", "mission"]) {
      expect(planDomainSchema.safeParse({ active: true, basis }).success).toBe(true);
    }
    expect(planDomainSchema.safeParse({ active: true, basis: "simbrief" }).success).toBe(false);
  });

  it("never accepts negative distances or ETEs", () => {
    expect(planDomainSchema.safeParse({ active: true, destDistanceNm: -1 }).success).toBe(false);
    expect(planDomainSchema.safeParse({ active: true, eteSec: -5 }).success).toBe(false);
    expect(planDomainSchema.safeParse({ active: true, nextWpEteSec: -5 }).success).toBe(false);
  });

  it("a delta can carry a partial plan with the basis", () => {
    const r = parseServerMessage({
      type: "delta",
      v: 1,
      seq: 3,
      source: "sim",
      patch: { plan: { basis: "manual", destDistanceNm: 120.4, eteSec: 3060 } },
    });
    expect(r.ok).toBe(true);
  });
});

describe("plan.destination command", () => {
  it("is a known command", () => {
    expect(KNOWN_COMMANDS).toContain("plan.destination");
  });

  it("normalises an ident to upper case and accepts null to clear", () => {
    expect(planDestinationArgsSchema.parse({ icao: " katl " })).toEqual({ icao: "KATL" });
    expect(planDestinationArgsSchema.parse({ icao: null })).toEqual({ icao: null });
  });

  it("refuses missing, malformed and extra arguments", () => {
    expect(planDestinationArgsSchema.safeParse({}).success).toBe(false);
    expect(planDestinationArgsSchema.safeParse({ icao: "" }).success).toBe(false);
    expect(planDestinationArgsSchema.safeParse({ icao: "K ATL" }).success).toBe(false);
    expect(planDestinationArgsSchema.safeParse({ icao: "<script>" }).success).toBe(false);
    expect(planDestinationArgsSchema.safeParse({ icao: "KATL", eteSec: 5 }).success).toBe(false);
  });
});
