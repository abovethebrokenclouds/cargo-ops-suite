import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { PilotsState } from "@cargo-ops/protocol";
import { airportLookup, type EconomyAirport } from "@cargo-ops/economy";
import { demoDomains, LEDGER_LABELS } from "@/lib/economy/company";
import { describeEvent } from "@/lib/ops/mission-control";

import { HiredPilots } from "./HiredPilots";

const lookup = airportLookup(
  JSON.parse(
    readFileSync(resolve(__dirname, "../../assets/data/airports-major.json"), "utf8"),
  ) as EconomyAirport[],
);
const demo = demoDomains(lookup);

const unassigned: PilotsState = {
  simulated: true,
  pilots: [
    {
      id: "HP-1",
      name: "Sawyer Ibarra",
      rating: "turboprop",
      wageMonthly: 7_500,
      hiredGameMs: 0,
      status: "unassigned",
      assignment: null,
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
    },
  ],
  servedAirports: ["KATL", "KBNA", "KMEM"],
  options: [
    {
      aircraftId: "AC-1",
      registration: "N124JD",
      typeName: "Cessna 208B Grand Caravan",
      rating: "turboprop",
      origin: "KMEM",
      destinations: [
        {
          icao: "KATL",
          distanceNm: 287.7,
          blockMin: 132,
          boardPayout: 5_606,
          income: 2_803,
          costs: 1_016,
        },
        {
          icao: "KBNA",
          distanceNm: 173.6,
          blockMin: 91,
          boardPayout: 3_500,
          income: 1_750,
          costs: 790,
        },
      ],
    },
  ],
  wages: { turboprop: 7_500, jet: 14_000 },
  payoutShare: 0.5,
  maxPilots: 10,
  monthIncome: 0,
  monthCosts: 7_500,
};

describe("HiredPilots", () => {
  it("demo: a seeded pilot flies the starter, labelled simulated and DEMO; every action disabled", () => {
    expect(demo.pilots.simulated).toBe(true);
    const p = demo.pilots.pilots[0];
    expect(p?.assignment?.origin).toBe("KMEM");
    expect(p?.assignment?.destination).toBe("KBNA");
    expect(p?.legsFlown).toBeGreaterThan(0);
    // The starter is the pilot's aircraft: unavailable to the player.
    expect(demo.fleet.aircraft.find((a) => a.id === p?.assignment?.aircraftId)?.status).toBe(
      "hired",
    );
    render(
      <HiredPilots
        pilots={demo.pilots}
        source="demo"
        enabled={false}
        disabledNote="Demo"
        busy={false}
        run={async () => true}
      />,
    );
    const card = screen.getByTestId("pilot-card");
    expect(within(card).getByText("DEMO")).toBeTruthy();
    expect(within(card).getByTestId("simulated-tag").textContent).toBe("Hired pilot (simulated)");
    expect(within(card).getByTestId("pilot-route").textContent).toContain("KMEM ⇄ KBNA");
    expect(screen.getByTestId("hire-pilot")).toHaveProperty("disabled", true);
    expect(within(card).getByTestId("unassign-pilot")).toHaveProperty("disabled", true);
    expect(within(card).getByTestId("fire-pilot")).toHaveProperty("disabled", true);
    expect(within(card).getAllByTestId("pilot-pnl-net").length).toBeGreaterThan(0);
  });

  it("with a connector: hire by rating and assign a served destination", async () => {
    const run = vi.fn(async () => true);
    render(
      <HiredPilots
        pilots={unassigned}
        source="sim"
        enabled
        disabledNote={undefined}
        busy={false}
        run={run}
      />,
    );
    fireEvent.change(screen.getByTestId("pilot-rating"), { target: { value: "jet" } });
    fireEvent.click(screen.getByTestId("hire-pilot"));
    expect(run).toHaveBeenCalledWith("pilot.hire", { rating: "jet" }, "Hired a Jet pilot");
    expect(screen.getByTestId("pilot-status").textContent).toBe("Unassigned");
    fireEvent.change(screen.getByTestId("pilot-destination"), { target: { value: "KBNA" } });
    fireEvent.click(screen.getByTestId("assign-pilot"));
    expect(run).toHaveBeenLastCalledWith(
      "pilot.assign",
      { pilotId: "HP-1", aircraftId: "AC-1", destination: "KBNA" },
      "Sawyer Ibarra flies KMEM ⇄ KBNA (simulated)",
    );
    fireEvent.click(screen.getByTestId("fire-pilot"));
    expect(run).toHaveBeenLastCalledWith("pilot.fire", { pilotId: "HP-1" }, "Sawyer Ibarra let go");
    expect(screen.getByTestId("pilot-pnl-net").textContent).toBe("-$7,500");
  });

  it("no aircraft for the rating: assigning is disabled", () => {
    render(
      <HiredPilots
        pilots={{ ...unassigned, options: [] }}
        source="sim"
        enabled
        disabledNote={undefined}
        busy={false}
        run={async () => true}
      />,
    );
    expect(screen.getByTestId("assign-pilot")).toHaveProperty("disabled", true);
  });

  it("ledger labels and the ops loop line say simulated", () => {
    expect(LEDGER_LABELS["hired_income"]).toBe("Hired pilot income (simulated)");
    expect(LEDGER_LABELS["pilot_wage"]).toBe("Hired pilot wage");
    const line = describeEvent({
      at: 0,
      msg: {
        type: "event",
        v: 1,
        seq: 3,
        source: "sim",
        name: "pilot.route_stopped",
        data: { registration: "N124JD", code: "aircraft_grounded", simulated: true },
      },
    });
    expect(line.text).toBe("HIRED PILOT (SIMULATED) ROUTE STOPPED · N124JD");
    expect(line.tone).toBe("hold");
  });
});
