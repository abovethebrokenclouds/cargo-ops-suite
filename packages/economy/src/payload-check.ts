// Payload check (docs/ECONOMY.md "Payload check"): the cargo a mission requires against
// the payload stations the simulator reports, minus a pilot/crew allowance.
//
//   crew      = player setting, else the FIRST pilot seat (whole name Pilot / Co-pilot /
//               Captain / First Officer) + every "Crew" seat, else 0 kg
//
//   loaded    = Σ PAYLOAD STATION WEIGHT − crew allowance   (never below 0)
//   tolerance = max(25 kg, 10 % of the cargo)
//   overloaded   TOTAL WEIGHT > MAX GROSS WEIGHT (only when the sim reports both)
//   underloaded  loaded < cargo − tolerance
//   unknown      the sim reported no payload stations (never penalises)
//
// Pure: the connector feeds it the latest telemetry; nothing is ever estimated.

import type { PayloadCheck, PayloadCheckStatus } from "../../protocol/src/economy";
import {
  CREW_SEAT_PATTERN,
  DEFAULT_CREW_ALLOWANCE_KG,
  PAYLOAD_TOLERANCE_MIN_KG,
  PAYLOAD_TOLERANCE_SHARE,
  PILOT_SEAT_PATTERN,
} from "./constants";
import { KG_PER_LB } from "./costs";
import { round1 } from "./geo";

export interface PayloadCheckInput {
  /** Cargo the mission requires, kg. */
  cargoKg: number;
  /** `payload.stations` as the sim reports them; null, absent or empty → unknown. */
  stations: ReadonlyArray<{ name: string; weightLb: number }> | null | undefined;
  /** `weights` domain (TOTAL WEIGHT, MAX GROSS WEIGHT) when reported. */
  weights?: { totalLb: number; maxGrossLb: number } | null | undefined;
  /** Player setting, kg; null or absent = automatic (crew seats, else 0 kg). */
  crewAllowanceKg?: number | null | undefined;
  source: PayloadCheck["source"];
  stage: PayloadCheck["stage"];
  /** ISO 8601 wall clock. */
  checkedAt: string;
}

/** Allowed shortfall below the cargo weight, kg. */
export function payloadToleranceKg(cargoKg: number): number {
  return round1(Math.max(PAYLOAD_TOLERANCE_MIN_KG, PAYLOAD_TOLERANCE_SHARE * cargoKg));
}

/** A station whose whole name is a pilot seat (Pilot, Co-pilot, Captain, First Officer). */
export function isPilotSeat(name: string): boolean {
  return PILOT_SEAT_PATTERN.test(name.trim());
}

/** A station whose whole name is an explicit crew seat (Crew, Crew Seat 2). */
export function isCrewSeat(name: string): boolean {
  return CREW_SEAT_PATTERN.test(name.trim());
}

/**
 * Stations counted as crew: the first pilot seat (a second one such as "Copilot" may
 * carry cargo, so it counts as payload) plus every explicit crew seat. Baggage, cargo and
 * compartment stations never match ("Pilot Baggage" is cargo).
 */
export function crewStations<T extends { name: string }>(stations: readonly T[]): T[] {
  const firstPilot = stations.find((s) => isPilotSeat(s.name));
  return stations.filter((s) => s === firstPilot || isCrewSeat(s.name));
}

export function checkPayload(input: PayloadCheckInput): PayloadCheck {
  const cargoKg = Math.max(0, input.cargoKg);
  const base = {
    stage: input.stage,
    source: input.source,
    cargoKg,
    toleranceKg: payloadToleranceKg(cargoKg),
    checkedAt: input.checkedAt,
  };
  const w = input.weights;
  const known =
    w && Number.isFinite(w.totalLb) && Number.isFinite(w.maxGrossLb) && w.maxGrossLb > 0 ? w : null;
  const mtow = known
    ? { totalLb: Math.round(known.totalLb), maxGrossLb: Math.round(known.maxGrossLb) }
    : {};
  const overMessage = known
    ? `Total weight ${Math.round(known.totalLb)} lb is above the maximum ${Math.round(known.maxGrossLb)} lb`
    : "";
  const over = known !== null && known.totalLb > known.maxGrossLb;

  const stations = (input.stations ?? []).filter((s) => Number.isFinite(s.weightLb));
  if (stations.length === 0) {
    return {
      ...base,
      ...mtow,
      status: over ? "overloaded" : "unknown",
      message: over
        ? `${overMessage}; the sim reported no payload stations to compare with the cargo`
        : "The simulator reported no payload stations: the cargo cannot be compared (no penalty)",
    };
  }

  const lbToKg = (lb: number) => Math.max(0, lb) * KG_PER_LB;
  const simPayloadKg = round1(stations.reduce((s, x) => s + lbToKg(x.weightLb), 0));
  let crewKg: number;
  let crewBasis: NonNullable<PayloadCheck["crewBasis"]>;
  const setting = input.crewAllowanceKg;
  const crew = crewStations(stations);
  if (typeof setting === "number" && Number.isFinite(setting)) {
    crewKg = Math.max(0, setting);
    crewBasis = "setting";
  } else if (crew.length > 0) {
    crewKg = crew.reduce((s, x) => s + lbToKg(x.weightLb), 0);
    crewBasis = "stations";
  } else {
    crewKg = DEFAULT_CREW_ALLOWANCE_KG;
    crewBasis = "default";
  }
  crewKg = round1(crewKg);
  const loadedKg = round1(Math.max(0, simPayloadKg - crewKg));

  let status: PayloadCheckStatus;
  let message: string;
  if (over) {
    status = "overloaded";
    message = overMessage;
  } else if (loadedKg < cargoKg - base.toleranceKg) {
    status = "underloaded";
    message = `Sim payload ${Math.round(loadedKg)} kg (after ${Math.round(crewKg)} kg crew) is below the ${Math.round(cargoKg)} kg cargo`;
  } else {
    status = "ok";
    message =
      loadedKg > cargoKg + base.toleranceKg
        ? `Sim payload ${Math.round(loadedKg)} kg covers the ${Math.round(cargoKg)} kg cargo (extra weight on board)`
        : `Sim payload ${Math.round(loadedKg)} kg matches the ${Math.round(cargoKg)} kg cargo`;
  }
  return { ...base, ...mtow, status, simPayloadKg, crewKg, crewBasis, loadedKg, message };
}

/** Only an underloaded check frozen at departure affects the payout (bonuses removed). */
export function payloadMismatch(check: PayloadCheck | null | undefined): boolean {
  return check?.stage === "departure" && check.status === "underloaded";
}
