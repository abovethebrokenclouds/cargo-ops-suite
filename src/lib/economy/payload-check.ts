// Text for the payload check (docs/ECONOMY.md "Payload check"); the check itself is
// computed by the connector with the shared rule in packages/economy.

import type { PayloadCheck } from "@cargo-ops/protocol";

/** Upper bound of `mission.payload` (protocol), kg. */
const MAX_ENTERED_KG = 200_000;

/** Parse the entered-payload field: null = empty (clear), NaN = invalid. */
export function parseEnteredPayload(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n <= MAX_ENTERED_KG ? n : Number.NaN;
}

/** How the payload entered by you was used, or null when none was entered. */
export function enteredPayloadNote(check: PayloadCheck): string | null {
  if (check.enteredKg === undefined) return null;
  switch (check.enteredRole) {
    case "used":
      return "used because the sim reports no payload stations · not verified, no bonus or penalty from it";
    case "agrees":
      return "agrees with the sim reading";
    case "contradicts":
      return "contradicts the sim reading: ignored, the sim decides";
    default:
      return null;
  }
}

/** Consequence of the check in one sentence, or null when there is nothing to do. */
export function payloadCheckAdvice(check: PayloadCheck): string | null {
  const preview = check.stage === "preview";
  switch (check.status) {
    case "underloaded":
      return preview
        ? "Load the cargo in the simulator before departure, or this mission pays no bonuses."
        : "No payout bonuses: the sim payload was below the cargo at departure.";
    case "overloaded":
      if (check.overBasis === "entered") {
        return preview
          ? "The payload you entered would put the aircraft above max gross weight: check the load. A warning only; just the sim's total weight can block the start."
          : "The payload you entered put the aircraft above max gross weight at departure (a warning, no penalty).";
      }
      return preview
        ? "Above max gross weight: the flight cannot start until weight is removed."
        : "Above max gross weight at departure.";
    case "unknown":
      return check.enteredKg !== undefined
        ? "The simulator reports no payload stations: the payload you entered is shown instead, not verified. Nothing is penalised and bonuses are unaffected."
        : "The simulator reports no payload stations, so nothing is compared and nothing is penalised.";
    default:
      return null;
  }
}
