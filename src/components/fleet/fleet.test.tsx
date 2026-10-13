import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { airportLookup, monthlyPayment, type EconomyAirport } from "@cargo-ops/economy";
import { LoansPanel } from "@/components/company/LoansPanel";
import { LedgerTable } from "@/components/company/LedgerTable";
import { demoDomains } from "@/lib/economy/company";

import { ConditionGauge, FleetCard } from "./FleetCard";

const lookup = airportLookup(
  JSON.parse(
    readFileSync(resolve(__dirname, "../../assets/data/airports-major.json"), "utf8"),
  ) as EconomyAirport[],
);
const demo = demoDomains(lookup);
const noop = async () => true;

describe("demo company (same book as the connector)", () => {
  it("is deterministic: financed starter, a dry lease, a financed used aircraft, a balanced ledger", () => {
    expect(demoDomains(lookup)).toEqual(demo);
    expect(demo.fleet.aircraft.map((a) => [a.ownership, a.financed])).toEqual([
      ["owned", true],
      ["dry_lease", false],
      ["owned", true],
    ]);
    expect(demo.loans.loans).toHaveLength(2);
    const newest = demo.ledger.recent[0];
    expect(newest?.balance).toBe(demo.company.cash);
    expect(demo.company.creditScore).toBeGreaterThan(0);
  });
});

describe("FleetCard", () => {
  it("shows registration, location, condition and the financed / lease badges", () => {
    const [owned, leased] = demo.fleet.aircraft;
    if (!owned || !leased) throw new Error("demo fleet");
    const { rerender } = render(<FleetCard aircraft={owned} source="demo" selected />);
    expect(screen.getByTestId("aircraft-registration").textContent).toBe(owned.registration);
    expect(screen.getByTestId("aircraft-location").textContent).toContain(owned.location);
    expect(screen.getByTestId("financed-badge")).toBeTruthy();
    expect(screen.queryByTestId("lease-badge")).toBeNull();
    expect(screen.getByText("DEMO")).toBeTruthy();
    rerender(<FleetCard aircraft={leased} source="sim" selected={false} />);
    expect(screen.getByTestId("lease-badge").textContent).toBe("Dry lease");
    expect(screen.queryByText("DEMO")).toBeNull();
  });

  it("condition gauge reports the value", () => {
    render(<ConditionGauge value={18.25} />);
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("18");
    expect(screen.getByTestId("aircraft-condition").className).toContain("text-destructive");
  });
});

describe("LoansPanel", () => {
  it("live monthly payment in the calculator; actions disabled without a connector", () => {
    render(
      <LoansPanel loans={demo.loans} fleet={demo.fleet} enabled={false} busy={false} run={noop} />,
    );
    const offer = demo.loans.offers.find((o) => o.eligible) ?? demo.loans.offers[0];
    if (!offer) throw new Error("offers");
    fireEvent.change(screen.getByLabelText("Lender"), { target: { value: offer.lenderId } });
    fireEvent.change(screen.getByLabelText("Principal"), { target: { value: "100000" } });
    fireEvent.change(screen.getByLabelText("Term"), { target: { value: "12" } });
    const expected = monthlyPayment(100_000, offer.apr, 12);
    expect(screen.getByTestId("calc-payment").textContent).toBe(
      `$${expected.toLocaleString("en-US", { minimumFractionDigits: 2 })}`,
    );
    expect((screen.getByTestId("take-loan") as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("LedgerTable", () => {
  it("signed amounts and running balance", () => {
    render(<LedgerTable entries={demo.ledger.recent.slice(0, 3)} />);
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });
});
