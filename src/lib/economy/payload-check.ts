// Text for the payload check (docs/ECONOMY.md "Payload check"); the check itself is
// computed by the connector with the shared rule in packages/economy.

import type { PayloadCheck } from "@cargo-ops/protocol";

/** Consequence of the check in one sentence, or null when there is nothing to do. */
export function payloadCheckAdvice(check: PayloadCheck): string | null {
  const preview = check.stage === "preview";
  switch (check.status) {
    case "underloaded":
      return preview
        ? "Load the cargo in the simulator before departure, or this mission pays no bonuses."
        : "No payout bonuses: the sim payload was below the cargo at departure.";
    case "overloaded":
      return preview
        ? "Above max gross weight: the flight cannot start until weight is removed."
        : "Above max gross weight at departure.";
    case "unknown":
      return "The simulator reports no payload stations, so nothing is compared and nothing is penalised.";
    default:
      return null;
  }
}
