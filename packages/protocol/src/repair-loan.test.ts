import { describe, expect, it } from "vitest";
import {
  EVENT_NAMES,
  KNOWN_COMMANDS,
  LEDGER_CATEGORIES,
  LOAN_STATUSES,
  PROTOCOL_VERSION,
  insuranceRepairLoanArgsSchema,
  insuranceStateSchema,
  loanSchema,
  parseServerMessage,
} from "./index";

// Insurer repair loans (docs/ECONOMY.md "Insurer repair loans"): additive protocol. Loans
// without `kind` (every bank loan, older connectors) and insurance states without
// `repairLoan` still parse.

const bankLoan = {
  id: "LN-1",
  lenderId: "jetwash",
  lenderName: "Jetwash Credit",
  principal: 400_000,
  apr: 16.91,
  termMonths: 36,
  payment: 14_281.98,
  balance: 400_000,
  collateral: { type: "aircraft", id: "AC-1" },
  nextDueGameMs: 2_592_000_000,
  missedCount: 0,
  paymentsMade: 0,
  status: "active",
  takenAt: "2026-10-14T12:00:00.000Z",
  takenGameMs: 0,
};

describe("insurer repair loans: protocol", () => {
  it("command, event, ledger categories and the called status are known", () => {
    expect(KNOWN_COMMANDS).toContain("insurance.repairLoan");
    expect(EVENT_NAMES).toContain("insurance.cancelled");
    expect(LEDGER_CATEGORIES).toEqual(
      expect.arrayContaining(["repair_loan_disbursement", "repair_loan_payment"]),
    );
    expect(LOAN_STATUSES).toContain("called");
    expect(
      parseServerMessage({
        type: "event",
        v: PROTOCOL_VERSION,
        seq: 1,
        source: "replay",
        name: "insurance.cancelled",
        data: { aircraftId: "AC-1", reason: "missed_payments" },
      }).ok,
    ).toBe(true);
  });

  it("insurance.repairLoan arguments are strict; defectId exactly for a defect repair", () => {
    const ok = (args: unknown) => insuranceRepairLoanArgsSchema.safeParse(args).success;
    expect(ok({ aircraftId: "AC-1", repair: "overhaul", principal: 5_000, termMonths: 12 })).toBe(
      true,
    );
    expect(ok({ aircraftId: "AC-1", repair: "all", principal: 5_000, termMonths: 6 })).toBe(true);
    expect(
      ok({
        aircraftId: "AC-1",
        repair: "defect",
        defectId: "AC-1-D3",
        principal: 5_000,
        termMonths: 24,
      }),
    ).toBe(true);
    // Missing or misplaced defectId.
    expect(ok({ aircraftId: "AC-1", repair: "defect", principal: 5_000, termMonths: 12 })).toBe(
      false,
    );
    expect(
      ok({ aircraftId: "AC-1", repair: "all", defectId: "X", principal: 5_000, termMonths: 12 }),
    ).toBe(false);
    // Unknown repair kind, extra keys, non-positive or fractional numbers.
    expect(ok({ aircraftId: "AC-1", repair: "paint", principal: 5_000, termMonths: 12 })).toBe(
      false,
    );
    expect(
      ok({ aircraftId: "AC-1", repair: "all", principal: 5_000, termMonths: 12, apr: 1 }),
    ).toBe(false);
    expect(ok({ aircraftId: "AC-1", repair: "all", principal: 0, termMonths: 12 })).toBe(false);
    expect(ok({ aircraftId: "AC-1", repair: "all", principal: 5_000, termMonths: 6.5 })).toBe(
      false,
    );
    expect(ok({ aircraftId: "", repair: "all", principal: 5_000, termMonths: 12 })).toBe(false);
  });

  it("loans: bank loans without kind still parse; repair loans carry kind and orderId", () => {
    expect(loanSchema.safeParse(bankLoan).success).toBe(true);
    const repair = {
      ...bankLoan,
      id: "LN-2",
      lenderId: "insurer",
      lenderName: "Hull insurer",
      apr: 4,
      kind: "repair",
      orderId: "MO-3",
    };
    expect(loanSchema.safeParse(repair).success).toBe(true);
    expect(loanSchema.safeParse({ ...repair, status: "called", balance: 0 }).success).toBe(true);
    expect(loanSchema.safeParse({ ...repair, kind: "payday" }).success).toBe(false);
  });

  it("insurance state: repairLoan is optional", () => {
    const base = {
      insured: true,
      premiumMonthly: 8_100,
      riskFactor: 1,
      coverageShare: 0.8,
      deductible: 2_000,
      claims: 0,
      claimsPaid: 0,
    };
    expect(insuranceStateSchema.safeParse(base).success).toBe(true);
    expect(
      insuranceStateSchema.safeParse({
        ...base,
        repairLoan: {
          apr: 4,
          minTermMonths: 6,
          maxTermMonths: 24,
          minAmount: 500,
          overhaulBill: 173_880,
          allDefectsBill: null,
          open: {
            loanId: "LN-2",
            balance: 150_000,
            payment: 6_513.74,
            missedCount: 0,
            nextDueGameMs: 2_592_000_000,
          },
        },
      }).success,
    ).toBe(true);
  });
});
