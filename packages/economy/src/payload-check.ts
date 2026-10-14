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
// Payload entered by you (docs/ECONOMY.md "Payload entered by you"): a player number for the
// mission. It only stands in for an `unknown` readout (status stays unknown, bonuses kept,
// except the overload warning when EMPTY WEIGHT + fuel + entered > MAX GROSS WEIGHT); with a
// station readout the sim decides and the entered value is shown as agreeing/contradicting.
//
// TOTAL WEIGHT cross-check: implied = TOTAL WEIGHT − EMPTY WEIGHT − fuel (only when all are
// reported and consistent), compared with the station sum or the entered value. Informational.
//
// Pure: the connector feeds it the latest telemetry; nothing is ever estimated.

import type { PayloadCheck, PayloadCheckStatus } from "../../protocol/src/economy";
import {
  CROSSCHECK_TOLERANCE_MIN_KG,
  CROSSCHECK_TOLERANCE_SHARE,
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
  /** `weights` domain (TOTAL WEIGHT, MAX GROSS WEIGHT, EMPTY WEIGHT) when reported. */
  weights?: { totalLb: number; maxGrossLb: number; emptyLb?: number } | null | undefined;
  /** Fuel on board (`fuel.totalLb`), pounds, when reported. */
  fuelLb?: number | null | undefined;
  /** Player setting, kg; null or absent = automatic (crew seats, else 0 kg). */
  crewAllowanceKg?: number | null | undefined;
  /** Payload the player entered for the mission, kg (source player); null/absent = none. */
  enteredPayloadKg?: number | null | undefined;
  source: PayloadCheck["source"];
  stage: PayloadCheck["stage"];
  /** ISO 8601 wall clock. */
  checkedAt: string;
}

/** Allowed shortfall below the cargo weight, kg. */
export function payloadToleranceKg(cargoKg: number): number {
  return round1(Math.max(PAYLOAD_TOLERANCE_MIN_KG, PAYLOAD_TOLERANCE_SHARE * cargoKg));
}

/** Allowed difference between the implied payload and the compared payload, kg. */
export function crossCheckToleranceKg(impliedKg: number): number {
  return round1(Math.max(CROSSCHECK_TOLERANCE_MIN_KG, CROSSCHECK_TOLERANCE_SHARE * impliedKg));
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

const finiteNum = (v: number | null | undefined): v is number =>
  typeof v === "number" && Number.isFinite(v);

export function checkPayload(input: PayloadCheckInput): PayloadCheck {
  const cargoKg = Math.max(0, input.cargoKg);
  const toleranceKg = payloadToleranceKg(cargoKg);
  const w = input.weights;
  const known =
    w && Number.isFinite(w.totalLb) && Number.isFinite(w.maxGrossLb) && w.maxGrossLb > 0 ? w : null;
  const emptyLb = known && finiteNum(known.emptyLb) && known.emptyLb >= 0 ? known.emptyLb : null;
  const fuelLb = finiteNum(input.fuelLb) && input.fuelLb >= 0 ? input.fuelLb : null;
  const entered =
    finiteNum(input.enteredPayloadKg) && input.enteredPayloadKg >= 0
      ? round1(input.enteredPayloadKg)
      : null;
  const setting = finiteNum(input.crewAllowanceKg) ? Math.max(0, input.crewAllowanceKg) : null;

  const base = {
    stage: input.stage,
    source: input.source,
    cargoKg,
    toleranceKg,
    checkedAt: input.checkedAt,
    ...(known
      ? { totalLb: Math.round(known.totalLb), maxGrossLb: Math.round(known.maxGrossLb) }
      : {}),
    ...(emptyLb !== null ? { emptyLb: Math.round(emptyLb) } : {}),
    ...(fuelLb !== null ? { fuelLb: Math.round(fuelLb) } : {}),
    ...(entered !== null ? { enteredKg: entered } : {}),
  };
  const overMessage = known
    ? `Total weight ${Math.round(known.totalLb)} lb is above the maximum ${Math.round(known.maxGrossLb)} lb`
    : "";
  const over = known !== null && known.totalLb > known.maxGrossLb;
  const lbToKg = (lb: number) => Math.max(0, lb) * KG_PER_LB;

  // TOTAL WEIGHT − EMPTY WEIGHT − fuel: everything on board but fuel. Only when the sim
  // reports all three and they are consistent (a negative remainder is never shown as 0).
  const impliedLb =
    known && emptyLb !== null && fuelLb !== null ? known.totalLb - emptyLb - fuelLb : null;
  const impliedKg = impliedLb !== null && impliedLb >= 0 ? round1(lbToKg(impliedLb)) : null;
  const crossCheck = (comparedKg: number, withWhat: "stations" | "entered") => {
    if (impliedKg === null) return { extra: {}, note: "" };
    const tol = crossCheckToleranceKg(impliedKg);
    const mismatch = Math.abs(impliedKg - comparedKg) > tol;
    return {
      extra: {
        crossCheck: mismatch ? ("mismatch" as const) : ("match" as const),
        crossCheckWith: withWhat,
        crossCheckToleranceKg: tol,
      },
      note: mismatch
        ? `; TOTAL WEIGHT implies ${Math.round(impliedKg)} kg on board besides fuel, ${
            withWhat === "stations" ? "the payload stations" : "the payload entered by you"
          } ${Math.round(comparedKg)} kg (mismatch beyond ${Math.round(tol)} kg)`
        : "",
    };
  };
  const implied = impliedKg !== null ? { impliedKg } : {};

  const stations = (input.stations ?? []).filter((s) => Number.isFinite(s.weightLb));
  if (stations.length === 0) {
    if (entered === null) {
      return {
        ...base,
        ...implied,
        status: over ? "overloaded" : "unknown",
        ...(over ? { overBasis: "total_weight" as const } : {}),
        message: over
          ? `${overMessage}; the sim reported no payload stations to compare with the cargo`
          : "The simulator reported no payload stations: the cargo cannot be compared (no penalty)",
      };
    }
    // The entered value stands in for the missing readout: informational plus overload safety.
    const crewKg = setting ?? 0;
    const cc = crossCheck(entered + crewKg, "entered");
    const estLb =
      emptyLb !== null && fuelLb !== null ? emptyLb + fuelLb + (entered + crewKg) / KG_PER_LB : null;
    const versus =
      entered < cargoKg - toleranceKg
        ? `below the ${Math.round(cargoKg)} kg cargo`
        : `for the ${Math.round(cargoKg)} kg cargo`;
    let status: PayloadCheckStatus = "unknown";
    let overBasis: PayloadCheck["overBasis"];
    let message = `The simulator reported no payload stations; payload entered by you ${Math.round(entered)} kg, ${versus} (not verified by the sim: no penalty, bonuses unaffected)`;
    if (over) {
      status = "overloaded";
      overBasis = "total_weight";
      message = `${overMessage}; the sim reported no payload stations (payload entered by you ${Math.round(entered)} kg)`;
    } else if (known && estLb !== null && estLb > known.maxGrossLb) {
      status = "overloaded";
      overBasis = "entered";
      message = `Empty weight + fuel + the payload entered by you (${Math.round(entered)} kg) = ${Math.round(estLb)} lb, above the maximum ${Math.round(known.maxGrossLb)} lb`;
    }
    return {
      ...base,
      ...implied,
      ...cc.extra,
      status,
      ...(overBasis ? { overBasis } : {}),
      enteredRole: "used",
      message: message + cc.note,
    };
  }

  const simPayloadKg = round1(stations.reduce((s, x) => s + lbToKg(x.weightLb), 0));
  let crewKg: number;
  let crewBasis: NonNullable<PayloadCheck["crewBasis"]>;
  const crew = crewStations(stations);
  if (setting !== null) {
    crewKg = setting;
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
  const short = (kg: number) => kg < cargoKg - toleranceKg;

  let status: PayloadCheckStatus;
  let message: string;
  if (over) {
    status = "overloaded";
    message = overMessage;
  } else if (short(loadedKg)) {
    status = "underloaded";
    message = `Sim payload ${Math.round(loadedKg)} kg (after ${Math.round(crewKg)} kg crew) is below the ${Math.round(cargoKg)} kg cargo`;
  } else {
    status = "ok";
    message =
      loadedKg > cargoKg + toleranceKg
        ? `Sim payload ${Math.round(loadedKg)} kg covers the ${Math.round(cargoKg)} kg cargo (extra weight on board)`
        : `Sim payload ${Math.round(loadedKg)} kg matches the ${Math.round(cargoKg)} kg cargo`;
  }
  // A sim reading exists: the entered value never changes the status, it is only compared.
  let enteredRole: PayloadCheck["enteredRole"];
  if (entered !== null) {
    enteredRole = short(entered) === short(loadedKg) ? "agrees" : "contradicts";
    if (enteredRole === "contradicts") {
      message += `; the payload entered by you (${Math.round(entered)} kg) contradicts the sim and is ignored`;
    }
  }
  const cc = crossCheck(simPayloadKg, "stations");
  return {
    ...base,
    ...implied,
    ...cc.extra,
    status,
    ...(over ? { overBasis: "total_weight" as const } : {}),
    simPayloadKg,
    crewKg,
    crewBasis,
    loadedKg,
    ...(enteredRole ? { enteredRole } : {}),
    message: message + cc.note,
  };
}

/** Only an underloaded check frozen at departure affects the payout (bonuses removed). */
export function payloadMismatch(check: PayloadCheck | null | undefined): boolean {
  return check?.stage === "departure" && check.status === "underloaded";
}
