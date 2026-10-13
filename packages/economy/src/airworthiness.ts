// P5 airworthiness (plan §7.1): per-system condition and defects, the dispatch gate,
// annual inspections, ferry permits, repair cost/time, wear distribution and the defect
// rolls that follow wear, hard landings, overspeed, fuel exhaustion and crashes. Pure and
// seeded; docs/ECONOMY.md ("P5") has the worked examples.

import type { AircraftType } from "../../protocol/src/aircraft-types";
import {
  SYSTEM_KEYS,
  type AirworthinessStatus,
  type Defect,
  type DefectCause,
  type DefectSeverity,
  type FerryPermit,
  type GateReason,
  type MaintenanceOrder,
  type SystemKey,
} from "../../protocol/src/maintenance";
import type { AirportLookup, EconomyAirport } from "./airports";
import { LANDING_FEE_CATEGORY_FACTOR } from "./company-constants";
import { greatCircleNm, round1, round2 } from "./geo";
import {
  ANNUAL_COST_SHARE,
  ANNUAL_HOURS_BY_CATEGORY,
  ANNUAL_INTERVAL_HOURS,
  ANNUAL_INTERVAL_MS,
  ANNUAL_SOON_HOURS,
  ANNUAL_SOON_MS,
  DEFERRAL_LIMIT_HOURS,
  FERRY_MIN_SYSTEM_CONDITION,
  FERRY_PAYLOAD_SHARE,
  FERRY_PERMIT_FEE_BASE,
  HARD_LANDING_G,
  MAJOR_ESCALATION_MAX,
  MAJOR_ESCALATION_PER_HOUR,
  MAJOR_FUEL_PCT,
  MAJOR_PAYLOAD_PCT,
  MAX_PAYLOAD_PENALTY_PCT,
  MIN_SYSTEM_CONDITION,
  MINOR_FUEL_PCT,
  OVERSPEED_DEFECT_CHANCE,
  PARTS_RARITY,
  SEVERITY_COST_SHARE,
  SEVERITY_HOURS,
  SHOP_FACTORS,
  SYSTEM_COST_FACTOR,
  SYSTEM_TIME_FACTOR,
  SYSTEM_WEIGHTS,
  WEAR_THRESHOLD_CHANCE,
  WEAR_THRESHOLD_SEVERITY,
  WEAR_THRESHOLDS,
  WEAR_UNIFORM_SHARE,
} from "./maintenance-constants";
import type { Rng } from "./prng";

export type SystemConditions = Record<SystemKey, number>;
export type Shop = keyof typeof SHOP_FACTORS;

// ---- maintenance capability (extended by the FBO lane) ----

/**
 * Where maintenance is available. P5 part 1: every large airport. The FBO lane adds the
 * player's own maintenance shops by wrapping this interface (its `shop` level can also
 * lower the factors).
 */
export interface MaintenanceCapability {
  isMaintenanceCapable(icao: string): boolean;
}

/** Default: large airports from the bundled OurAirports data are maintenance-capable. */
export function largeAirportMaintenance(lookup: AirportLookup | null): MaintenanceCapability {
  return {
    isMaintenanceCapable: (icao) => lookup?.get(icao)?.type === "large",
  };
}

export function shopAt(capability: MaintenanceCapability, icao: string): Shop {
  return capability.isMaintenanceCapable(icao) ? "maintenance" : "field";
}

/** Nearest maintenance-capable airport other than `from`, or null. */
export function nearestMaintenanceAirport(
  from: EconomyAirport,
  list: readonly EconomyAirport[],
  capability: MaintenanceCapability,
): { airport: EconomyAirport; distanceNm: number } | null {
  let best: { airport: EconomyAirport; distanceNm: number } | null = null;
  for (const a of list) {
    if (a.ident === from.ident || !capability.isMaintenanceCapable(a.ident)) continue;
    const d = greatCircleNm(from, a);
    if (!best || d < best.distanceNm) best = { airport: a, distanceNm: d };
  }
  return best ? { airport: best.airport, distanceNm: round1(best.distanceNm) } : null;
}

// ---- systems and the overall condition ----

export function systemsFromCondition(condition: number): SystemConditions {
  const c = round2(Math.max(0, Math.min(100, condition)));
  return Object.fromEntries(SYSTEM_KEYS.map((k) => [k, c])) as SystemConditions;
}

/** Overall condition = Σ weight × system condition (the P4 `condition`), 0.01 %. */
export function derivedCondition(systems: SystemConditions): number {
  let sum = 0;
  for (const k of SYSTEM_KEYS) sum += SYSTEM_WEIGHTS[k] * systems[k];
  return round2(Math.max(0, Math.min(100, sum)));
}

export interface WearParts {
  /** Flight-hour wear, spread evenly. */
  hours: number;
  /** Touchdown G wear: half even, half on gear + airframe. */
  g: number;
  /** Overspeed wear: half even, half on the airframe. */
  overspeed: number;
  /** Crash wear, spread evenly. */
  crash: number;
}

/**
 * Apply flight wear to the systems so the weighted mean drops by exactly the P4 wear
 * (until a system reaches 0): hours and crash wear evenly; G wear half evenly and half on
 * gear + airframe (Δ = 0.5 × g / (w_gear + w_airframe)); overspeed half evenly and half
 * on the airframe (Δ = 0.5 × o / w_airframe).
 */
export function distributeWear(systems: SystemConditions, w: WearParts): SystemConditions {
  const uniform = w.hours + w.crash + WEAR_UNIFORM_SHARE * w.g + WEAR_UNIFORM_SHARE * w.overspeed;
  const gFocus = ((1 - WEAR_UNIFORM_SHARE) * w.g) / (SYSTEM_WEIGHTS.gear + SYSTEM_WEIGHTS.airframe);
  const oFocus = ((1 - WEAR_UNIFORM_SHARE) * w.overspeed) / SYSTEM_WEIGHTS.airframe;
  const out = { ...systems };
  for (const k of SYSTEM_KEYS) {
    let d = uniform;
    if (k === "gear" || k === "airframe") d += gFocus;
    if (k === "airframe") d += oFocus;
    out[k] = round2(Math.max(0, Math.min(100, systems[k] - d)));
  }
  return out;
}

// ---- defects: cost, time, titles ----

export function partsRarity(type: AircraftType): number {
  return PARTS_RARITY[type.key] ?? 1;
}

/** Repair cost at a maintenance-capable airport: price × severity share × system × rarity. */
export function defectRepairCost(
  type: AircraftType,
  severity: DefectSeverity,
  system: SystemKey,
): number {
  return round2(
    type.priceUsd * SEVERITY_COST_SHARE[severity] * SYSTEM_COST_FACTOR[system] * partsRarity(type),
  );
}

/** Downtime at a maintenance-capable airport, in-game hours: severity hours × system factor. */
export function defectDowntimeHours(severity: DefectSeverity, system: SystemKey): number {
  return round2(SEVERITY_HOURS[severity] * SYSTEM_TIME_FACTOR[system]);
}

/** Cost and time of repairing `defects` at a shop (field repairs: ×1.35 cost, ×1.5 time). */
export function repairQuote(
  defects: readonly Pick<Defect, "repairCost" | "downtimeHours">[],
  shop: Shop,
): { cost: number; hours: number } {
  const f = SHOP_FACTORS[shop];
  const cost = defects.reduce((s, d) => s + d.repairCost, 0);
  const hours = defects.reduce((s, d) => s + d.downtimeHours, 0);
  return { cost: round2(cost * f.cost), hours: round2(hours * f.time) };
}

type Titles = Record<DefectSeverity, readonly string[]>;
const TITLES: Record<SystemKey, Titles> = {
  engines: {
    cosmetic: ["Oil streaks on the cowling", "Faded engine placards"],
    minor: ["Intermittent igniter", "Slow oil seep at the accessory gearbox"],
    major: ["Hot-section borescope findings", "Fuel control unit drift"],
    grounding: ["Compressor blade damage", "Chip detector warning"],
  },
  propeller: {
    cosmetic: ["Spinner paint chipped", "Blade boot scuffs"],
    minor: ["Blade leading-edge erosion", "Slow actuator response"],
    major: ["Governor overspeed tendency", "Actuator hydraulic leak"],
    grounding: ["Blade crack indication", "Pitch/reverser lock failure"],
  },
  airframe: {
    cosmetic: ["Hangar rash on the wingtip", "Minor dents on the belly panels"],
    minor: ["Loose fairing fasteners", "Surface corrosion on a skin panel"],
    major: ["Corrosion at a wing attach fitting", "Skin wrinkling aft of the wing"],
    grounding: ["Cracked spar cap", "Structural damage at a frame"],
  },
  gear: {
    cosmetic: ["Gear doors scuffed", "Worn strut placards"],
    minor: ["Brake wear near limits", "Tyre flat spot"],
    major: ["Shock strut leaking down", "Brake disc heat damage"],
    grounding: ["Cracked gear leg fitting", "Side-brace actuator failure"],
  },
  avionics: {
    cosmetic: ["Faded panel lettering", "Scratched display bezel"],
    minor: ["Intermittent COM2", "Autopilot altitude hold hunting"],
    major: ["Primary display flicker", "Transponder intermittent"],
    grounding: ["Air data computer failure", "Attitude source failure"],
  },
  electrical: {
    cosmetic: ["Cabin light lens cracked", "Untidy wiring labels"],
    minor: ["Battery capacity low", "Chafed wiring loom"],
    major: ["Generator dropping offline", "Bus tie relay intermittent"],
    grounding: ["Smoke from an avionics bus", "Main bus failure"],
  },
  fuel: {
    cosmetic: ["Stained fuel cap placards", "Faded tank markings"],
    minor: ["Fuel quantity indication erratic", "Slow drain valve seep"],
    major: ["Boost pump weak", "Tank sealant failing"],
    grounding: ["Fuel leak at a wing tank", "Contaminated fuel system"],
  },
  hydraulics: {
    cosmetic: ["Hydraulic bay stained", "Faded line labels"],
    minor: ["Reservoir level creeping down", "Pump pressure fluctuating"],
    major: ["Actuator seal leak", "Accumulator precharge low"],
    grounding: ["Hydraulic line rupture", "Main hydraulic pump failure"],
  },
  cargo: {
    cosmetic: ["Scuffed cargo floor", "Worn tie-down markings"],
    minor: ["Door seal worn", "Damaged tie-down rail"],
    major: ["Cargo door latch misrigged", "Floor beam corrosion"],
    grounding: ["Cargo door will not lock", "Cracked floor beam"],
  },
  interior: {
    cosmetic: ["Tired paint", "Worn crew seats"],
    minor: ["Cockpit window crazing", "Cabin heat inoperative"],
    major: ["Crew seat track damage", "Windshield delamination"],
    grounding: ["Cracked windshield", "Emergency exit inoperative"],
  },
};

export interface NewDefectInput {
  id: string;
  system: SystemKey;
  severity: DefectSeverity;
  cause: DefectCause;
  hidden: boolean;
  type: AircraftType;
  /** Company-clock time it was found (known defects). */
  foundGameMs?: number;
}

/** A defect with its title, cost, downtime and (minor/major) performance penalties. */
export function makeDefect(rng: Rng, input: NewDefectInput): Defect {
  const titles = TITLES[input.system][input.severity];
  const title = titles[rng.int(0, titles.length - 1)] ?? "Defect";
  const d: Defect = {
    id: input.id,
    system: input.system,
    severity: input.severity,
    title,
    repairCost: defectRepairCost(input.type, input.severity, input.system),
    downtimeHours: defectDowntimeHours(input.severity, input.system),
    hidden: input.hidden,
    cause: input.cause,
  };
  if (input.severity === "minor") d.fuelBurnPct = MINOR_FUEL_PCT;
  if (input.severity === "major") {
    d.fuelBurnPct = rng.int(MAJOR_FUEL_PCT.min, MAJOR_FUEL_PCT.max);
    d.payloadPct = rng.int(MAJOR_PAYLOAD_PCT.min, MAJOR_PAYLOAD_PCT.max);
  }
  if (!input.hidden && input.foundGameMs !== undefined) d.foundGameMs = input.foundGameMs;
  return d;
}

export function pickSystem(rng: Rng, among: readonly SystemKey[] = SYSTEM_KEYS): SystemKey {
  return rng.weighted(among, (k) => SYSTEM_WEIGHTS[k]) ?? "airframe";
}

export function pickSeverity(
  rng: Rng,
  weights: Partial<Record<DefectSeverity, number>>,
): DefectSeverity {
  const options = Object.keys(weights) as DefectSeverity[];
  return rng.weighted(options, (s) => weights[s] ?? 0) ?? "minor";
}

// ---- the airworthiness gate ----

export interface GateInput {
  systems: SystemConditions;
  defects: readonly Defect[];
  hours: number;
  annual: { lastGameMs: number; lastHours: number };
  ferryPermit: FerryPermit | null;
}

export interface AnnualDue {
  dueGameMs: number;
  dueHours: number;
  due: boolean;
  soon: boolean;
}

/** Annual inspection due every 12 in-game months or 100 flight hours, whichever first. */
export function annualDue(
  annual: { lastGameMs: number; lastHours: number },
  hours: number,
  gameMs: number,
): AnnualDue {
  const dueGameMs = annual.lastGameMs + ANNUAL_INTERVAL_MS;
  const dueHours = round2(annual.lastHours + ANNUAL_INTERVAL_HOURS);
  const due = gameMs >= dueGameMs || hours >= dueHours;
  const soon =
    !due && (gameMs >= dueGameMs - ANNUAL_SOON_MS || hours >= dueHours - ANNUAL_SOON_HOURS);
  return { dueGameMs, dueHours, due, soon };
}

/** Annual inspection cost (0.4 % of price × rarity × shop) and downtime (by category × shop). */
export function annualQuote(type: AircraftType, shop: Shop): { cost: number; hours: number } {
  const f = SHOP_FACTORS[shop];
  return {
    cost: round2(type.priceUsd * ANNUAL_COST_SHARE * partsRarity(type) * f.cost),
    hours: round2(ANNUAL_HOURS_BY_CATEGORY[type.category] * f.time),
  };
}

/** Flight hours left on a deferred minor defect (negative = expired), or null when not deferred. */
export function deferralHoursLeft(d: Defect, hours: number): number | null {
  if (d.severity !== "minor" || d.deferredAtHours === undefined) return null;
  return round2(d.deferredAtHours + DEFERRAL_LIMIT_HOURS - hours);
}

export interface GateResult {
  ok: boolean;
  reasons: GateReason[];
  status: AirworthinessStatus;
  annual: AnnualDue;
  fuelPenaltyPct: number;
  payloadPenaltyPct: number;
}

const SYSTEM_NAME: Record<SystemKey, string> = {
  engines: "engine(s)",
  propeller: "propeller/reversers",
  airframe: "airframe",
  gear: "landing gear",
  avionics: "avionics",
  electrical: "electrical",
  fuel: "fuel system",
  hydraulics: "hydraulics",
  cargo: "cargo hold",
  interior: "interior",
};

/**
 * Dispatch gate (plan §7.1): no known grounding defect; minor defects repaired or deferred
 * and no deferral past 30 flight hours; every system ≥ 20 %; a current annual inspection.
 * Hidden defects are not seen by the gate (they surface on dispatch).
 */
export function airworthinessGate(input: GateInput, gameMs: number): GateResult {
  const reasons: GateReason[] = [];
  const known = input.defects.filter((d) => !d.hidden);
  for (const d of known) {
    if (d.severity === "grounding") {
      reasons.push({
        code: "grounding_defect",
        message: `Grounding defect (${SYSTEM_NAME[d.system]}): ${d.title}`,
        system: d.system,
        defectId: d.id,
      });
    } else if (d.severity === "minor") {
      const left = deferralHoursLeft(d, input.hours);
      if (left === null) {
        reasons.push({
          code: "minor_not_deferred",
          message: `Minor defect not deferred (${SYSTEM_NAME[d.system]}): ${d.title}`,
          system: d.system,
          defectId: d.id,
        });
      } else if (left < 0) {
        reasons.push({
          code: "deferral_expired",
          message: `Deferral past ${DEFERRAL_LIMIT_HOURS} flight hours (${SYSTEM_NAME[d.system]}): ${d.title}`,
          system: d.system,
          defectId: d.id,
        });
      }
    }
  }
  for (const k of SYSTEM_KEYS) {
    if (input.systems[k] < MIN_SYSTEM_CONDITION) {
      reasons.push({
        code: "system_below_minimum",
        message: `${SYSTEM_NAME[k][0]?.toUpperCase()}${SYSTEM_NAME[k].slice(1)} at ${input.systems[k].toFixed(1)} % (minimum ${MIN_SYSTEM_CONDITION} %)`,
        system: k,
      });
    }
  }
  const annual = annualDue(input.annual, input.hours, gameMs);
  if (annual.due) {
    reasons.push({
      code: "annual_due",
      message: `Annual inspection due (every 12 months or ${ANNUAL_INTERVAL_HOURS} flight hours)`,
    });
  }
  const ok = reasons.length === 0;
  const status: AirworthinessStatus = ok
    ? "airworthy"
    : input.ferryPermit
      ? "ferry_only"
      : reasons.every((r) => r.code === "annual_due")
        ? "annual_due"
        : "grounded";
  return {
    ok,
    reasons,
    status,
    annual,
    fuelPenaltyPct: fuelPenaltyPct(known),
    payloadPenaltyPct: payloadPenaltyPct(known),
  };
}

/** Extra fuel burn from known minor (1 % each) and major (5–15 % each) defects, percent. */
export function fuelPenaltyPct(defects: readonly Defect[]): number {
  return round1(defects.filter((d) => !d.hidden).reduce((s, d) => s + (d.fuelBurnPct ?? 0), 0));
}

/** Max payload reduction from known major defects, percent (≤ 30 %). */
export function payloadPenaltyPct(defects: readonly Defect[]): number {
  const sum = defects
    .filter((d) => !d.hidden && d.severity === "major")
    .reduce((s, d) => s + (d.payloadPct ?? 0), 0);
  return Math.min(MAX_PAYLOAD_PENALTY_PCT, sum);
}

/**
 * A ferry permit may be issued when no known grounding defect exists, every system is
 * ≥ 10 %, and there is a reason to ferry: the gate fails (minor/deferral, a system 10–20 %,
 * annual due) or a major defect is open. The destination rule lives in `ferryPlan`.
 */
export function ferryEligible(input: GateInput, gate: GateResult): boolean {
  if (gate.reasons.some((r) => r.code === "grounding_defect")) return false;
  if (SYSTEM_KEYS.some((k) => input.systems[k] < FERRY_MIN_SYSTEM_CONDITION)) return false;
  const majors = input.defects.some((d) => !d.hidden && d.severity === "major");
  return !gate.ok || majors;
}

/** Ferry permit fee: $400 × the landing-fee category factor. */
export function ferryPermitFee(type: AircraftType): number {
  return round2(FERRY_PERMIT_FEE_BASE * LANDING_FEE_CATEGORY_FACTOR[type.category]);
}

/** Payload a ferry flight may carry: 10 % of max payload (crew and baggage), kg. */
export function ferryPayloadCapKg(type: AircraftType): number {
  return Math.round(type.maxPayloadKg * FERRY_PAYLOAD_SHARE);
}

// ---- defect rolls after a flight ----

export interface FlightDefectInput {
  type: AircraftType;
  /** Systems before and after this flight's wear. */
  before: SystemConditions;
  after: SystemConditions;
  existing: readonly Defect[];
  airborneMin: number;
  peakG: number | null;
  overspeedEvents: number;
  tanksDry: boolean;
  crashed: boolean;
  /** Ids for new defects (called once per defect). */
  nextId: () => string;
  gameMs: number;
}

export interface FlightDefectResult {
  /** New known defects. */
  added: Defect[];
  /** Existing defects whose severity changed (major → grounding). */
  escalated: Defect[];
}

/**
 * Seeded defect rolls after a flight (all found at once; they are known, not hidden):
 * - every system condition crossing 75 / 50 / 30 % rolls 50 % for a defect on that system
 *   (75: cosmetic/minor, 50: minor/major, 30: major/grounding);
 * - a touchdown above 1.6 G: chance 0.3 + (G − 1.6) / 0.4 (≤ 1) of a gear (60 %) or airframe
 *   (40 %) defect: < 1.9 G minor/major, < 2.3 G major/grounding, else grounding;
 * - each overspeed event: 50 % for an airframe defect (minor or major);
 * - tanks run dry: an engine major and a fuel-system minor defect;
 * - a crash: 2–4 grounding defects on distinct systems (airframe, gear, engines, propeller);
 * - every open major defect escalates to grounding with chance 3 % per airborne hour (≤ 50 %).
 */
export function rollFlightDefects(rng: Rng, input: FlightDefectInput): FlightDefectResult {
  const added: Defect[] = [];
  const add = (system: SystemKey, severity: DefectSeverity, cause: DefectCause) => {
    added.push(
      makeDefect(rng, {
        id: input.nextId(),
        system,
        severity,
        cause,
        hidden: false,
        type: input.type,
        foundGameMs: input.gameMs,
      }),
    );
  };
  for (const k of SYSTEM_KEYS) {
    for (const t of WEAR_THRESHOLDS) {
      if (input.before[k] >= t && input.after[k] < t && rng.next() < WEAR_THRESHOLD_CHANCE) {
        add(k, pickSeverity(rng, WEAR_THRESHOLD_SEVERITY[t]), "wear");
      }
    }
  }
  const g = input.peakG;
  if (g !== null && g > HARD_LANDING_G) {
    const chance = Math.min(1, 0.3 + (g - HARD_LANDING_G) / 0.4);
    if (rng.next() < chance) {
      const system: SystemKey = rng.next() < 0.6 ? "gear" : "airframe";
      const severity: DefectSeverity =
        g < 1.9
          ? pickSeverity(rng, { minor: 60, major: 40 })
          : g < 2.3
            ? pickSeverity(rng, { major: 70, grounding: 30 })
            : "grounding";
      add(system, severity, "hard_landing");
    }
  }
  for (let i = 0; i < Math.max(0, input.overspeedEvents); i++) {
    if (rng.next() < OVERSPEED_DEFECT_CHANCE) {
      add("airframe", rng.next() < 0.5 ? "minor" : "major", "overspeed");
    }
  }
  if (input.tanksDry) {
    add("engines", "major", "fuel_exhaustion");
    add("fuel", "minor", "fuel_exhaustion");
  }
  if (input.crashed) {
    const pool: SystemKey[] = ["airframe", "gear", "engines", "propeller"];
    const n = rng.int(2, 4);
    for (let i = 0; i < n && pool.length > 0; i++) {
      const j = rng.int(0, pool.length - 1);
      const [system] = pool.splice(j, 1);
      if (system) add(system, "grounding", "crash");
    }
  }
  const escalated: Defect[] = [];
  const p = Math.min(
    MAJOR_ESCALATION_MAX,
    (MAJOR_ESCALATION_PER_HOUR * Math.max(0, input.airborneMin)) / 60,
  );
  for (const d of input.existing) {
    if (d.hidden || d.severity !== "major") continue;
    if (rng.next() < p) {
      const { fuelBurnPct: _f, payloadPct: _p, ...rest } = d;
      escalated.push({
        ...rest,
        severity: "grounding",
        cause: "escalation",
        title: `${d.title} (now grounding)`,
        repairCost: defectRepairCost(input.type, "grounding", d.system),
        downtimeHours: defectDowntimeHours("grounding", d.system),
        foundGameMs: input.gameMs,
      });
    }
  }
  return { added, escalated };
}

/** Maintenance orders on one aircraft run back to back: the next one starts when the last ends. */
export function queueStart(orders: readonly MaintenanceOrder[], gameMs: number): number {
  return orders.reduce((t, o) => Math.max(t, o.readyAtGameMs), Math.floor(gameMs));
}
