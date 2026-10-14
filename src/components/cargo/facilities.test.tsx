import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  aircraftTypeByKey,
  type AircraftType,
  type FacilitiesState,
  type Job,
  type MsfsAirport,
} from "@cargo-ops/protocol";
import { airportLookup, type EconomyAirport } from "@cargo-ops/economy";
import { jobSuitability } from "@/lib/economy/board";
import { facilityRecords, withFacilities } from "@/lib/economy/facilities";
import { initialSimState, type ClientSimState } from "@/lib/sim-state/reducer";

import { AirportFacts } from "./AirportFacts";

const bundled = airportLookup(
  JSON.parse(
    readFileSync(resolve(__dirname, "../../assets/data/airports-major.json"), "utf8"),
  ) as EconomyAirport[],
);
const c208 = aircraftTypeByKey("c208b") as AircraftType;

/** KJBR as a sim with add-on scenery returns it (feet, after the connector's conversion). */
const KJBR_MSFS: MsfsAirport = {
  icao: "KJBR",
  name: "Jonesboro Muni (addon)",
  lat: 35.8317,
  lon: -90.6464,
  elevFt: 262,
  runways: [
    {
      ident: "05/23",
      headingTrueDeg: 47.3,
      lengthFt: 6200,
      widthFt: 150,
      surfaceCode: 4,
      surface: "asphalt",
    },
    {
      ident: "13/31",
      headingTrueDeg: 127.9,
      lengthFt: 6800,
      widthFt: 100,
      surfaceCode: 254,
      surface: null,
    },
  ],
  fetchedAt: "2026-10-14T12:00:00.000Z",
  sim: "MSFS 2024",
};

const job = (destination: string): Job => ({
  id: "J-TEST001",
  status: "available",
  origin: "KMEM",
  destination,
  originName: "Memphis",
  destinationName: destination,
  kind: "cargo",
  weightKg: 400,
  units: 2,
  distanceNm: 58,
  timeLimitMin: 120,
  aircraftKey: "c208b",
  createdAt: "2026-10-14T12:00:00.000Z",
  expiresAt: "2026-10-14T18:00:00.000Z",
  payoutEstimate: 1000,
  breakdown: { lines: [], total: 1000 } as unknown as Job["breakdown"],
});

const state = (connection: ClientSimState["connection"], facilities?: FacilitiesState) =>
  ({
    ...initialSimState,
    connection,
    sim: facilities ? { facilities } : {},
  }) as ClientSimState;

describe("MSFS facilities override: per-field source labels", () => {
  it("labels the runway badge OurAirports without sim data and MSFS with it", () => {
    const plain = withFacilities(bundled, []);
    const before = jobSuitability(job("KJBR"), c208, plain).find((b) => b.key === "runway");
    expect(before?.detail).toBe("6,200 ft paved (OurAirports) · needs 2,500 ft");

    const merged = withFacilities(bundled, [KJBR_MSFS]);
    const after = jobSuitability(job("KJBR"), c208, merged).find((b) => b.key === "runway");
    // The longest MSFS runway (13/31, 6,800 ft) has a surface code the table does not know:
    // length from MSFS, surface kept from OurAirports, each labelled.
    expect(after?.detail).toBe("6,800 ft (MSFS) paved (OurAirports) · needs 2,500 ft");
    expect(after?.ok).toBe(true);
  });

  it("uses only a live connector's facilities domain (never replay or demo)", () => {
    const domain: FacilitiesState = { source: "sim", airports: { KJBR: KJBR_MSFS } };
    expect(facilityRecords(state("live", domain))).toEqual([KJBR_MSFS]);
    expect(facilityRecords(state("replay", domain))).toEqual([]);
    expect(facilityRecords(state("demo", domain))).toEqual([]);
  });

  it("AirportFacts shows each field's source and the sim's runways", () => {
    const merged = withFacilities(bundled, [KJBR_MSFS]);
    render(<AirportFacts ident="KJBR" lookup={merged} />);
    const facts = screen.getByTestId("airport-facts");
    const tag = (id: string) =>
      within(within(facts).getByTestId(id)).getByText(/MSFS|OurAirports/).textContent;
    expect(tag("fact-position")).toBe("MSFS");
    expect(tag("fact-elevation")).toBe("MSFS");
    expect(tag("fact-runway")).toBe("MSFS");
    expect(tag("fact-surface")).toBe("OurAirports");
    expect(within(facts).getByTestId("fact-elevation").textContent).toContain("262 ft");
    const rows = within(screen.getByTestId("msfs-runways")).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain("05/23");
    expect(rows[2]?.textContent).toContain("code 254");
    expect(screen.getByText(/MSFS data can change which jobs/)).toBeTruthy();
  });

  it("AirportFacts without sim data labels everything OurAirports", () => {
    render(<AirportFacts ident="KMEM" lookup={withFacilities(bundled, [])} />);
    const facts = screen.getByTestId("airport-facts");
    const tags = facts.querySelectorAll("[data-field-source]");
    expect(tags.length).toBeGreaterThan(0);
    for (const t of tags) expect(t.getAttribute("data-field-source")).toBe("ourairports");
    expect(screen.queryByTestId("msfs-runways")).toBeNull();
  });
});
