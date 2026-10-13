// Hull insurance (plan §7.4): an optional policy per owned aircraft. The monthly premium
// is proportional to the hull value and to the risk (recent hard landings and crashes);
// the policy pays a share of a crash write-off and of repairs after incidents.

import type { DefectCause } from "../../protocol/src/maintenance";
import { GAME_DAY_MS } from "./company-constants";
import { INSURANCE } from "./fbo-constants";
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
