import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { airportLookup, type EconomyAirport } from "@cargo-ops/economy";
import type { FleetAircraft } from "@cargo-ops/protocol";
import { demoDomains } from "@/lib/economy/company";

import { AirworthinessBadge, SystemsPanel } from "./Airworthiness";
import { MaintenanceBoard } from "./MaintenanceBoard";
import { UsedMarket } from "./UsedMarket";

const lookup = airportLookup(
  JSON.parse(
    readFileSync(resolve(__dirname, "../../assets/data/airports-major.json"), "utf8"),
  ) as EconomyAirport[],
);
const demo = demoDomains(lookup);
const used = demo.fleet.aircraft.find((a) => (a.ageYears ?? 0) > 1) as FleetAircraft;

describe("AirworthinessBadge", () => {
  it("labels every status", () => {
    const { rerender } = render(<AirworthinessBadge status="airworthy" />);
    expect(screen.getByTestId("airworthiness-badge").textContent).toBe("Airworthy");
    rerender(<AirworthinessBadge status="grounded" />);
    expect(screen.getByTestId("airworthiness-badge").textContent).toBe("Grounded");
    rerender(<AirworthinessBadge status="ferry_only" />);
    expect(screen.getByTestId("airworthiness-badge").textContent).toBe("Ferry only");
    rerender(<AirworthinessBadge status="annual_due" />);
    expect(screen.getByTestId("airworthiness-badge").textContent).toBe("Annual due");
  });
});

describe("SystemsPanel", () => {
  it("shows ten system bars, the known defects with severity, and disabled actions without a connector", () => {
    expect(used).toBeDefined();
    render(<SystemsPanel aircraft={used} enabled={false} busy={false} run={async () => true} />);
    const panel = screen.getByTestId("systems-panel");
    expect(within(panel).getAllByRole("meter")).toHaveLength(10);
    const defects = (used.systems ?? []).flatMap((s) => s.defects);
    expect(screen.queryAllByTestId("defect-row")).toHaveLength(defects.length);
    for (const b of screen.queryAllByTestId("severity-badge")) {
      expect(["cosmetic", "minor", "major", "grounding"]).toContain(
        b.getAttribute("data-severity"),
      );
    }
    expect((screen.getByTestId("repair-all") as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByTestId("book-annual") as HTMLButtonElement).disabled).toBe(true);
  });

  it("lists the gate reasons and sends repair/defer commands when enabled", () => {
    const run = vi.fn(async () => true);
    const aircraft: FleetAircraft = {
      ...used,
      status: "available",
      airworthy: false,
      maintenance: [],
      repairAllCost: 5_400,
      repairAllHours: 8,
      systems: (used.systems ?? []).map((s, i) =>
        i === 0
          ? {
              ...s,
              defects: [
                {
                  id: "X-D1",
                  system: s.key,
                  severity: "minor",
                  title: "Intermittent igniter",
                  repairCost: 5_400,
                  downtimeHours: 8,
                  hidden: false,
                  cause: "wear",
                },
              ],
            }
          : { ...s, defects: [] },
      ),
      airworthiness: {
        status: "grounded",
        reasons: [{ code: "minor_not_deferred", message: "Minor defect not deferred" }],
        ferryEligible: false,
        payloadPenaltyPct: 0,
        fuelPenaltyPct: 1,
      },
    };
    render(<SystemsPanel aircraft={aircraft} enabled busy={false} run={run} />);
    expect(screen.getByTestId("gate-reasons").textContent).toContain("Minor defect not deferred");
    fireEvent.click(screen.getByTestId("defer-defect"));
    expect(run).toHaveBeenCalledWith(
      "fleet.defer",
      { aircraftId: aircraft.id, defectId: "X-D1" },
      expect.any(String),
    );
    fireEvent.click(screen.getByTestId("repair-defect"));
    expect(run).toHaveBeenCalledWith(
      "fleet.repairDefect",
      { aircraftId: aircraft.id, defectId: "X-D1" },
      expect.any(String),
    );
  });
});

describe("MaintenanceBoard", () => {
  it("shows each order with an ETA and progress", () => {
    const orders = demo.fleet.maintenance ?? [];
    expect(orders.length).toBeGreaterThan(0);
    render(<MaintenanceBoard orders={orders} gameMs={demo.company.clock?.gameMs ?? null} />);
    expect(screen.getAllByTestId("maintenance-order")).toHaveLength(orders.length);
    expect(screen.getAllByTestId("maintenance-eta")[0]?.textContent).toMatch(/^ETA Month/);
  });

  it("empty state", () => {
    render(<MaintenanceBoard orders={[]} gameMs={0} />);
    expect(screen.getByTestId("maintenance-empty")).toBeTruthy();
  });
});

describe("UsedMarket", () => {
  it("DEMO listings with price, location and disabled inspect/buy", () => {
    render(
      <UsedMarket
        market={demo.market}
        company={demo.company}
        loans={demo.loans}
        source="demo"
        enabled={false}
        busy={false}
        run={async () => true}
      />,
    );
    const cards = screen.getAllByTestId("listing-card");
    expect(cards).toHaveLength(demo.market.listings.length);
    const first = cards[0];
    if (!first) throw new Error("no listing");
    expect(within(first).getByText("DEMO")).toBeTruthy();
    expect(within(first).getByTestId("asking-price").textContent).toMatch(/^\$/);
    expect((within(first).getByTestId("buy-listing") as HTMLButtonElement).disabled).toBe(true);
    for (const b of screen.queryAllByTestId("inspect-listing")) {
      expect((b as HTMLButtonElement).disabled).toBe(true);
    }
    expect((screen.getByTestId("market-refresh") as HTMLButtonElement).disabled).toBe(true);
    // Hidden defects never reach the browser view.
    expect(JSON.stringify(demo.market)).not.toContain('"hidden":true');
  });
});
