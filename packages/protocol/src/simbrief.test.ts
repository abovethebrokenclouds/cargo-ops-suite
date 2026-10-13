import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import {
  mapSimbriefOfp,
  plannedFlightSchema,
  simbriefFetchUrl,
  simbriefSettingsUpdateSchema,
} from "./simbrief";

// HAND-MADE sample (connector/fixtures/simbrief-ofp.handmade.json, see its _comment): field
// names follow SimBrief's documented JSON OFP; it is not a recorded response.
const sample = JSON.parse(
  readFileSync(
    resolve(__dirname, "../../../connector/fixtures/simbrief-ofp.handmade.json"),
    "utf8",
  ),
) as Record<string, Record<string, string>>;
const AT = "2026-10-13T12:00:00.000Z";

describe("mapSimbriefOfp", () => {
  it("maps the hand-made sample into a valid planned flight (lbs → kg)", () => {
    const r = mapSimbriefOfp(sample, AT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(plannedFlightSchema.parse(r.plan)).toEqual(r.plan);
    expect(r.plan).toMatchObject({
      source: "simbrief",
      origin: "KMEM",
      destination: "KATL",
      alternate: "KPDK",
      route: "MEM J42 RQZ HONIE2",
      aircraftIcao: "C208",
      registration: "N208CG",
      flightNumber: "CGO208",
      plannedFuelKg: 657.7,
      payloadKg: 840.1,
      distanceNm: 297,
      eteMin: 111,
      units: "lb",
      requestId: "HANDMADE-0001",
      fetchedAt: AT,
    });
    expect(r.plan.generatedAt).toBe(new Date(1792252800 * 1000).toISOString());
  });

  it("keeps kilograms as they are", () => {
    const kg = {
      ...sample,
      params: { ...sample["params"], units: "kgs" },
      fuel: { plan_ramp: "650" },
      weights: { payload: "840" },
    };
    const r = mapSimbriefOfp(kg, AT);
    expect(r.ok && r.plan.plannedFuelKg).toBe(650);
    expect(r.ok && r.plan.payloadKg).toBe(840);
  });

  it("reports SimBrief's own error status", () => {
    const r = mapSimbriefOfp({ fetch: { status: "Error: Unknown UserID" } }, AT);
    expect(r).toEqual({ ok: false, code: "simbrief_error", message: "Error: Unknown UserID" });
  });

  it("refuses documents without usable ICAO codes and non-objects", () => {
    expect(mapSimbriefOfp({ fetch: { status: "Success" } }, AT).ok).toBe(false);
    expect(
      mapSimbriefOfp({ origin: { icao_code: "K M" }, destination: { icao_code: "KATL" } }, AT).ok,
    ).toBe(false);
    expect(mapSimbriefOfp("<OFP/>", AT)).toMatchObject({ ok: false, code: "simbrief_invalid" });
    expect(mapSimbriefOfp(null, AT).ok).toBe(false);
  });

  it("tolerates missing optional parts (nulls, never invented numbers)", () => {
    const r = mapSimbriefOfp(
      { origin: { icao_code: "kmem" }, destination: { icao_code: "katl" } },
      AT,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan).toMatchObject({
      origin: "KMEM",
      destination: "KATL",
      route: "",
      plannedFuelKg: null,
      payloadKg: null,
      eteMin: null,
      units: null,
      alternate: null,
    });
  });
});

describe("SimBrief settings", () => {
  it("builds the documented fetch URL (pilot ID preferred)", () => {
    expect(simbriefFetchUrl({ enabled: true, username: "pilot", userId: null })).toBe(
      "https://www.simbrief.com/api/xml.fetcher.php?username=pilot&json=1",
    );
    expect(simbriefFetchUrl({ enabled: true, username: "pilot", userId: "99" })).toBe(
      "https://www.simbrief.com/api/xml.fetcher.php?userid=99&json=1",
    );
  });

  it("validates updates strictly", () => {
    expect(simbriefSettingsUpdateSchema.safeParse({ username: "a.b-c_1" }).success).toBe(true);
    expect(simbriefSettingsUpdateSchema.safeParse({ username: "a b" }).success).toBe(false);
    expect(simbriefSettingsUpdateSchema.safeParse({ userId: "12a" }).success).toBe(false);
    expect(simbriefSettingsUpdateSchema.safeParse({ extra: 1 }).success).toBe(false);
  });
});
