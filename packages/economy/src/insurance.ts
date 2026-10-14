// Hull insurance (plan §7.4): an optional policy per owned aircraft. The monthly premium
// is proportional to the hull value and to the risk (recent hard landings and crashes);
// the policy pays a share of a crash write-off and of repairs after incidents.

import type { AircraftStatus, Ownership } from "../../protocol/src/company";
import type { DefectCause } from "../../protocol/src/maintenance";
import { GAME_DAY_MS } from "./company-constants";
import { INSURANCE, REPAIR_LOAN } from "./fbo-constants";
import { amortisationSchedule, monthlyPayment } from "./finance";
import { round2 } from "./geo";

export interface Incident {
  gameMs: number;
  kind: "hard_landing" | "crash";
}

/** risk = min(3, 1 + 0.25 × hard landings in 180 days + 1 × crashes in 360 days). */
export function insuranceRisk(incidents: readonly Incident[], gameMs: number): number {
  let hard = 0;
  let crashes = 0;
  for (const i of incidents) {
    const age = gameMs - i.gameMs;
    if (age < 0) continue;
    if (i.kind === "hard_landing" && age < INSURANCE.hardLandingWindowDays * GAME_DAY_MS) hard++;
    if (i.kind === "crash" && age < INSURANCE.crashWindowDays * GAME_DAY_MS) crashes++;
  }
  return Math.min(
    INSURANCE.maxRisk,
    1 + INSURANCE.hardLandingRisk * hard + INSURANCE.crashRisk * crashes,
  );
}

/** Monthly premium = 0.3 % × hull value × risk, cents. */
export function insurancePremium(value: number, risk: number): number {
  return round2(Math.max(0, value) * INSURANCE.monthlyShare * risk);
}

/** Defect causes an incident repair claim covers. */
export const CLAIMABLE_CAUSES: ReadonlySet<DefectCause> = new Set<DefectCause>([
  "hard_landing",
  "crash",
]);

/** Repair claim = 80 % × max(0, incident repair cost − $2,000 deductible). */
export function repairClaim(incidentCost: number): number {
  return round2(INSURANCE.coverageShare * Math.max(0, incidentCost - INSURANCE.deductible));
}

/** Write-off claim = 80 % of the hull value just before the crash. */
export function writeOffClaim(valueBefore: number): number {
  return round2(INSURANCE.coverageShare * Math.max(0, valueBefore));
}

// ---- insurer repair loans (plan §7.4 "repossession-free repair loans") ----

export type RepairLoanRefusal =
  | "not_owned"
  | "aircraft_busy"
  | "not_insured"
  | "repair_loan_open"
  | "no_repair_bill"
  | "bad_term"
  | "bad_principal"
  | "exceeds_bill";

export interface RepairLoanCheckInput {
  ownership: Ownership;
  status: AircraftStatus;
  /** An active hull policy on the aircraft. */
  insured: boolean;
  /** The aircraft already has an active repair loan. */
  openRepairLoan: boolean;
  /** Repair bill the insurer would finance: cost − incident claim, dollars. */
  bill: number;
  principal: number;
  termMonths: number;
}

export type RepairLoanCheck =
  { ok: true } | { ok: false; code: RepairLoanRefusal; message: string };

/**
 * Eligibility, first failing rule wins: owned → not hired or flying → active policy → no
 * open repair loan → a bill to finance → term 6–24 months → at least $500 → at most the bill.
 */
export function repairLoanCheck(i: RepairLoanCheckInput): RepairLoanCheck {
  const policy = repairLoanPolicyCheck(i);
  if (!policy.ok) return policy;
  const no = (code: RepairLoanRefusal, message: string): RepairLoanCheck => ({
    ok: false,
    code,
    message,
  });
  if (!(i.bill > 0)) return no("no_repair_bill", "There is no repair bill to finance");
  if (
    !Number.isInteger(i.termMonths) ||
    i.termMonths < REPAIR_LOAN.minTermMonths ||
    i.termMonths > REPAIR_LOAN.maxTermMonths
  ) {
    return no(
      "bad_term",
      `The insurer lends for ${REPAIR_LOAN.minTermMonths}–${REPAIR_LOAN.maxTermMonths} months`,
    );
  }
  // Judged in cents, as the book books it (499.996 → $500.00).
  if (!(Math.round(i.principal * 100) >= Math.round(REPAIR_LOAN.minAmount * 100))) {
    return no("bad_principal", `The insurer finances at least $${REPAIR_LOAN.minAmount}`);
  }
  if (Math.round(i.principal * 100) > Math.round(i.bill * 100)) {
    return no(
      "exceeds_bill",
      `At most the repair bill ($${round2(i.bill).toLocaleString("en-US")}, after the incident claim)`,
    );
  }
  return { ok: true };
}

/** The aircraft-and-policy half of the rules (no amounts): the first four rows. */
export function repairLoanPolicyCheck(
  i: Pick<RepairLoanCheckInput, "ownership" | "status" | "insured" | "openRepairLoan">,
): RepairLoanCheck {
  const no = (code: RepairLoanRefusal, message: string): RepairLoanCheck => ({
    ok: false,
    code,
    message,
  });
  if (i.ownership !== "owned") return no("not_owned", "Only owned aircraft can be insured");
  if (i.status === "hired") {
    return no(
      "aircraft_busy",
      "The aircraft is assigned to a hired pilot: unassign the pilot first",
    );
  }
  if (i.status === "in_flight") return no("aircraft_busy", "The aircraft is flying");
  if (!i.insured) {
    return no("not_insured", "Repair loans need an active hull policy on the aircraft");
  }
  if (i.openRepairLoan) {
    return no("repair_loan_open", "The aircraft already has an open repair loan: pay it off first");
  }
  return { ok: true };
}

/** What the insurer finances: the repair cost minus the incident claim it pays, ≥ 0. */
export function repairLoanBill(cost: number, claim: number): number {
  return round2(Math.max(0, cost - claim));
}

/** Fixed-APR terms of a repair loan: standard amortisation, cents. */
export function repairLoanTerms(
  principal: number,
  termMonths: number,
): { apr: number; payment: number; totalInterest: number } {
  const apr = REPAIR_LOAN.apr;
  const schedule = amortisationSchedule(principal, apr, termMonths);
  return {
    apr,
    payment: monthlyPayment(principal, apr, termMonths),
    totalInterest: round2(schedule.reduce((s, r) => s + r.interest, 0)),
  };
}
