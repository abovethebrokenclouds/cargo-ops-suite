// Fleet rules (plan §7 "Wear", "Fleet", reputation gates): wear per flight, repair cost
// and time, market value, tier gates, registrations, the overspeed detector and the
// TITLE → owned-aircraft selection. Pure functions.

import {
  AIRCRAFT_CATEGORIES,
  matchAircraftType,
  type AircraftType,
} from "../../protocol/src/aircraft-types";
import { REPUTATION_TIER_NAMES } from "../../protocol/src/company";
import {
  AIRCRAFT_CLASS_MIN_TIER,
  JOB_KIND_MIN_TIER,
  LEASE_TIER_DISCOUNT,
  MIN_DISPATCH_CONDITION,
  OVERSPEED_REARM_KT,
  OVERSPEED_SUSTAIN_MS,
  REPAIR_COST_SHARE,
  REPAIR_HOURS_BASE,
  REPAIR_HOURS_PER_POINT,
  SALE_SHARE,
  VALUE_CONDITION_WEIGHT,
  VALUE_FLOOR_SHARE,
  VALUE_LOSS_PER_FLIGHT_HOUR,
  WEAR,
} from "./company-constants";
import type { CargoKind } from "../../protocol/src/economy";
import { round2 } from "./geo";
import { reputationTier } from "./payout";
import { hashString } from "./prng";

export type AircraftCategory = (typeof AIRCRAFT_CATEGORIES)[number];

// ---- reputation tiers and gates ----

export function tierName(tier: number): string {
  return REPUTATION_TIER_NAMES[Math.max(0, Math.min(5, tier))] ?? "Startup";
}

export interface TierRow {
  tier: number;
  name: string;
  from: number;
  to: number;
  aircraftClasses: AircraftCategory[];
  jobKinds: CargoKind[];
}

/** The tier table (docs/ECONOMY.md): reputation band, buyable classes and job kinds. */
export function tierTable(): TierRow[] {
  return [0, 1, 2, 3, 4, 5].map((tier) => ({
    tier,
    name: tierName(tier),
    from: tier * 20,
    to: tier === 5 ? 100 : tier * 20 + 19,
    aircraftClasses: AIRCRAFT_CATEGORIES.filter((c) => AIRCRAFT_CLASS_MIN_TIER[c] <= tier),
    jobKinds: (Object.keys(JOB_KIND_MIN_TIER) as CargoKind[]).filter(
      (k) => JOB_KIND_MIN_TIER[k] <= tier,
    ),
  }));
}

/** Minimum tier to buy (or, one tier lower, lease) a type. */
export function purchaseMinTier(type: AircraftType): number {
  return AIRCRAFT_CLASS_MIN_TIER[type.category];
}
export function leaseMinTier(type: AircraftType): number {
  return Math.max(0, purchaseMinTier(type) - LEASE_TIER_DISCOUNT);
}
export function canBuy(type: AircraftType, reputation: number): boolean {
  return reputationTier(reputation) >= purchaseMinTier(type);
}
export function canLease(type: AircraftType, reputation: number): boolean {
  return reputationTier(reputation) >= leaseMinTier(type);
}
export function jobKindAllowed(kind: CargoKind, reputation: number): boolean {
  return reputationTier(reputation) >= JOB_KIND_MIN_TIER[kind];
}

// ---- wear, repair, value ----

export interface WearInput {
  /** Airborne minutes of the flight. */
  airborneMin: number;
  /** Highest touchdown peak G of the flight (null: no touchdown recorded). */
  peakG: number | null;
  overspeedEvents: number;
  crashed: boolean;
}

export interface WearResult {
  hours: number;
  g: number;
  overspeed: number;
  crash: number;
  /** Total condition points lost (2 decimals). */
  total: number;
}

/**
 * Wear (plan §7): 0.5 points per flight hour + 2 × max(0, G − 1.4) / 0.3 + 5 per overspeed
 * event (+ 50 for a crash). Rounded to 0.01 point.
 */
export function flightWear(input: WearInput): WearResult {
  const hours = (Math.max(0, input.airborneMin) / 60) * WEAR.perFlightHour;
  const g =
    input.peakG === null
      ? 0
      : (WEAR.perGStep * Math.max(0, input.peakG - WEAR.gThreshold)) / WEAR.gStep;
  const overspeed = WEAR.perOverspeed * Math.max(0, input.overspeedEvents);
  const crash = input.crashed ? WEAR.crash : 0;
  return {
    hours: round2(hours),
    g: round2(g),
    overspeed,
    crash,
    total: round2(hours + g + overspeed + crash),
  };
}

export function applyWear(condition: number, wear: number): number {
  return round2(Math.max(0, Math.min(100, condition - wear)));
}

export function isAirworthy(condition: number): boolean {
  return condition >= MIN_DISPATCH_CONDITION;
}

/** Repair cost, dollars: 8 % × catalogue price × wear / 100. */
export function repairCost(type: AircraftType, condition: number): number {
  const wear = Math.max(0, 100 - condition);
  return round2((REPAIR_COST_SHARE * type.priceUsd * wear) / 100);
}

/** Repair time, in-game hours: 2 + 1.5 × wear points (0 when there is no wear). */
export function repairHours(condition: number): number {
  const wear = Math.max(0, 100 - condition);
  if (wear <= 0) return 0;
  return round2(REPAIR_HOURS_BASE + REPAIR_HOURS_PER_POINT * wear);
}

/** Market value, dollars: price × max(0.4, 1 − 0.00002 × hours) × (0.7 + 0.3 × condition/100). */
export function marketValue(type: AircraftType, hours: number, condition: number): number {
  const age = Math.max(VALUE_FLOOR_SHARE, 1 - VALUE_LOSS_PER_FLIGHT_HOUR * Math.max(0, hours));
  const cond = 1 - VALUE_CONDITION_WEIGHT + (VALUE_CONDITION_WEIGHT * condition) / 100;
  return round2(type.priceUsd * age * cond);
}

/** Dealer price when selling: 90 % of the market value. */
export function salePrice(type: AircraftType, hours: number, condition: number): number {
  return round2(marketValue(type, hours, condition) * SALE_SHARE);
}

// ---- registrations ----

const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

/** Deterministic US-style registration (N + 3 digits + 2 letters) from the company seed. */
export function registrationFor(seed: number, n: number, taken: ReadonlySet<string>): string {
  for (let i = 0; i < 1000; i++) {
    const h = hashString(`reg|${seed}|${n}|${i}`);
    const digits = 100 + (h % 900);
    const a = LETTERS[(h >>> 10) % LETTERS.length] ?? "C";
    const b = LETTERS[(h >>> 16) % LETTERS.length] ?? "O";
    const reg = `N${digits}${a}${b}`;
    if (!taken.has(reg)) return reg;
  }
  return `N${n}CO`;
}

// ---- overspeed detector ----

/**
 * Counts overspeed events: IAS above Vmo for ≥ 3 s of simulator time is one event; the
 * next event needs IAS back below Vmo − 5 kt first.
 */
export class OverspeedDetector {
  private since: number | null = null;
  private armed = true;
  count = 0;

  constructor(private vmoKt: number) {}

  setVmo(vmoKt: number): void {
    this.vmoKt = vmoKt;
  }

  update(iasKt: number, tMs: number): boolean {
    if (iasKt > this.vmoKt) {
      if (this.since === null) this.since = tMs;
      if (this.armed && tMs - this.since >= OVERSPEED_SUSTAIN_MS) {
        this.count++;
        this.armed = false;
        return true;
      }
    } else {
      this.since = null;
      if (iasKt < this.vmoKt - OVERSPEED_REARM_KT) this.armed = true;
    }
    return false;
  }

  reset(): void {
    this.since = null;
    this.armed = true;
    this.count = 0;
  }
}

// ---- TITLE → owned aircraft ----

export interface SelectableAircraft {
  id: string;
  typeKey: string;
  location: string;
}

export interface Selection {
  id: string | null;
  source: "manual" | "title" | "single" | "none";
  ambiguous: boolean;
  /** Candidates when ambiguous (or the matched type has none in the fleet: empty). */
  candidates: string[];
  /** Catalogue type the TITLE matched, if any. */
  matchedTypeKey: string | null;
}

/**
 * Which fleet aircraft the sim is flying: a valid manual choice wins; else the TITLE is
 * matched to a catalogue type and the fleet aircraft of that type is used: one candidate →
 * it; several → the one parked at `nearAirport` if exactly one is; otherwise ambiguous
 * (manual selection needed). Without a TITLE match a single-aircraft fleet selects itself.
 */
export function selectAircraft(
  fleet: readonly SelectableAircraft[],
  title: string | null,
  manualId: string | null,
  nearAirport: string | null,
): Selection {
  if (manualId && fleet.some((a) => a.id === manualId)) {
    return {
      id: manualId,
      source: "manual",
      ambiguous: false,
      candidates: [],
      matchedTypeKey: null,
    };
  }
  const type = matchAircraftType(title);
  if (type) {
    const candidates = fleet.filter((a) => a.typeKey === type.key);
    if (candidates.length === 1 && candidates[0]) {
      return {
        id: candidates[0].id,
        source: "title",
        ambiguous: false,
        candidates: [],
        matchedTypeKey: type.key,
      };
    }
    if (candidates.length > 1) {
      const here = nearAirport ? candidates.filter((a) => a.location === nearAirport) : [];
      if (here.length === 1 && here[0]) {
        return {
          id: here[0].id,
          source: "title",
          ambiguous: false,
          candidates: [],
          matchedTypeKey: type.key,
        };
      }
      return {
        id: null,
        source: "none",
        ambiguous: true,
        candidates: candidates.map((a) => a.id),
        matchedTypeKey: type.key,
      };
    }
    return { id: null, source: "none", ambiguous: false, candidates: [], matchedTypeKey: type.key };
  }
  if (fleet.length === 1 && fleet[0]) {
    return {
      id: fleet[0].id,
      source: "single",
      ambiguous: false,
      candidates: [],
      matchedTypeKey: null,
    };
  }
  return { id: null, source: "none", ambiguous: false, candidates: [], matchedTypeKey: null };
}
