import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { airportLookup, repairLoanTerms, type EconomyAirport } from "@cargo-ops/economy";
import type { FleetAircraft, InsuranceState, LoanState, LoansState } from "@cargo-ops/protocol";
import { LoansPanel } from "@/components/company/LoansPanel";
import { demoDomains } from "@/lib/economy/company";
import { formatUsdCents } from "@/lib/format";

import { RepairFinancing } from "./RepairFinancing";

const lookup = airportLookup(
  JSON.parse(
    readFileSync(resolve(__dirname, "../../assets/data/airports-major.json"), "utf8"),
  ) as EconomyAirport[],
);
const demo = demoDomains(lookup);
const starter = demo.fleet.aircraft[0] as FleetAircraft;

const repairLoan: NonNullable<InsuranceState["repairLoan"]> = {
  apr: 4,
  minTermMonths: 6,
  maxTermMonths: 24,
  minAmount: 500,
  overhaulBill: 173_880,
  allDefectsBill: 5_488,
  open: null,
};

function aircraft(
  patch: Partial<FleetAircraft> = {},
  ins: Partial<InsuranceState> = {},
): FleetAircraft {
  return {
    ...starter,
    status: "available",
    ...patch,
    insurance: {
      insured: true,
      premiumMonthly: 8_100,
      riskFactor: 1,
      coverageShare: 0.8,
      deductible: 2_000,
      claims: 0,
      claimsPaid: 0,
      repairLoan,
      ...ins,
    },
  };
}

const button = () => screen.getByTestId("finance-with-insurer") as HTMLButtonElement;

describe("RepairFinancing (Finance with insurer)", () => {
  it("defaults to the overhaul bill and sends insurance.repairLoan with the live quote", () => {
    const run = vi.fn(async () => true);
    render(<RepairFinancing aircraft={aircraft()} enabled demo={false} busy={false} run={run} />);
    const t = repairLoanTerms(173_880, 12);
    expect(screen.getByTestId("repair-loan-quote").textContent).toBe(
      `${formatUsdCents(t.payment)}/mo · ${formatUsdCents(t.totalInterest)} interest`,
    );
    expect(screen.queryByText("DEMO")).toBeNull();
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(run).toHaveBeenCalledWith(
      "insurance.repairLoan",
      { aircraftId: starter.id, repair: "overhaul", principal: 173_880, termMonths: 12 },
      expect.stringContaining("financed by the insurer"),
    );
  });

  it("switching to the defect repairs resets the amount to that bill; bad term or amount disables", () => {
    const run = vi.fn(async () => true);
    render(<RepairFinancing aircraft={aircraft()} enabled demo={false} busy={false} run={run} />);
    fireEvent.change(screen.getByLabelText("Repair to finance"), { target: { value: "all" } });
    expect((screen.getByLabelText("Repair loan amount") as HTMLInputElement).value).toBe("5488");
    fireEvent.change(screen.getByLabelText("Repair loan term"), { target: { value: "30" } });
    expect(screen.getByTestId("repair-loan-quote").textContent).toBe("Term 6–24 months");
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Repair loan term"), { target: { value: "6" } });
    fireEvent.change(screen.getByLabelText("Repair loan amount"), { target: { value: "6000" } });
    expect(button().disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Repair loan amount"), { target: { value: "3000" } });
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    expect(run).toHaveBeenCalledWith(
      "insurance.repairLoan",
      { aircraftId: starter.id, repair: "all", principal: 3_000, termMonths: 6 },
      expect.any(String),
    );
  });

  it("shows the cash needed besides the loan (bill after the claim − amount)", () => {
    render(
      <RepairFinancing aircraft={aircraft()} enabled demo={false} busy={false} run={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("Repair to finance"), { target: { value: "all" } });
    // Financed in full: the incident claim and the loan pay the shop, $0 from cash.
    expect(screen.getByTestId("repair-loan-cash-needed").textContent).toContain("$0.00");
    fireEvent.change(screen.getByLabelText("Repair loan amount"), { target: { value: "3000" } });
    expect(screen.getByTestId("repair-loan-cash-needed").textContent).toContain("$2,488.00");
  });

  it("compares the amount with the bill in cents, as the connector does", () => {
    render(
      <RepairFinancing
        aircraft={aircraft({}, { repairLoan: { ...repairLoan, overhaulBill: 1_900.8 } })}
        enabled
        demo={false}
        busy={false}
        run={vi.fn()}
      />,
    );
    // 1,900.804 rounds to the $1,900.80 bill: accepted. 1,900.806 is $1,900.81: refused.
    fireEvent.change(screen.getByLabelText("Repair loan amount"), {
      target: { value: "1900.804" },
    });
    expect(button().disabled).toBe(false);
    fireEvent.change(screen.getByLabelText("Repair loan amount"), {
      target: { value: "1900.806" },
    });
    expect(button().disabled).toBe(true);
  });

  it("explains why it is blocked: flying", () => {
    render(
      <RepairFinancing
        aircraft={aircraft({ status: "in_flight" })}
        enabled
        demo={false}
        busy={false}
        run={vi.fn()}
      />,
    );
    expect(screen.getByTestId("repair-financing-blocked").textContent).toContain("flying");
    expect(button().disabled).toBe(true);
  });

  it("explains why it is blocked: uninsured, hired, an open loan", () => {
    const { rerender } = render(
      <RepairFinancing
        aircraft={aircraft({}, { insured: false })}
        enabled
        demo={false}
        busy={false}
        run={vi.fn()}
      />,
    );
    expect(screen.getByTestId("repair-financing-blocked").textContent).toContain(
      "active hull policy",
    );
    expect(button().disabled).toBe(true);
    rerender(
      <RepairFinancing
        aircraft={aircraft({ status: "hired" })}
        enabled
        demo={false}
        busy={false}
        run={vi.fn()}
      />,
    );
    expect(screen.getByTestId("repair-financing-blocked").textContent).toContain("hired pilot");
    expect(button().disabled).toBe(true);
    rerender(
      <RepairFinancing
        aircraft={aircraft(
          {},
          {
            repairLoan: {
              ...repairLoan,
              open: {
                loanId: "LN-4",
                balance: 143_986.26,
                payment: 6_513.74,
                missedCount: 2,
                nextDueGameMs: 5_184_000_000,
              },
            },
          },
        )}
        enabled
        demo={false}
        busy={false}
        run={vi.fn()}
      />,
    );
    const open = screen.getByTestId("open-repair-loan");
    expect(open.textContent).toContain("LN-4");
    expect(open.textContent).toContain("2 missed payments");
    expect(screen.queryByTestId("finance-with-insurer")).toBeNull();
  });

  it("demo mode: tagged DEMO, every control disabled", () => {
    const run = vi.fn(async () => true);
    render(
      <RepairFinancing
        aircraft={aircraft()}
        enabled={false}
        demo
        disabledNote="Demo fleet: buying, leasing and repairs need the local connector"
        busy={false}
        run={run}
      />,
    );
    const root = screen.getByTestId("repair-financing");
    expect(within(root).getByText("DEMO")).toBeTruthy();
    expect(button().disabled).toBe(true);
    expect(button().title).toContain("Demo fleet");
    expect((screen.getByLabelText("Repair to finance") as HTMLSelectElement).disabled).toBe(true);
    expect((screen.getByLabelText("Repair loan amount") as HTMLInputElement).disabled).toBe(true);
    fireEvent.click(button());
    expect(run).not.toHaveBeenCalled();
  });

  it("the seeded demo starter (insured) renders from the shared economy code", () => {
    expect(starter.insurance?.insured).toBe(true);
    expect(starter.insurance?.repairLoan?.apr).toBe(4);
    render(<RepairFinancing aircraft={starter} enabled={false} demo busy={false} run={vi.fn()} />);
    expect(screen.getByTestId("repair-financing").textContent).toContain("never repossesses");
  });
});

describe("LoansPanel with insurer repair loans", () => {
  const repairLoanState: LoanState = {
    id: "LN-9",
    lenderId: "insurer",
    lenderName: "Hull insurer",
    principal: 150_000,
    apr: 4,
    termMonths: 24,
    payment: 6_513.74,
    balance: 143_986.26,
    collateral: { type: "aircraft", id: starter.id },
    nextDueGameMs: 5_184_000_000,
    missedCount: 1,
    paymentsMade: 1,
    status: "active",
    takenAt: "2026-10-14T12:00:00.000Z",
    takenGameMs: 0,
    kind: "repair",
    orderId: "MO-7",
  };
  const loans: LoansState = {
    ...demo.loans,
    loans: [
      ...demo.loans.loans,
      repairLoanState,
      { ...repairLoanState, id: "LN-10", status: "called", balance: 0 },
    ],
  };

  it("labels the repair loan (no collateral), its miss rule, and a called loan", () => {
    const run = vi.fn(async () => true);
    render(<LoansPanel loans={loans} fleet={demo.fleet} enabled busy={false} run={run} />);
    const item = screen
      .getAllByTestId("active-loan")
      .find((el) => el.getAttribute("data-kind") === "repair");
    if (!item) throw new Error("repair loan not listed");
    expect(item.textContent).toContain(`repair loan, ${starter.registration} (no collateral)`);
    expect(item.textContent).toContain("cancel the hull policy and move the balance to cash");
    expect(item.textContent).not.toContain("repossess the collateral");
    expect(screen.getByText(/LN-10 called by the insurer/)).toBeTruthy();
    // Early payoff uses loan.payoff like any loan.
    fireEvent.click(within(item).getByRole("button", { name: /Pay off/ }));
    expect(run).toHaveBeenCalledWith("loan.payoff", { loanId: "LN-9" }, expect.any(String));
  });
});
