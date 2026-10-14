// The company book: cash, ledger, fleet, loans and the company clock (plan §5 P4, §7,
// §7.2). Pure and in memory: the connector persists what `drain()` returns after each
// operation, and the browser demo runs the same code on a seeded company. Every cash
// change goes through `post()`, so the ledger always balances:
//
//   Σ ledger amounts = cash − starting cash
//
// Operations return `{ ok: true, data }` or `{ ok: false, code, message }`.

import { aircraftTypeByKey, type AircraftType } from "../../protocol/src/aircraft-types";
import type {
  Collateral,
  FleetAircraft,
  FleetState,
  LedgerCategory,
  LedgerEntryState,
  LedgerState,
  LoanKind,
  LoanQuote,
  LoanState,
  LoansState,
  Ownership,
  AircraftStatus,
  PnlMonth,
} from "../../protocol/src/company";
import type { CompanyState, MissionCost } from "../../protocol/src/economy";
import {
  FBO_MODULE_KINDS,
  FBO_MODULE_LABELS,
  MILESTONE_IDS,
  type DemandState,
  type FboModuleKind,
  type FboState,
  type FbosState,
  type InsuranceState,
  type MilestoneId,
} from "../../protocol/src/fbo";
import type { LandingGrade } from "../../protocol/src/landing";
import {
  SYSTEM_KEYS,
  SYSTEM_LABELS,
  type Defect,
  type FerryPermit,
  type MaintenanceOrder,
  type MarketState,
} from "../../protocol/src/maintenance";
import type { EventName } from "../../protocol/src/messages";
import {
  airworthinessGate,
  annualQuote,
  deferralHoursLeft,
  derivedCondition,
  distributeWear,
  ferryEligible,
  ferryPayloadCapKg,
  ferryPermitFee,
  largeAirportMaintenance,
  nearestMaintenanceAirport,
  queueStart,
  repairQuote,
  rollFlightDefects,
  shopAt,
  systemsFromCondition,
  type GateResult,
  type MaintenanceCapability,
  type Shop,
  type SystemConditions,
} from "./airworthiness";
import {
  GAME_YEAR_MS,
  INSPECTION_HOURS,
  MARKET_REFRESH_MS,
  TANKS_DRY_MIN_LB,
  TANKS_DRY_SHARE,
  WRITE_OFF_CONDITION,
} from "./maintenance-constants";
import {
  completeInspection,
  generateMarket,
  listingState,
  purchaseHiddenRoll,
  usedValue,
  type ListingRecord,
} from "./market";
import { Rng, seedFrom } from "./prng";
import type { AirportLookup, EconomyAirport } from "./airports";
import {
  AI_ARRIVAL,
  BOUGHT_MODULES,
  BUILT_MODULES,
  CARGO_TERMINAL,
  CLASS_FEE_FACTOR,
  DEMAND,
  FUEL_RATIO_RANGE,
  HANDLING_RANGE,
  HANGAR,
  HOUR_MS,
  INSURANCE,
  MILESTONES,
  RAMP,
  REPAIR_LOAN,
  REFERENCE_HANDLING_USD,
} from "./fbo-constants";
import {
  airportSize,
  elasticity,
  emptyToday,
  fboQuote,
  fboSalePrice,
  fboValue,
  fuelPricing,
  hangarNight,
  levelsOf,
  moduleCost,
  moduleDays,
  moduleEffect,
  moduleUpkeep,
  movementsPerDay,
  newFboRecord,
  ownShopCovers,
  trafficHour,
  type FboRecord,
  type FboTransactionRecord,
  type TrafficKind,
} from "./fbo";
import {
  activeEvent,
  addActivity,
  decayActivity,
  demandFactor,
  demandIndex,
  eventCandidates,
  eventState,
  fuelEventFactor,
  rollDemandEvent,
  type DemandEventRecord,
} from "./demand";
import {
  CLAIMABLE_CAUSES,
  insurancePremium,
  insuranceRisk,
  repairClaim,
  repairLoanBill,
  repairLoanCheck,
  repairLoanPolicyCheck,
  repairLoanTerms,
  writeOffClaim,
  type Incident,
} from "./insurance";
import { milestoneList, type MilestoneRecord } from "./milestones";
import {
  AVERAGE_LOAD_SHARE,
  HIRED_PILOTS,
  addPilotPnl,
  firstMonthWage,
  legFuelBurnKg,
  legIncome,
  legLoadShare,
  legTimes,
  nextDutyDeparture,
  pilotName,
  pilotWage,
  ratingFor,
  type HiredPilotRecord,
} from "./hired-pilots";
import type { HiredPilot, PilotLeg, PilotRating, PilotsState } from "../../protocol/src/pilots";
import { runwaySuitability } from "./airports";
import { MIN_JOB_NM } from "./constants";
import { maxJobDistanceNm, payloadLimitKg } from "./rules";
import { companyClock, gameMonthIndex } from "./clock";
import {
  GAME_DAY_MS,
  DEFAULT_FLAG_MONTHS,
  GAME_MONTH_MS,
  LATE_FEE_MIN_USD,
  LATE_FEE_SHARE,
  LEASE_MONTHLY_SHARE,
  MISSED_PAYMENT_REPUTATION,
  REPOSSESS_AFTER_MISSES,
  SALE_SHARE,
  STARTER_AIRCRAFT_KEY,
} from "./company-constants";
import { fuelCost, fuelPrice, landingFee, type FuelPrice } from "./costs";
import {
  LENDERS,
  creditScore,
  lenderById,
  lenderOffer,
  monthInterest,
  originationFee,
  positiveMonths,
  quoteLoan,
  type CreditScore,
} from "./finance";
import {
  canBuy,
  canLease,
  flightWear,
  leaseMinTier,
  purchaseMinTier,
  registrationFor,
  repairCost,
  repairHours,
  tierName,
  type Selection,
  type WearResult,
} from "./fleet-rules";
import { greatCircleNm, round1, round2 } from "./geo";
import { reputationTier } from "./payout";
import { clampReputation } from "./rules";

/** Company fields the book reads and writes (the connector's record extends it). */
export interface CompanyCore {
  name: string;
  base: string;
  seed: number;
  cash: number;
  reputation: number;
  startingCash: number;
  /** Company clock, ms since founding. */
  gameMs: number;
  /** Last in-game month whose lease fees were billed. */
  monthBilled: number;
  defaultUntilGameMs: number | null;
  fleetCounter: number;
  loanCounter: number;
  selectedAircraftId: string | null;
  /** Operating P&L per in-game month (last 24). */
  pnl: PnlMonth[];
  ledgerCount: number;
  // ---- P5 ----
  /** Used market generation counter (0 = no market yet). */
  marketGeneration: number;
  marketRefreshedGameMs: number;
  /** Maintenance orders opened so far (order ids). */
  orderCounter: number;
  // ---- P5 part 2 ----
  /** FBOs acquired so far (FBO ids). */
  fboCounter: number;
  /** Last in-game day whose start was processed (demand roll, FBO day close); absent = now. */
  dayProcessed?: number | undefined;
  /** Demand activity per airport (decays daily). */
  activity: Record<string, number>;
  /** Airborne hours flown by the company's aircraft. */
  flightHours: number;
  deliveries: number;
  /** Consecutive deliveries landed A or better. */
  landingStreak: number;
  /** Used aircraft whose every known defect was repaired. */
  restorations: number;
  milestones: MilestoneRecord[];
  // ---- hired pilots (absent in older records = 0) ----
  /** Pilots hired so far (pilot ids). */
  pilotCounter?: number | undefined;
}

export interface BookAircraft {
  id: string;
  registration: string;
  typeKey: string;
  ownership: Ownership;
  status: AircraftStatus;
  location: string;
  hours: number;
  cycles: number;
  condition: number;
  purchasePrice: number;
  /** Wall clock, ms. */
  acquiredAt: number;
  acquiredGameMs: number;
  readyAtGameMs: number | null;
  loanId: string | null;
  // ---- P5 (normalised from P4 records by `normalizeAircraft`) ----
  /** Age when acquired, years (0 for new aircraft). */
  ageYears: number;
  /** Per-system condition; `condition` is always their weighted mean. */
  systems: SystemConditions;
  /** Known and hidden defects. */
  defects: Defect[];
  annual: { lastGameMs: number; lastHours: number };
  ferryPermit: FerryPermit | null;
  /** Queued and running maintenance orders, oldest first. */
  orders: MaintenanceOrder[];
  /** Defects created so far (defect ids). */
  defectCounter: number;
  // ---- P5 part 2 (normalised by `normalizeAircraft`) ----
  insurance: InsurancePolicy | null;
  /** Hard landings and crashes (insurance risk). */
  incidents: Incident[];
}

export interface InsurancePolicy {
  sinceGameMs: number;
  /** Last premium billed, dollars. */
  premium: number;
  claims: number;
  claimsPaid: number;
}

const P5_KEYS = [
  "ageYears",
  "systems",
  "defects",
  "annual",
  "ferryPermit",
  "orders",
  "defectCounter",
  "insurance",
  "incidents",
] as const;
/** A P4 (or P5) aircraft record: the P5 fields may be missing. */
export type BookAircraftInput = Omit<BookAircraft, (typeof P5_KEYS)[number]> & {
  [K in (typeof P5_KEYS)[number]]?: BookAircraft[K] | undefined;
};

/**
 * Bring a stored aircraft to the P5 shape. A P4 record maps its `condition` onto every
 * system (so the weighted mean is unchanged), has no defects, gets a current annual
 * inspection at the migration time and hours, and a P4 repair in progress becomes an
 * overhaul order (already paid) ending at its `readyAtGameMs`.
 */
export function normalizeAircraft(a: BookAircraftInput, gameMs: number): BookAircraft {
  const systems = a.systems ?? systemsFromCondition(a.condition);
  const orders =
    a.orders ??
    (a.status === "maintenance" && a.readyAtGameMs !== null
      ? [
          {
            id: `MO-${a.id}-p4`,
            aircraftId: a.id,
            kind: "overhaul" as const,
            defectIds: [],
            label: "Overhaul (P4 repair)",
            airport: a.location,
            shop: "maintenance" as const,
            cost: 0,
            hours: 0,
            startGameMs: Math.floor(gameMs),
            readyAtGameMs: a.readyAtGameMs,
          },
        ]
      : []);
  return {
    ...a,
    ageYears: a.ageYears ?? 0,
    systems,
    defects: a.defects ?? [],
    annual: a.annual ?? { lastGameMs: Math.floor(gameMs), lastHours: a.hours },
    ferryPermit: a.ferryPermit ?? null,
    orders,
    defectCounter: a.defectCounter ?? 0,
    insurance: a.insurance ?? null,
    incidents: a.incidents ?? [],
    condition: derivedCondition(systems),
  };
}

export interface BookLoan {
  id: string;
  lenderId: string;
  principal: number;
  apr: number;
  termMonths: number;
  payment: number;
  balance: number;
  collateral: Collateral;
  nextDueGameMs: number;
  missedCount: number;
  paymentsMade: number;
  status: LoanState["status"];
  takenAt: number;
  takenGameMs: number;
  /**
   * Absent = `bank`. `repair`: an insurer repair loan; `collateral` names the aircraft whose
   * repair it financed but is no lien (never repossessed; see `debitLoan`).
   */
  kind?: LoanKind | undefined;
  /** Repair loans: the maintenance order financed. */
  orderId?: string | undefined;
}

/** Insurer repair loans are `kind: "repair"`; every other loan is a bank loan. */
export function isRepairLoan(l: Pick<BookLoan, "kind">): boolean {
  return l.kind === "repair";
}

export type RepairKind = "overhaul" | "all" | "defect";

/** A repair about to be ordered (shared by the cash and the insurer-financed paths). */
interface RepairTarget {
  a: BookAircraft;
  kind: RepairKind;
  cost: number;
  hours: number;
  shop: Shop;
  defects: Defect[];
  label: string;
  memo: string;
  /** Incident claim the policy pays when the order is placed (0 uninsured / no incident). */
  claim: number;
}

export interface BookLedgerEntry {
  at: number;
  gameMs: number;
  category: LedgerCategory;
  amount: number;
  balance: number;
  refType: string | null;
  refId: string | null;
  memo: string | null;
}

export interface AircraftEventRecord {
  aircraftId: string;
  at: number;
  gameMs: number;
  kind: string;
  data: Record<string, unknown>;
}

export interface BookNotice {
  name: EventName;
  data: Record<string, unknown>;
}

export interface BookChanges {
  company: boolean;
  ledger: BookLedgerEntry[];
  aircraft: BookAircraft[];
  loans: BookLoan[];
  events: AircraftEventRecord[];
  notices: BookNotice[];
  /** Used listings changed (status "listed" = upsert; otherwise remove). */
  listings: ListingRecord[];
  // ---- P5 part 2 ----
  fbos: FboRecord[];
  fboTransactions: FboTransactionRecord[];
  demandEvents: DemandEventRecord[];
  /** The demand activity map changed (company.activity). */
  activity: boolean;
  milestones: MilestoneRecord[];
  // ---- hired pilots ----
  pilots: HiredPilotRecord[];
}

export interface Reason {
  code: string;
  message: string;
}
export type BookResult<T> =
  { ok: true; data: T } | { ok: false; code: string; message: string; reasons?: Reason[] };
const fail = (code: string, message: string, reasons?: Reason[]) => ({
  ok: false as const,
  code,
  message,
  ...(reasons ? { reasons } : {}),
});

/** Categories that are capital flows, not operating revenue/expense. */
export const CAPITAL_CATEGORIES: ReadonlySet<LedgerCategory> = new Set<LedgerCategory>([
  "loan_disbursement",
  "loan_payment",
  "purchase",
  "sale",
  // P5 part 2: FBO purchase, construction and module installs are capital.
  "fbo_purchase",
  "fbo_construction",
  // Insurer repair loans: principal in and out (interest and late fees are operating).
  "repair_loan_disbursement",
  "repair_loan_payment",
]);
const CAPITAL = CAPITAL_CATEGORIES;

/** Fuel at or below max(1 lb, 0.5 % of the fuel at block-out) means the tanks ran dry. */
export function tanksDryThresholdLb(fuelAtStartLb: number): number {
  return Math.max(TANKS_DRY_MIN_LB, TANKS_DRY_SHARE * Math.max(0, fuelAtStartLb));
}

const ACTIVE: ReadonlySet<AircraftStatus> = new Set<AircraftStatus>([
  "available",
  "in_flight",
  "maintenance",
  // Assigned to a hired pilot (simulated route): still in the fleet, not available.
  "hired",
]);

/** Why an aircraft cannot be used right now (status other than available). */
function busyMessage(a: Pick<BookAircraft, "registration" | "status">): string {
  return a.status === "hired"
    ? `${a.registration} is assigned to a hired pilot (simulated route): unassign the pilot first`
    : `${a.registration} is ${a.status}`;
}

export interface FlightSettlement {
  /** Fuel burned, kg (billed unless wet-leased). */
  fuelKg: number;
  /** Airport whose fuel price applies (the landing airport, else the origin). */
  fuelAirport: EconomyAirport | null;
  /** Airport landed and parked at (landing fee + new location); null = none. */
  landingAirport: EconomyAirport | null;
  blockMin: number;
  airborneMin: number;
  peakG: number | null;
  overspeedEvents: number;
  crashed: boolean;
  landings: number;
  refType: string;
  refId: string;
  memo: string;
  /** P5: the tanks ran dry in flight (fuel quantity reached ~0). */
  tanksDry?: boolean;
  /**
   * A hired pilot's simulated leg: never counts toward the player's flight hours, gets no
   * own-FBO arrival benefits, and its aircraft event is `pilot_leg`, not `flight`.
   */
  hired?: boolean;
}

export interface SettlementResult {
  costs: MissionCost[];
  wear: WearResult;
  condition: number;
  /** P5: defects found after this flight (new and escalated). */
  defects: Defect[];
  writtenOff: boolean;
}

export interface BookOptions<C extends CompanyCore> {
  company: C;
  fleet?: readonly BookAircraftInput[];
  loans?: readonly BookLoan[];
  /** Newest first. */
  recent?: readonly BookLedgerEntry[];
  airports: AirportLookup | null;
  now: () => number;
  /** P5 used listings (status "listed"). */
  market?: readonly ListingRecord[];
  /**
   * Where maintenance is available besides the player's own FBO maintenance shops
   * (default: large airports).
   */
  maintenance?: MaintenanceCapability;
  /** P5 part 2: FBOs (every status) and recent demand events. */
  fbos?: readonly FboRecord[];
  demandEvents?: readonly DemandEventRecord[];
  /** Hired pilots (every status). */
  pilots?: readonly HiredPilotRecord[];
}

export class CompanyBook<C extends CompanyCore = CompanyCore> {
  company: C;
  readonly fleet = new Map<string, BookAircraft>();
  readonly loans = new Map<string, BookLoan>();
  private recent: BookLedgerEntry[];
  private readonly airports: AirportLookup | null;
  private readonly now: () => number;
  private pending: BookChanges = emptyChanges();
  readonly listings = new Map<string, ListingRecord>();
  /** Large airports (or the injected capability) plus the player's own maintenance shops. */
  readonly maintenance: MaintenanceCapability;
  private readonly baseMaintenance: MaintenanceCapability;
  readonly fbos = new Map<string, FboRecord>();
  private events: DemandEventRecord[] = [];
  private candidateCache: { key: string; list: EconomyAirport[] } | null = null;

  constructor(options: BookOptions<C>) {
    const c = options.company;
    this.company = {
      ...c,
      marketGeneration: c.marketGeneration ?? 0,
      marketRefreshedGameMs: c.marketRefreshedGameMs ?? 0,
      orderCounter: c.orderCounter ?? 0,
      fboCounter: c.fboCounter ?? 0,
      dayProcessed: c.dayProcessed ?? Math.floor(Math.max(0, c.gameMs) / GAME_DAY_MS),
      activity: c.activity ?? {},
      flightHours: c.flightHours ?? 0,
      deliveries: c.deliveries ?? 0,
      landingStreak: c.landingStreak ?? 0,
      restorations: c.restorations ?? 0,
      milestones: c.milestones ?? [],
      pilotCounter: c.pilotCounter ?? 0,
    };
    for (const f of options.fbos ?? []) this.fbos.set(f.id, f);
    for (const p of options.pilots ?? []) this.pilots.set(p.id, p);
    this.events = [...(options.demandEvents ?? [])];
    for (const a of options.fleet ?? []) {
      this.fleet.set(a.id, normalizeAircraft(a, this.company.gameMs));
    }
    for (const l of options.loans ?? []) this.loans.set(l.id, { ...l });
    for (const l of options.market ?? []) if (l.status === "listed") this.listings.set(l.id, l);
    this.recent = [...(options.recent ?? [])].slice(0, 20);
    this.airports = options.airports;
    this.now = options.now;
    this.baseMaintenance = options.maintenance ?? largeAirportMaintenance(options.airports);
    this.maintenance = {
      isMaintenanceCapable: (icao) =>
        this.baseMaintenance.isMaintenanceCapable(icao) || this.ownShopLevel(icao) > 0,
    };
    // Imports are repaired, never trusted: a pilot assigned to an aircraft that is not marked
    // hired, or a second pilot on an aircraft another pilot already flies, is unassigned
    // (`stopped.code` "assignment_invalid"); the first pilot in hiring order keeps it.
    const claimed = new Set<string>();
    for (const p of this.activePilots()) {
      const as = p.assignment;
      if (!as) continue;
      const a = this.fleet.get(as.aircraftId);
      const why =
        !a || a.status !== "hired"
          ? `${a?.registration ?? as.aircraftId} is not marked as flown by a hired pilot`
          : claimed.has(a.id)
            ? `${a.registration} is already flown by another hired pilot`
            : null;
      if (why) {
        this.touchPilot({
          ...p,
          assignment: null,
          stopped: {
            code: "assignment_invalid",
            message: `Assignment dropped when loading: ${why}`,
            gameMs: Math.floor(this.company.gameMs),
          },
        });
        continue;
      }
      claimed.add(as.aircraftId);
    }
    // An aircraft marked hired without a pilot assigned to it (an inconsistent import) is
    // available again.
    const assigned = new Set(
      this.activePilots().flatMap((p) => (p.assignment ? [p.assignment.aircraftId] : [])),
    );
    for (const a of this.fleet.values()) {
      if (a.status === "hired" && !assigned.has(a.id)) {
        this.touchAircraft({ ...a, status: "available" });
      }
    }
  }

  /** Changes since the last drain (to persist), then reset. */
  drain(): BookChanges {
    this.checkMilestones();
    const out = this.pending;
    this.pending = emptyChanges();
    return out;
  }

  get hasPending(): boolean {
    const p = this.pending;
    return (
      p.company ||
      p.ledger.length > 0 ||
      p.aircraft.length > 0 ||
      p.loans.length > 0 ||
      p.events.length > 0 ||
      p.notices.length > 0 ||
      p.listings.length > 0 ||
      p.fbos.length > 0 ||
      p.fboTransactions.length > 0 ||
      p.demandEvents.length > 0 ||
      p.activity ||
      p.milestones.length > 0 ||
      p.pilots.length > 0
    );
  }

  // ---- ledger ----

  /** The only way cash changes. Amounts are cents-rounded. */
  post(
    category: LedgerCategory,
    amount: number,
    refType: string | null = null,
    refId: string | null = null,
    memo: string | null = null,
  ): BookLedgerEntry {
    const value = round2(amount);
    const cash = round2(this.company.cash + value);
    const entry: BookLedgerEntry = {
      at: this.now(),
      gameMs: Math.floor(this.company.gameMs),
      category,
      amount: value,
      balance: cash,
      refType,
      refId,
      memo,
    };
    this.company = { ...this.company, cash, ledgerCount: this.company.ledgerCount + 1 };
    if (!CAPITAL.has(category) && value !== 0) {
      const month = gameMonthIndex(entry.gameMs);
      const pnl = [...this.company.pnl];
      const i = pnl.findIndex((m) => m.month === month);
      const row = i >= 0 && pnl[i] ? { ...pnl[i] } : { month, revenue: 0, expense: 0, net: 0 };
      if (value > 0) row.revenue = round2(row.revenue + value);
      else row.expense = round2(row.expense - value);
      row.net = round2(row.revenue - row.expense);
      if (i >= 0) pnl[i] = row;
      else pnl.push(row);
      pnl.sort((a, b) => a.month - b.month);
      this.company = { ...this.company, pnl: pnl.slice(-24) };
    }
    this.recent = [entry, ...this.recent].slice(0, 20);
    this.pending.ledger.push(entry);
    this.pending.company = true;
    return entry;
  }

  adjustReputation(delta: number): number {
    const reputation = clampReputation(this.company.reputation + delta);
    this.company = { ...this.company, reputation };
    this.pending.company = true;
    return reputation;
  }

  setCompany(company: C): void {
    this.company = company;
    this.pending.company = true;
  }

  // ---- fleet basics ----

  activeFleet(): BookAircraft[] {
    return [...this.fleet.values()]
      .filter((a) => ACTIVE.has(a.status))
      .sort((a, b) => a.acquiredGameMs - b.acquiredGameMs || (a.id < b.id ? -1 : 1));
  }

  aircraft(id: string | null | undefined): BookAircraft | null {
    if (!id) return null;
    const a = this.fleet.get(id);
    return a && ACTIVE.has(a.status) ? a : null;
  }

  /** A new company (or a P3 company without a fleet) gets one owned C208B at the base. */
  ensureStarter(): BookAircraft | null {
    if (this.fleet.size > 0 || this.company.fleetCounter > 0) return null;
    const type = aircraftTypeByKey(STARTER_AIRCRAFT_KEY);
    if (!type) return null;
    const a = this.addAircraft(type, "owned", this.company.base, 0);
    this.event(a.id, "starter", { typeKey: type.key, location: a.location });
    return a;
  }

  private addAircraft(
    type: AircraftType,
    ownership: Ownership,
    location: string,
    price: number,
    used?: { ageYears: number; hours: number; cycles: number; systems: SystemConditions },
  ): BookAircraft {
    const n = this.company.fleetCounter + 1;
    const taken = new Set([...this.fleet.values()].map((a) => a.registration));
    const systems = used ? { ...used.systems } : systemsFromCondition(100);
    const a: BookAircraft = {
      id: `AC-${n}`,
      registration: registrationFor(this.company.seed, n, taken),
      typeKey: type.key,
      ownership,
      status: "available",
      location,
      hours: used?.hours ?? 0,
      cycles: used?.cycles ?? 0,
      condition: derivedCondition(systems),
      purchasePrice: round2(price),
      acquiredAt: this.now(),
      acquiredGameMs: Math.floor(this.company.gameMs),
      readyAtGameMs: null,
      loanId: null,
      ageYears: used?.ageYears ?? 0,
      systems,
      defects: [],
      // Delivered with a current annual inspection.
      annual: { lastGameMs: Math.floor(this.company.gameMs), lastHours: used?.hours ?? 0 },
      ferryPermit: null,
      orders: [],
      defectCounter: 0,
      insurance: null,
      incidents: [],
    };
    this.company = { ...this.company, fleetCounter: n };
    this.fleet.set(a.id, a);
    this.touchAircraft(a);
    return a;
  }

  private touchAircraft(input: BookAircraft): void {
    // The overall condition is always the weighted mean of the systems.
    const a = { ...input, condition: derivedCondition(input.systems) };
    this.fleet.set(a.id, a);
    const i = this.pending.aircraft.findIndex((x) => x.id === a.id);
    if (i >= 0) this.pending.aircraft[i] = a;
    else this.pending.aircraft.push(a);
    this.pending.company = true;
  }

  private touchLoan(l: BookLoan): void {
    this.loans.set(l.id, l);
    const i = this.pending.loans.findIndex((x) => x.id === l.id);
    if (i >= 0) this.pending.loans[i] = l;
    else this.pending.loans.push(l);
    this.pending.company = true;
  }

  private event(aircraftId: string, kind: string, data: Record<string, unknown>): void {
    this.pending.events.push({
      aircraftId,
      at: this.now(),
      gameMs: Math.floor(this.company.gameMs),
      kind,
      data,
    });
  }

  private notice(name: EventName, data: Record<string, unknown>): void {
    this.pending.notices.push({ name, data });
  }

  /**
   * Patch an aircraft (tests and tools). A patch that sets `condition` without `systems`
   * maps the condition onto every system.
   */
  updateAircraft(id: string, patch: Partial<BookAircraft>): BookAircraft | null {
    const a = this.fleet.get(id);
    if (!a) return null;
    const next = { ...a, ...patch };
    if (patch.condition !== undefined && patch.systems === undefined) {
      next.systems = systemsFromCondition(patch.condition);
    }
    this.touchAircraft(next);
    return this.fleet.get(id) ?? next;
  }

  // ---- totals ----

  activeLoans(): BookLoan[] {
    return [...this.loans.values()].filter((l) => l.status === "active");
  }

  debt(): number {
    return round2(this.activeLoans().reduce((s, l) => s + l.balance, 0));
  }

  /** Age now, years: age at acquisition + in-game time since (12 × 30-day months a year). */
  ageNow(a: BookAircraft): number {
    return a.ageYears + Math.max(0, this.company.gameMs - a.acquiredGameMs) / GAME_YEAR_MS;
  }

  /** Market value of an owned aircraft: the used-market formula (P4 value for a new one). */
  aircraftValue(a: BookAircraft): number {
    if (a.ownership !== "owned") return 0;
    const type = aircraftTypeByKey(a.typeKey);
    return type
      ? usedValue(type, {
          ageYears: this.ageNow(a),
          hours: a.hours,
          condition: a.condition,
          defects: a.defects,
        }).value
      : 0;
  }

  fleetValue(): number {
    return round2(this.activeFleet().reduce((s, a) => s + this.aircraftValue(a), 0));
  }

  /** Σ book value of the FBOs owned (active or building). */
  fboTotalValue(): number {
    return round2(
      [...this.fbos.values()]
        .filter((f) => f.status === "active" || f.status === "building")
        .reduce((s, f) => s + fboValue(f.invested), 0),
    );
  }

  netWorth(): number {
    return round2(this.company.cash + this.fleetValue() + this.fboTotalValue() - this.debt());
  }

  defaulted(): boolean {
    const until = this.company.defaultUntilGameMs;
    return until !== null && until > this.company.gameMs;
  }

  credit(): CreditScore {
    return creditScore({
      reputation: this.company.reputation,
      positiveMonths: positiveMonths(this.company.pnl, gameMonthIndex(this.company.gameMs)),
      debt: this.debt(),
      assets: Math.max(0, this.company.cash) + this.fleetValue() + this.fboTotalValue(),
      defaulted: this.defaulted(),
    });
  }

  // ---- company clock ----

  /** Move the company clock forward, processing month boundaries, loans and repairs in order. */
  advance(deltaMs: number): void {
    if (!(deltaMs > 0)) return;
    const target = Math.round(this.company.gameMs + deltaMs);
    for (let guard = 0; guard < 100_000; guard++) {
      const next = this.nextDue();
      if (next === null || next > target) break;
      this.company = { ...this.company, gameMs: Math.max(this.company.gameMs, next) };
      this.processDue(this.company.gameMs);
    }
    this.company = { ...this.company, gameMs: target };
  }

  private nextDue(): number | null {
    let next = (this.company.monthBilled + 1) * GAME_MONTH_MS;
    for (const l of this.activeLoans()) next = Math.min(next, l.nextDueGameMs);
    for (const a of this.activeFleet()) {
      for (const o of a.orders) next = Math.min(next, o.readyAtGameMs);
    }
    for (const l of this.listings.values()) {
      if (l.inspection.status === "pending" && l.inspection.readyAtGameMs !== undefined)
        next = Math.min(next, l.inspection.readyAtGameMs);
    }
    if (this.company.marketGeneration > 0) {
      next = Math.min(next, this.company.marketRefreshedGameMs + MARKET_REFRESH_MS);
    }
    // Hired pilots: the next departure or arrival of every assigned pilot.
    for (const p of this.activePilots()) {
      const as = p.assignment;
      if (as) next = Math.min(next, as.leg ? as.leg.arriveGameMs : as.nextDepartureGameMs);
    }
    // P5 part 2: day boundaries (demand, FBO day close), FBO hours, constructions, modules.
    next = Math.min(next, (this.dayProcessed + 1) * GAME_DAY_MS);
    for (const f of this.fbos.values()) {
      if (f.status === "building" && f.readyAtGameMs !== null) {
        next = Math.min(next, f.readyAtGameMs);
      }
      if (f.status !== "active") continue;
      next = Math.min(next, (f.nextHour + 1) * HOUR_MS);
      for (const k of FBO_MODULE_KINDS) {
        const pending = f.modules[k].pending;
        if (pending) next = Math.min(next, pending.readyAtGameMs);
      }
    }
    return next;
  }

  private processDue(t: number): void {
    // P5 part 2: FBO constructions and module installs, traffic hours, day boundaries.
    this.processFbos(t);
    this.processDays(t);
    // Hired pilots: legs that end and depart now (simulated).
    this.processPilots(t);
    // Maintenance orders that are done (in completion order per aircraft).
    for (const a of this.activeFleet()) {
      if (a.orders.some((o) => o.readyAtGameMs <= t)) this.completeOrders(a, t);
    }
    // Pre-purchase inspections that are done.
    for (const l of [...this.listings.values()]) {
      if (
        l.inspection.status === "pending" &&
        l.inspection.readyAtGameMs !== undefined &&
        l.inspection.readyAtGameMs <= t
      ) {
        const done = completeInspection(l, t);
        this.touchListing(done);
        this.notice("inspection.completed", {
          kind: "pre_purchase",
          listingId: l.id,
          found: done.inspection.found ?? 0,
          defects: done.defects
            .filter((d) => d.foundGameMs === Math.floor(t))
            .map((d) => ({ system: d.system, severity: d.severity, title: d.title })),
        });
      }
    }
    // Scheduled market refresh.
    if (
      this.company.marketGeneration > 0 &&
      this.company.marketRefreshedGameMs + MARKET_REFRESH_MS <= t
    ) {
      this.refreshMarket();
    }
    // Month boundaries: lease fees.
    const month = gameMonthIndex(t);
    while (this.company.monthBilled < month) {
      this.company = { ...this.company, monthBilled: this.company.monthBilled + 1 };
      this.pending.company = true;
      for (const a of this.activeFleet()) {
        if (a.ownership === "owned") continue;
        const type = aircraftTypeByKey(a.typeKey);
        if (!type) continue;
        this.post(
          "lease",
          -leaseMonthlyFee(type),
          "aircraft",
          a.id,
          `${a.registration} ${a.ownership === "dry_lease" ? "dry" : "wet"} lease, month ${this.company.monthBilled + 1}`,
        );
      }
      this.monthlyFbosAndInsurance();
      this.monthlyPilots();
    }
    // Loan auto-debits.
    for (const l of this.activeLoans()) {
      // Re-read: a repossession earlier in this loop may have called a repair loan.
      const loan = this.loans.get(l.id);
      if (loan && loan.status === "active" && loan.nextDueGameMs <= t) this.debitLoan(loan);
    }
  }

  private debitLoan(loan: BookLoan): void {
    const name = loanLenderName(loan);
    const repair = isRepairLoan(loan);
    const interest = monthInterest(loan.balance, loan.apr);
    const due = round2(Math.min(loan.payment, loan.balance + interest));
    const remaining = loan.termMonths - loan.paymentsMade;
    const amount = remaining <= 1 ? round2(loan.balance + interest) : due;
    const next = loan.nextDueGameMs + GAME_MONTH_MS;
    if (this.company.cash >= amount) {
      const principal = round2(amount - interest);
      if (interest > 0)
        this.post(
          "interest",
          -interest,
          "loan",
          loan.id,
          `${name} ${repair ? "repair loan " : ""}interest`,
        );
      this.post(
        repair ? "repair_loan_payment" : "loan_payment",
        -principal,
        "loan",
        loan.id,
        `${name} ${repair ? "repair loan " : ""}principal`,
      );
      const balance = round2(loan.balance - principal);
      const paid: BookLoan = {
        ...loan,
        balance: balance < 0.005 ? 0 : balance,
        paymentsMade: loan.paymentsMade + 1,
        missedCount: 0,
        nextDueGameMs: next,
        status: balance < 0.005 ? "paid_off" : "active",
      };
      this.touchLoan(paid);
      if (paid.status === "paid_off" && !repair) this.releaseCollateral(paid);
      this.notice("loan.payment", {
        loanId: loan.id,
        amount,
        interest,
        principal,
        balance: paid.balance,
      });
      return;
    }
    // Missed: late fee (cash may go negative), −5 reputation, the month's interest is
    // capitalised and the schedule moves one month.
    const fee = round2(Math.max(LATE_FEE_MIN_USD, amount * LATE_FEE_SHARE));
    this.post("late_fee", -fee, "loan", loan.id, `${name} ${repair ? "repair loan " : ""}late fee`);
    this.adjustReputation(MISSED_PAYMENT_REPUTATION);
    const missed: BookLoan = {
      ...loan,
      balance: round2(loan.balance + interest),
      termMonths: loan.termMonths + 1,
      missedCount: loan.missedCount + 1,
      nextDueGameMs: next,
    };
    this.touchLoan(missed);
    this.notice("loan.missed", {
      loanId: loan.id,
      amount,
      lateFee: fee,
      missedCount: missed.missedCount,
      ...(repair ? { kind: "repair" } : {}),
    });
    if (repair) {
      // Repossession-free: the third miss cancels the policy and moves the balance to cash.
      if (missed.missedCount >= REPAIR_LOAN.cancelAfterMisses) {
        this.callRepairLoan(missed, "missed_payments");
      }
      return;
    }
    if (missed.missedCount >= REPOSSESS_AFTER_MISSES) this.repossess(missed);
  }

  /** The active insurer repair loan on an aircraft, if any. */
  openRepairLoan(aircraftId: string): BookLoan | null {
    for (const l of this.loans.values()) {
      if (l.status === "active" && isRepairLoan(l) && l.collateral.id === aircraftId) return l;
    }
    return null;
  }

  /**
   * Call an insurer repair loan: the outstanding balance is debited from cash at once (cash
   * may go negative, like a late fee) and the loan closes as `called`. After three missed
   * payments the policy is cancelled as well. Never repossesses, never sets the default flag.
   */
  private callRepairLoan(
    loan: BookLoan,
    reason: "missed_payments" | "aircraft_repossessed" | "aircraft_written_off",
  ): void {
    const balance = loan.balance;
    const a = this.fleet.get(loan.collateral.id);
    const reg = a?.registration ?? loan.collateral.id;
    const memo =
      reason === "missed_payments"
        ? `Insurer called the ${reg} repair loan after ${REPAIR_LOAN.cancelAfterMisses} missed payments: balance moved to cash`
        : reason === "aircraft_repossessed"
          ? `Insurer called the ${reg} repair loan: the aircraft was repossessed`
          : `Balance of the ${reg} repair loan due after the write-off`;
    if (balance > 0) this.post("repair_loan_payment", -balance, "loan", loan.id, memo);
    this.touchLoan({ ...loan, balance: 0, status: "called" });
    // Every call is announced with the amount moved to cash (third miss, repossession,
    // write-off remainder).
    this.notice("loan.called", {
      loanId: loan.id,
      kind: "repair",
      aircraftId: loan.collateral.id,
      registration: reg,
      reason,
      balanceMovedToCash: balance,
    });
    // A repossessed or written-off hull has left the fleet (no more premiums); only the
    // missed-payment path cancels a policy on an aircraft the company keeps.
    if (reason === "missed_payments" && a?.insurance) {
      this.touchAircraft({ ...(this.fleet.get(a.id) ?? a), insurance: null });
      this.event(a.id, "insurance.cancelled", { by: "insurer", reason, loanId: loan.id });
      this.notice("insurance.cancelled", {
        aircraftId: a.id,
        registration: a.registration,
        reason,
        loanId: loan.id,
        balanceMovedToCash: balance,
      });
    }
  }

  private repossess(loan: BookLoan): void {
    const defaulted: BookLoan = { ...loan, status: "defaulted" };
    this.touchLoan(defaulted);
    this.company = {
      ...this.company,
      defaultUntilGameMs: Math.floor(this.company.gameMs + DEFAULT_FLAG_MONTHS * GAME_MONTH_MS),
    };
    if (loan.collateral.type === "aircraft") {
      const a = this.fleet.get(loan.collateral.id);
      if (a) {
        this.touchAircraft({ ...a, status: "repossessed", loanId: null, readyAtGameMs: null });
        this.event(a.id, "repossessed", { loanId: loan.id, balance: loan.balance });
        // The insurer's repair loan on it has no lien and is not written off: it is called.
        const repairLoan = this.openRepairLoan(a.id);
        if (repairLoan) this.callRepairLoan(repairLoan, "aircraft_repossessed");
        // A hired pilot flying it loses the aircraft now, not at its next departure.
        const pilot = this.pilotOf(a.id);
        if (pilot) {
          this.stopRoute(
            pilot,
            "aircraft_repossessed",
            `${a.registration} was repossessed by the lender`,
          );
        }
        if (this.company.selectedAircraftId === a.id) {
          this.company = { ...this.company, selectedAircraftId: null };
        }
      }
    } else {
      const f = this.fbos.get(loan.collateral.id);
      if (f) this.touchFbo({ ...f, status: "repossessed", loanId: null });
    }
    this.notice("aircraft.repossessed", {
      loanId: loan.id,
      collateral: loan.collateral,
      balanceWrittenOff: loan.balance,
    });
  }

  private releaseCollateral(loan: BookLoan): void {
    if (loan.collateral.type === "fbo") {
      const f = this.fbos.get(loan.collateral.id);
      if (f && f.loanId === loan.id) this.touchFbo({ ...f, loanId: null });
      return;
    }
    const a = this.fleet.get(loan.collateral.id);
    if (a && a.loanId === loan.id) this.touchAircraft({ ...a, loanId: null });
  }

  // ---- fleet operations ----

  private deliveryAirport(airport: string | undefined): BookResult<string> {
    const wanted =
      airport?.toUpperCase() ??
      this.aircraft(this.company.selectedAircraftId)?.location ??
      this.company.base;
    if (this.airports && !this.airports.get(wanted)) {
      return fail("unknown_airport", `Unknown airport ${wanted}`);
    }
    return { ok: true, data: wanted };
  }

  buy(args: {
    typeKey: string;
    airport?: string;
    financing?: { lenderId: string; termMonths: number; principal: number };
  }): BookResult<{ aircraft: BookAircraft; loan: BookLoan | null }> {
    const type = aircraftTypeByKey(args.typeKey);
    if (!type) return fail("unknown_type", `Unknown aircraft type ${args.typeKey}`);
    if (!canBuy(type, this.company.reputation)) {
      return fail(
        "reputation_gate",
        `Buying a ${type.name} needs reputation tier ${purchaseMinTier(type)} (${tierName(purchaseMinTier(type))})`,
      );
    }
    const where = this.deliveryAirport(args.airport);
    if (!where.ok) return where;
    const price = type.priceUsd;
    let quote: LoanQuote | null = null;
    if (args.financing) {
      const lender = lenderById(args.financing.lenderId);
      if (!lender) return fail("unknown_lender", `Unknown lender ${args.financing.lenderId}`);
      quote = this.quoteWith(lender.id, args.financing.principal, args.financing.termMonths, price);
      if (!quote.ok) return fail(quote.code ?? "loan_declined", quote.message ?? "Declined");
    }
    const principal = quote ? quote.principal : 0;
    const fee = quote ? quote.originationFee : 0;
    const needed = round2(price - principal + fee);
    if (this.company.cash < needed) {
      return fail(
        "insufficient_cash",
        `Needs $${needed.toLocaleString("en-US")} in cash (price − loan + 1 % fee)`,
      );
    }
    const a = this.addAircraft(type, "owned", where.data, price);
    this.post("purchase", -price, "aircraft", a.id, `Bought ${type.name} ${a.registration}`);
    this.event(a.id, "purchased", { price, location: a.location });
    let loan: BookLoan | null = null;
    if (quote) {
      loan = this.openLoan(quote, { type: "aircraft", id: a.id });
    }
    return { ok: true, data: { aircraft: this.fleet.get(a.id) ?? a, loan } };
  }

  sell(
    aircraftId: string,
  ): BookResult<{ price: number; loanPaid: number; repairLoanPaid?: number }> {
    const a = this.aircraft(aircraftId);
    if (!a) return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
    if (a.ownership !== "owned") return fail("not_owned", "Leased aircraft are returned, not sold");
    if (a.status !== "available") return fail("aircraft_busy", busyMessage(a));
    const type = aircraftTypeByKey(a.typeKey);
    if (!type) return fail("unknown_type", a.typeKey);
    // Resale uses the used-market value (P4 value for a new airframe) × 90 %.
    const price = round2(this.aircraftValue(a) * SALE_SHARE);
    const loan = a.loanId ? this.loans.get(a.loanId) : undefined;
    const owed = loan && loan.status === "active" ? loan.balance : 0;
    // An insurer repair loan on it is settled from the proceeds as well.
    const repairLoan = this.openRepairLoan(a.id);
    const repairOwed = repairLoan ? repairLoan.balance : 0;
    if (round2(owed + repairOwed) > price) {
      return fail(
        "underwater",
        repairOwed > 0
          ? `The sale ($${price.toLocaleString("en-US")}) does not cover the loan balances ($${owed.toLocaleString("en-US")} bank + $${repairOwed.toLocaleString("en-US")} insurer repair loan)`
          : `The sale ($${price.toLocaleString("en-US")}) does not cover the loan balance ($${owed.toLocaleString("en-US")})`,
      );
    }
    this.post("sale", price, "aircraft", a.id, `Sold ${type.name} ${a.registration}`);
    if (loan && owed > 0) {
      this.post(
        "loan_payment",
        -owed,
        "loan",
        loan.id,
        `Payoff from the sale of ${a.registration}`,
      );
      this.touchLoan({ ...loan, balance: 0, status: "paid_off" });
    }
    if (repairLoan && repairOwed > 0) {
      this.post(
        "repair_loan_payment",
        -repairOwed,
        "loan",
        repairLoan.id,
        `Repair loan payoff from the sale of ${a.registration}`,
      );
    }
    if (repairLoan) this.touchLoan({ ...repairLoan, balance: 0, status: "paid_off" });
    this.touchAircraft({ ...a, status: "sold", loanId: null });
    this.event(a.id, "sold", {
      price,
      loanPaid: owed,
      ...(repairLoan ? { repairLoanPaid: repairOwed } : {}),
    });
    if (this.company.selectedAircraftId === a.id) {
      this.company = { ...this.company, selectedAircraftId: null };
    }
    return {
      ok: true,
      data: { price, loanPaid: owed, ...(repairLoan ? { repairLoanPaid: repairOwed } : {}) },
    };
  }

  lease(args: {
    typeKey: string;
    kind: "dry" | "wet";
    airport?: string;
  }): BookResult<BookAircraft> {
    const type = aircraftTypeByKey(args.typeKey);
    if (!type) return fail("unknown_type", `Unknown aircraft type ${args.typeKey}`);
    if (!canLease(type, this.company.reputation)) {
      return fail(
        "reputation_gate",
        `Leasing a ${type.name} needs reputation tier ${leaseMinTier(type)} (${tierName(leaseMinTier(type))})`,
      );
    }
    const where = this.deliveryAirport(args.airport);
    if (!where.ok) return where;
    const fee = leaseMonthlyFee(type);
    if (this.company.cash < fee) {
      return fail(
        "insufficient_cash",
        `The first month's lease fee is $${fee.toLocaleString("en-US")}`,
      );
    }
    const a = this.addAircraft(
      type,
      args.kind === "dry" ? "dry_lease" : "wet_lease",
      where.data,
      0,
    );
    this.post("lease", -fee, "aircraft", a.id, `${a.registration} ${args.kind} lease, first month`);
    this.event(a.id, "leased", { kind: args.kind, monthlyFee: fee, location: a.location });
    return { ok: true, data: this.fleet.get(a.id) ?? a };
  }

  returnLease(aircraftId: string): BookResult<{ charge: number }> {
    const a = this.aircraft(aircraftId);
    if (!a) return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
    if (a.ownership === "owned") return fail("not_leased", "Owned aircraft are sold, not returned");
    if (a.status !== "available") return fail("aircraft_busy", busyMessage(a));
    const type = aircraftTypeByKey(a.typeKey);
    const charge = type ? repairCost(type, a.condition) : 0;
    if (charge > 0 && this.company.cash < charge) {
      return fail(
        "insufficient_cash",
        `Returning needs $${charge.toLocaleString("en-US")} for wear`,
      );
    }
    if (charge > 0)
      this.post("repair", -charge, "aircraft", a.id, `${a.registration} return condition`);
    this.touchAircraft({ ...a, status: "returned" });
    this.event(a.id, "returned", { charge });
    if (this.company.selectedAircraftId === a.id) {
      this.company = { ...this.company, selectedAircraftId: null };
    }
    return { ok: true, data: { charge } };
  }

  repair(aircraftId: string): BookResult<{ cost: number; hours: number; readyAtGameMs: number }> {
    const t = this.repairTarget(aircraftId, "overhaul");
    if (!t.ok) return t;
    const cash = this.repairCashCheck(t.data, 0);
    if (!cash.ok) return cash;
    const order = this.placeRepair(t.data);
    return {
      ok: true,
      data: { cost: t.data.cost, hours: t.data.hours, readyAtGameMs: order.readyAtGameMs },
    };
  }

  /**
   * What a repair would cost and do, with the same refusals as the cash commands: the wear
   * overhaul needs the aircraft available; defect repairs queue behind running orders.
   */
  private repairTarget(
    aircraftId: string,
    kind: RepairKind,
    defectId?: string,
  ): BookResult<RepairTarget> {
    if (kind === "overhaul") {
      const a = this.aircraft(aircraftId);
      if (!a) return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
      if (a.status !== "available") return fail("aircraft_busy", busyMessage(a));
      if (a.condition >= 100) return fail("no_wear", `${a.registration} needs no repair`);
      const type = aircraftTypeByKey(a.typeKey);
      if (!type) return fail("unknown_type", a.typeKey);
      const wear = round2(100 - a.condition);
      return {
        ok: true,
        data: {
          a,
          kind,
          cost: repairCost(type, a.condition),
          hours: repairHours(a.condition),
          shop: "maintenance",
          defects: [],
          label: `Overhaul (${wear} % wear)`,
          memo: `${a.registration} repair (${wear} % wear)`,
          claim: 0,
        },
      };
    }
    const w = this.workable(aircraftId);
    if (!w.ok) return w;
    const a = w.data;
    let defects: Defect[];
    if (kind === "defect") {
      const d = a.defects.find((x) => x.id === defectId && !x.hidden);
      if (!d) return fail("unknown_defect", `No known defect ${defectId} on ${a.registration}`);
      if (this.queued(a).has(d.id)) return fail("already_queued", `${d.title} is already queued`);
      defects = [d];
    } else {
      const queued = this.queued(a);
      defects = a.defects.filter((d) => !d.hidden && !queued.has(d.id));
      if (defects.length === 0) return fail("no_defects", `${a.registration} has no open defects`);
    }
    const q = this.repairQuoteFor(a, defects);
    const one = defects.length === 1 ? defects[0] : undefined;
    return {
      ok: true,
      data: {
        a,
        kind,
        cost: q.cost,
        hours: q.hours,
        shop: q.shop,
        defects,
        label: one ? one.title : `${defects.length} defects`,
        memo:
          kind === "defect" && one
            ? `${a.registration} repair: ${one.title}`
            : `${a.registration} repair of ${defects.length} defect(s)`,
        claim: a.insurance ? this.incidentClaim(defects, q.shop).claim : 0,
      },
    };
  }

  /** Cash must cover the gross cost (less what the insurer lends); the claim comes after. */
  private repairCashCheck(t: RepairTarget, financed: number): BookResult<null> {
    // Financed by the insurer: its claim and its loan are booked before the shop bill in the
    // same call, so only the rest of the bill (cost − claim − principal) needs cash. A cash
    // repair needs the gross cost (the claim comes after, as in P5 part 2).
    const needed = financed > 0 ? round2(t.cost - t.claim - financed) : t.cost;
    if (this.company.cash < needed) {
      const what = t.kind === "all" ? "The repairs cost" : "The repair costs";
      return fail(
        "insufficient_cash",
        financed > 0
          ? `${what} $${t.cost.toLocaleString("en-US")}: needs $${needed.toLocaleString("en-US")} in cash besides the incident claim and the repair loan`
          : `${what} $${t.cost.toLocaleString("en-US")}`,
      );
    }
    return { ok: true, data: null };
  }

  /**
   * Book the repair (and its incident claim) and open the maintenance order. `claimFirst`
   * (insurer-financed): the claim is booked before the shop bill so the running balance
   * never dips below the cash the company pays itself.
   */
  private placeRepair(t: RepairTarget, claimFirst = false): MaintenanceOrder {
    const a = t.a;
    const claim = t.kind !== "overhaul";
    if (claim && claimFirst) this.claimRepair(a.id, t.defects, t.shop);
    this.post("repair", -t.cost, "aircraft", a.id, t.memo);
    if (claim && !claimFirst) this.claimRepair(a.id, t.defects, t.shop);
    return this.openOrder(this.fleet.get(a.id) ?? a, {
      kind: t.kind === "overhaul" ? "overhaul" : "defect",
      defectIds: t.defects.map((d) => d.id),
      label: t.label,
      shop: t.shop,
      cost: t.cost,
      hours: t.hours,
    });
  }

  /**
   * Insurer repair loan (plan §7.4): order the repair and let the insurer finance up to its
   * bill (cost − the incident claim it pays). Fixed APR, 6–24 months, no fee; auto-debited
   * on the month boundary like a bank loan; never repossesses (see `debitLoan`).
   */
  repairLoan(args: {
    aircraftId: string;
    repair: RepairKind;
    defectId?: string | undefined;
    principal: number;
    termMonths: number;
  }): BookResult<{ loan: BookLoan; order: MaintenanceOrder; bill: number; claim: number }> {
    const a0 = this.aircraft(args.aircraftId);
    if (!a0) return fail("unknown_aircraft", `No aircraft ${args.aircraftId} in the fleet`);
    // Aircraft and policy rules first (owned, not hired/flying, insured, one open loan),
    // then what the repair itself refuses, then the amounts against its bill.
    const policy = {
      ownership: a0.ownership,
      status: a0.status,
      insured: a0.insurance !== null,
      openRepairLoan: this.openRepairLoan(a0.id) !== null,
    };
    const pre = repairLoanPolicyCheck(policy);
    if (!pre.ok) return fail(pre.code, `${a0.registration}: ${pre.message}`);
    const t = this.repairTarget(a0.id, args.repair, args.defectId);
    if (!t.ok) return t;
    const bill = repairLoanBill(t.data.cost, t.data.claim);
    const check = repairLoanCheck({
      ...policy,
      bill,
      principal: args.principal,
      termMonths: args.termMonths,
    });
    if (!check.ok) return fail(check.code, `${a0.registration}: ${check.message}`);
    const principal = round2(args.principal);
    const cash = this.repairCashCheck(t.data, principal);
    if (!cash.ok) return cash;
    const terms = repairLoanTerms(principal, args.termMonths);
    const n = this.company.loanCounter + 1;
    this.company = { ...this.company, loanCounter: n };
    const id = `LN-${n}`;
    // The insurer pays the shop: the disbursement first, so the running balance never dips.
    this.post(
      "repair_loan_disbursement",
      principal,
      "loan",
      id,
      `${REPAIR_LOAN.lenderName} repair loan for ${a0.registration}`,
    );
    const order = this.placeRepair(t.data, true);
    const loan: BookLoan = {
      id,
      lenderId: REPAIR_LOAN.lenderId,
      principal,
      apr: terms.apr,
      termMonths: args.termMonths,
      payment: terms.payment,
      balance: principal,
      collateral: { type: "aircraft", id: a0.id },
      nextDueGameMs: Math.floor(this.company.gameMs + GAME_MONTH_MS),
      missedCount: 0,
      paymentsMade: 0,
      status: "active",
      takenAt: this.now(),
      takenGameMs: Math.floor(this.company.gameMs),
      kind: "repair",
      orderId: order.id,
    };
    this.touchLoan(loan);
    this.event(a0.id, "repair_loan", { loanId: id, principal, order: order.id, bill });
    return { ok: true, data: { loan, order, bill, claim: t.data.claim } };
  }

  select(aircraftId: string | null): BookResult<{ aircraftId: string | null }> {
    if (aircraftId !== null && !this.aircraft(aircraftId)) {
      return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
    }
    this.company = { ...this.company, selectedAircraftId: aircraftId };
    this.pending.company = true;
    return { ok: true, data: { aircraftId } };
  }

  /** Mark the aircraft flying a mission (or back available). */
  setFlying(aircraftId: string, flying: boolean): void {
    const a = this.aircraft(aircraftId);
    if (!a) return;
    if (flying && a.status === "available") this.touchAircraft({ ...a, status: "in_flight" });
    if (!flying && a.status === "in_flight") this.touchAircraft({ ...a, status: "available" });
  }

  /**
   * Costs and wear of a flown leg: fuel (unless wet-leased) at the fuel airport's price,
   * the landing fee where it parked, lease hours, wear, hours and cycles; the aircraft
   * moves to the landing airport.
   */
  settleFlight(aircraftId: string, f: FlightSettlement): BookResult<SettlementResult> {
    const a = this.fleet.get(aircraftId);
    if (!a) return fail("unknown_aircraft", `No aircraft ${aircraftId}`);
    const type = aircraftTypeByKey(a.typeKey);
    if (!type) return fail("unknown_type", a.typeKey);
    const costs: MissionCost[] = [];
    // P5 part 2: the hull value before this flight (an insured write-off pays a share of it)
    // and the player's own FBO where the aircraft parks (fuel at cost, waived fees, lounge).
    const valueBefore = this.aircraftValue(a);
    const own =
      f.landingAirport && f.landings > 0 && !f.crashed && f.hired !== true
        ? this.activeFboAt(f.landingAirport.ident)
        : null;
    const savings: Array<{ kind: string; amount: number; memo: string }> = [];
    // P5: known minor (1 % each) and major (5–15 %) defects burn extra fuel.
    const penalty = airworthinessGate(this.gateInput(a), this.company.gameMs).fuelPenaltyPct;
    if (a.ownership !== "wet_lease" && f.fuelKg > 0 && f.fuelAirport) {
      const regional = this.fuelPriceAt(f.fuelAirport);
      const billedKg = f.fuelKg * (1 + penalty / 100);
      const farm =
        own && own.icao === f.fuelAirport.ident && own.modules.fuel.level > 0
          ? fuelPricing(regional.usdPerKg, own.fuelPriceRatio, own.modules.fuel.level)
          : null;
      const price: FuelPrice = farm ? { ...regional, usdPerKg: farm.cost } : regional;
      const amount = fuelCost(billedKg, price);
      if (farm) {
        const saved = round2(fuelCost(billedKg, regional) - amount);
        if (saved > 0) {
          savings.push({
            kind: "fuel_at_cost",
            amount: saved,
            memo: `${Math.round(billedKg)} kg at cost $${farm.cost.toFixed(3)}/kg instead of $${regional.usdPerKg.toFixed(3)}/kg`,
          });
        }
      }
      if (amount > 0) {
        this.post(
          "fuel",
          -amount,
          f.refType,
          f.refId,
          `${f.memo}: ${Math.round(f.fuelKg)} kg at ${f.fuelAirport.ident}`,
        );
        costs.push({
          key: "fuel",
          label: `Fuel at ${f.fuelAirport.ident}`,
          amount,
          note:
            (penalty > 0
              ? `${round2(f.fuelKg)} kg + ${penalty} % defect burn × $${price.usdPerKg.toFixed(3)}/kg`
              : `${round2(f.fuelKg)} kg × $${price.usdPerKg.toFixed(3)}/kg`) +
            (farm ? " (own fuel farm, at cost)" : ""),
        });
      }
    }
    if (own && f.landingAirport) {
      // Own ramp: no landing fee to pay yourself.
      const fee = landingFee(f.landingAirport, type);
      savings.push({
        kind: "landing_fee_waived",
        amount: fee,
        memo: `Landing fee $${fee} waived at the own FBO`,
      });
      costs.push({
        key: "landing_fee",
        label: `Landing fee ${f.landingAirport.ident}`,
        amount: 0,
        note: `Waived at your FBO ($${fee})`,
      });
    } else if (f.landingAirport && f.landings > 0) {
      const fee = landingFee(f.landingAirport, type);
      this.post(
        "landing_fee",
        -fee,
        f.refType,
        f.refId,
        `${f.memo}: landing at ${f.landingAirport.ident}`,
      );
      costs.push({
        key: "landing_fee",
        label: `Landing fee ${f.landingAirport.ident}`,
        amount: fee,
        note: `${f.landingAirport.type} airport, ${type.category}`,
      });
    }
    if (a.ownership !== "owned") {
      const hours = Math.max(0, f.blockMin) / 60;
      const amount =
        a.ownership === "dry_lease"
          ? round2(hours * type.engines * type.dryLeaseUsdPerEngineHour)
          : round2(hours * type.wetLeaseUsdPerBlockHour);
      if (amount > 0) {
        this.post("lease", -amount, f.refType, f.refId, `${f.memo}: ${a.registration} lease hours`);
        costs.push({
          key: "lease",
          label:
            a.ownership === "dry_lease" ? "Dry lease hours" : "Wet lease hours (fuel included)",
          amount,
          note:
            a.ownership === "dry_lease"
              ? `${round2(hours)} h × ${type.engines} engine(s) × $${type.dryLeaseUsdPerEngineHour}`
              : `${round2(hours)} h × $${type.wetLeaseUsdPerBlockHour}`,
        });
      }
    }
    const wear = flightWear({
      airborneMin: f.airborneMin,
      peakG: f.peakG,
      overspeedEvents: f.overspeedEvents,
      crashed: f.crashed,
    });
    // P5: wear lands on the systems (the weighted mean drops by the P4 wear), then the
    // seeded defect rolls for thresholds, a hard landing, overspeed, dry tanks and crashes.
    const systems = distributeWear(a.systems, {
      hours: wear.hours,
      g: wear.g,
      overspeed: wear.overspeed,
      crash: wear.crash,
    });
    const condition = derivedCondition(systems);
    let counter = a.defectCounter;
    const rolls = rollFlightDefects(
      new Rng(seedFrom(this.company.seed, a.id, "flight", a.cycles, f.refId)),
      {
        type,
        before: a.systems,
        after: systems,
        existing: a.defects,
        airborneMin: f.airborneMin,
        peakG: f.peakG,
        overspeedEvents: f.overspeedEvents,
        tanksDry: f.tanksDry === true,
        crashed: f.crashed,
        nextId: () => `${a.id}-D${++counter}`,
        gameMs: Math.floor(this.company.gameMs),
      },
    );
    const escalated = new Map(rolls.escalated.map((d) => [d.id, d]));
    const defects = [...a.defects.map((d) => escalated.get(d.id) ?? d), ...rolls.added];
    const writtenOff = f.crashed && condition < WRITE_OFF_CONDITION;
    const incidents: Incident[] = [...a.incidents];
    const at = Math.floor(this.company.gameMs);
    if (f.crashed) incidents.push({ gameMs: at, kind: "crash" });
    else if (f.peakG !== null && f.peakG > INSURANCE.hardLandingG) {
      incidents.push({ gameMs: at, kind: "hard_landing" });
    }
    // The 100-hour milestone counts the player's own flying only (never hired legs).
    if (f.hired !== true) {
      this.company = {
        ...this.company,
        flightHours: round2(this.company.flightHours + Math.max(0, f.airborneMin) / 60),
      };
    }
    const next: BookAircraft = {
      ...a,
      systems,
      condition,
      defects,
      incidents,
      defectCounter: counter,
      hours: round2(a.hours + Math.max(0, f.airborneMin) / 60),
      cycles: a.cycles + Math.max(0, f.landings),
      status: writtenOff ? "written_off" : a.status === "in_flight" ? "available" : a.status,
      location: f.landingAirport && !f.crashed ? f.landingAirport.ident : a.location,
    };
    this.touchAircraft(next);
    const found = [...rolls.escalated, ...rolls.added];
    this.event(a.id, f.hired === true ? "pilot_leg" : "flight", {
      ref: f.refId,
      wear,
      condition,
      location: next.location,
      costs: costs.map((c) => ({ key: c.key, amount: c.amount })),
      ...(found.length ? { defects: found.map((d) => d.id) } : {}),
    });
    for (const d of found) {
      this.notice("defect.found", {
        aircraftId: a.id,
        registration: a.registration,
        defect: d,
        on: f.refType,
      });
    }
    if (own) this.ownArrival(own, a, savings, f.refId);
    if (writtenOff) {
      this.event(a.id, "written_off", { condition });
      if (a.insurance) this.settleWriteOff(this.fleet.get(a.id) ?? next, valueBefore);
      // An open repair loan implies a policy (cancelling is refused while one is open); should
      // one remain anyway, the hull is gone and the balance is due at once.
      const leftover = this.openRepairLoan(a.id);
      if (leftover) this.callRepairLoan(leftover, "aircraft_written_off");
      if (this.company.selectedAircraftId === a.id) {
        this.company = { ...this.company, selectedAircraftId: null };
      }
      this.notice("aircraft.grounded", {
        aircraftId: a.id,
        registration: a.registration,
        writtenOff: true,
        reasons: [{ code: "written_off", message: `Destroyed in a crash (${condition} %)` }],
      });
    } else if (found.some((d) => d.severity === "grounding")) {
      this.groundedNotice(this.fleet.get(a.id) ?? next);
    }
    return { ok: true, data: { costs, wear, condition, defects: found, writtenOff } };
  }

  // ---- P5: airworthiness, maintenance orders, defects ----

  gateInput(a: BookAircraft) {
    return {
      systems: a.systems,
      defects: a.defects,
      hours: a.hours,
      annual: a.annual,
      ferryPermit: a.ferryPermit,
    };
  }

  /** The airworthiness gate on what is known now (hidden defects are not seen). */
  gate(a: BookAircraft): GateResult {
    return airworthinessGate(this.gateInput(a), this.company.gameMs);
  }

  private groundedNotice(a: BookAircraft): void {
    const g = this.gate(a);
    this.notice("aircraft.grounded", {
      aircraftId: a.id,
      registration: a.registration,
      reasons: g.reasons.map((r) => ({ code: r.code, message: r.message })),
    });
  }

  /**
   * Hidden defects surface (on the first dispatch, a ferry permit request or an annual
   * inspection): each becomes known with `defect.found`; a grounding one adds
   * `aircraft.grounded`. Returns the defects found.
   */
  revealHidden(aircraftId: string, on: "dispatch" | "annual"): Defect[] {
    const a = this.fleet.get(aircraftId);
    if (!a) return [];
    const hidden = a.defects.filter((d) => d.hidden);
    if (hidden.length === 0) return [];
    const at = Math.floor(this.company.gameMs);
    const defects = a.defects.map((d) => (d.hidden ? { ...d, hidden: false, foundGameMs: at } : d));
    const next = { ...a, defects };
    this.touchAircraft(next);
    const found = defects.filter((d) => hidden.some((h) => h.id === d.id));
    this.event(a.id, "defects.revealed", { on, defects: found.map((d) => d.id) });
    for (const d of found) {
      this.notice("defect.found", {
        aircraftId: a.id,
        registration: a.registration,
        defect: d,
        on,
      });
    }
    if (found.some((d) => d.severity === "grounding")) this.groundedNotice(next);
    return found;
  }

  /**
   * Dispatch check (mission load, flight start, ferry): hidden defects surface first, then
   * the gate runs. Refused with `aircraft_unairworthy` listing every reason.
   */
  dispatchCheck(aircraftId: string): BookResult<GateResult> {
    const a = this.aircraft(aircraftId);
    if (!a) return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
    this.revealHidden(a.id, "dispatch");
    const now = this.fleet.get(a.id) ?? a;
    const g = this.gate(now);
    if (!g.ok) {
      return fail(
        "aircraft_unairworthy",
        `${now.registration} is not airworthy: ${g.reasons.map((r) => r.message).join("; ")}`,
        g.reasons.map((r) => ({ code: r.code, message: r.message })),
      );
    }
    return { ok: true, data: g };
  }

  private openOrder(
    a: BookAircraft,
    o: Pick<MaintenanceOrder, "kind" | "defectIds" | "label" | "shop" | "cost" | "hours">,
  ): MaintenanceOrder {
    const n = this.company.orderCounter + 1;
    this.company = { ...this.company, orderCounter: n };
    const startGameMs = queueStart(a.orders, this.company.gameMs);
    const order: MaintenanceOrder = {
      id: `MO-${n}`,
      aircraftId: a.id,
      kind: o.kind,
      defectIds: o.defectIds,
      label: o.label,
      airport: a.location,
      shop: o.shop,
      cost: o.cost,
      hours: o.hours,
      startGameMs,
      readyAtGameMs: Math.floor(startGameMs + o.hours * 3_600_000),
    };
    const orders = [...a.orders, order];
    this.touchAircraft({
      ...a,
      status: "maintenance",
      orders,
      readyAtGameMs: order.readyAtGameMs,
    });
    this.event(a.id, "repair.started", {
      order: order.id,
      kind: order.kind,
      cost: order.cost,
      hours: order.hours,
      readyAtGameMs: order.readyAtGameMs,
      shop: order.shop,
    });
    return order;
  }

  private completeOrders(a0: BookAircraft, t: number): void {
    let a = a0;
    const done = a.orders
      .filter((o) => o.readyAtGameMs <= t)
      .sort((x, y) => x.readyAtGameMs - y.readyAtGameMs);
    for (const o of done) {
      if (o.kind === "overhaul") {
        a = { ...a, systems: systemsFromCondition(100) };
      } else if (o.kind === "defect") {
        a = { ...a, defects: a.defects.filter((d) => !o.defectIds.includes(d.id)) };
        // P5 part 2: a used aircraft with every known defect repaired is a restoration.
        if (a.ageYears > 0 && o.defectIds.length > 0 && !a.defects.some((d) => !d.hidden)) {
          this.company = { ...this.company, restorations: this.company.restorations + 1 };
        }
      } else {
        a = { ...a, annual: { lastGameMs: o.readyAtGameMs, lastHours: a.hours } };
      }
      a = { ...a, orders: a.orders.filter((x) => x.id !== o.id) };
      this.touchAircraft(a);
      a = this.fleet.get(a.id) ?? a;
      if (o.kind === "annual") {
        const found = this.revealHidden(a.id, "annual");
        a = this.fleet.get(a.id) ?? a;
        this.event(a.id, "inspection.completed", { order: o.id, found: found.length });
        this.notice("inspection.completed", {
          kind: "annual",
          aircraftId: a.id,
          registration: a.registration,
          found: found.length,
        });
      } else {
        this.event(a.id, "repair.completed", { order: o.id, kind: o.kind, condition: a.condition });
        this.notice("repair.completed", {
          aircraftId: a.id,
          registration: a.registration,
          order: o.id,
          kind: o.kind,
        });
      }
    }
    const last = a.orders.reduce<number | null>(
      (m, o) => (m === null ? o.readyAtGameMs : Math.max(m, o.readyAtGameMs)),
      null,
    );
    this.touchAircraft({
      ...a,
      status:
        a.orders.length > 0 ? "maintenance" : a.status === "maintenance" ? "available" : a.status,
      readyAtGameMs: last,
    });
  }

  private workable(aircraftId: string): BookResult<BookAircraft> {
    const a = this.aircraft(aircraftId);
    if (!a) return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
    if (a.status === "in_flight") return fail("aircraft_busy", `${a.registration} is flying`);
    if (a.status === "hired") return fail("aircraft_busy", busyMessage(a));
    return { ok: true, data: a };
  }

  private queued(a: BookAircraft): Set<string> {
    return new Set(a.orders.flatMap((o) => o.defectIds));
  }

  /** Cost and time to repair these defects where the aircraft is parked. */
  repairQuoteFor(a: BookAircraft, defects: readonly Defect[]) {
    const shop = this.shopFor(a.location, defects);
    return { shop, ...repairQuote(defects, shop) };
  }

  /**
   * Shop rates at an airport: the own FBO maintenance shop when its level covers every
   * defect's severity (any level for an annual), else maintenance-capable or field rates.
   */
  shopFor(icao: string, defects: readonly Pick<Defect, "severity">[]): Shop {
    const level = this.ownShopLevel(icao);
    if (level > 0 && defects.every((d) => ownShopCovers(level, d.severity))) return "own";
    return shopAt(this.baseMaintenance, icao);
  }

  /** Repair one known defect (queued behind any running order). */
  repairDefect(aircraftId: string, defectId: string): BookResult<{ order: MaintenanceOrder }> {
    const t = this.repairTarget(aircraftId, "defect", defectId);
    if (!t.ok) return t;
    const cash = this.repairCashCheck(t.data, 0);
    if (!cash.ok) return cash;
    return { ok: true, data: { order: this.placeRepair(t.data) } };
  }

  /** Repair every known defect not already queued, as one order. */
  repairAll(aircraftId: string): BookResult<{ order: MaintenanceOrder }> {
    const t = this.repairTarget(aircraftId, "all");
    if (!t.ok) return t;
    const cash = this.repairCashCheck(t.data, 0);
    if (!cash.ok) return cash;
    return { ok: true, data: { order: this.placeRepair(t.data) } };
  }

  /** Annual inspection (also reveals hidden defects when it completes). */
  annualInspection(aircraftId: string): BookResult<{ order: MaintenanceOrder }> {
    const w = this.workable(aircraftId);
    if (!w.ok) return w;
    const a = w.data;
    if (a.orders.some((o) => o.kind === "annual")) {
      return fail("already_queued", `An annual inspection is already queued for ${a.registration}`);
    }
    const type = aircraftTypeByKey(a.typeKey);
    if (!type) return fail("unknown_type", a.typeKey);
    const shop = this.shopFor(a.location, []);
    const q = annualQuote(type, shop);
    if (this.company.cash < q.cost) {
      return fail("insufficient_cash", `The annual costs $${q.cost.toLocaleString("en-US")}`);
    }
    this.post("inspection", -q.cost, "aircraft", a.id, `${a.registration} annual inspection`);
    const order = this.openOrder(this.fleet.get(a.id) ?? a, {
      kind: "annual",
      defectIds: [],
      label: "Annual inspection",
      shop,
      cost: q.cost,
      hours: q.hours,
    });
    return { ok: true, data: { order } };
  }

  /** Defer a known minor defect (MEL): it may fly for 30 flight hours. */
  defer(aircraftId: string, defectId: string): BookResult<{ defect: Defect }> {
    const a = this.aircraft(aircraftId);
    if (!a) return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
    if (a.status === "hired") return fail("aircraft_busy", busyMessage(a));
    const d = a.defects.find((x) => x.id === defectId && !x.hidden);
    if (!d) return fail("unknown_defect", `No known defect ${defectId} on ${a.registration}`);
    if (d.severity !== "minor") {
      return fail("not_deferrable", `Only minor defects can be deferred (${d.severity})`);
    }
    if (d.deferredAtHours !== undefined) {
      return fail("already_deferred", `${d.title} was deferred at ${d.deferredAtHours} h`);
    }
    const deferred: Defect = { ...d, deferredAtHours: round2(a.hours) };
    this.touchAircraft({
      ...a,
      defects: a.defects.map((x) => (x.id === d.id ? deferred : x)),
    });
    this.event(a.id, "defect.deferred", { defect: d.id, atHours: deferred.deferredAtHours });
    return { ok: true, data: { defect: deferred } };
  }

  /**
   * Ferry permit: one flight to the nearest maintenance-capable airport with no job
   * revenue and a payload cap. Needs no grounding defect, every system ≥ 10 % and a
   * reason to ferry (the gate fails, or a major defect is open).
   */
  ferryPermit(aircraftId: string): BookResult<FerryPermit> {
    const a0 = this.aircraft(aircraftId);
    if (!a0) return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
    if (a0.status !== "available") {
      return fail("aircraft_busy", busyMessage(a0));
    }
    if (a0.ferryPermit) return fail("permit_active", `${a0.registration} already has a permit`);
    const type = aircraftTypeByKey(a0.typeKey);
    if (!type) return fail("unknown_type", a0.typeKey);
    this.revealHidden(a0.id, "dispatch");
    const a = this.fleet.get(a0.id) ?? a0;
    const g = this.gate(a);
    if (!ferryEligible(this.gateInput(a), g)) {
      const grounding = g.reasons.filter((r) => r.code === "grounding_defect");
      return fail(
        "ferry_not_allowed",
        grounding.length > 0
          ? `${a.registration} has a grounding defect: repair it where it is`
          : g.ok
            ? `${a.registration} is airworthy and has no major defect: no permit needed`
            : `A system of ${a.registration} is below 10 %: repair it where it is`,
        g.reasons.map((r) => ({ code: r.code, message: r.message })),
      );
    }
    if (this.maintenance.isMaintenanceCapable(a.location)) {
      return fail(
        "at_maintenance_airport",
        `${a.location} is maintenance-capable: repair ${a.registration} here`,
      );
    }
    const from = this.airports?.get(a.location);
    if (!from || !this.airports) return fail("unknown_airport", `Unknown airport ${a.location}`);
    const dest = nearestMaintenanceAirport(from, this.airports.list, this.maintenance);
    if (!dest) return fail("no_maintenance_airport", "No maintenance-capable airport is known");
    if (dest.distanceNm > type.rangeNm) {
      return fail(
        "ferry_out_of_range",
        `${dest.airport.ident} is ${dest.distanceNm} nm away, beyond the ${type.rangeNm} nm range`,
      );
    }
    const fee = ferryPermitFee(type);
    if (this.company.cash < fee) {
      return fail("insufficient_cash", `The permit costs $${fee.toLocaleString("en-US")}`);
    }
    this.post(
      "permit",
      -fee,
      "aircraft",
      a.id,
      `${a.registration} ferry permit ${a.location}→${dest.airport.ident}`,
    );
    const permit: FerryPermit = {
      origin: a.location,
      destination: dest.airport.ident,
      distanceNm: dest.distanceNm,
      payloadCapKg: ferryPayloadCapKg(type),
      issuedGameMs: Math.floor(this.company.gameMs),
      fee,
    };
    this.touchAircraft({ ...a, ferryPermit: permit });
    this.event(a.id, "ferry.permit", { ...permit });
    return { ok: true, data: permit };
  }

  /** The ferry flight happened: the permit is used up. */
  consumeFerryPermit(aircraftId: string): void {
    const a = this.fleet.get(aircraftId);
    if (!a?.ferryPermit) return;
    this.event(a.id, "ferry.flown", { destination: a.ferryPermit.destination, at: a.location });
    this.touchAircraft({ ...a, ferryPermit: null });
  }

  // ---- P5: used market ----

  private touchListing(l: ListingRecord): void {
    if (l.status === "listed") this.listings.set(l.id, l);
    else this.listings.delete(l.id);
    const i = this.pending.listings.findIndex((x) => x.id === l.id);
    if (i >= 0) this.pending.listings[i] = l;
    else this.pending.listings.push(l);
  }

  /** First market of a company (or an empty one after an import) when airport data exists. */
  ensureMarket(): void {
    if ((this.company.marketGeneration === 0 || this.listings.size === 0) && this.airports) {
      this.refreshMarket();
    }
  }

  /**
   * New market generation: listings with a pending or completed inspection stay, every
   * other listing is replaced by the seeded generation.
   */
  refreshMarket(): BookResult<{ generation: number; listings: number }> {
    if (!this.airports) return fail("no_airport_data", "Airport data is not available");
    for (const l of [...this.listings.values()]) {
      if (l.inspection.status === "none") this.touchListing({ ...l, status: "expired" });
    }
    const generation = this.company.marketGeneration + 1;
    const fresh = generateMarket({
      seed: this.company.seed,
      generation,
      airports: this.airports.list,
      base: this.airports.get(this.company.base),
      gameMs: this.company.gameMs,
    });
    for (const l of fresh) this.touchListing(l);
    this.company = {
      ...this.company,
      marketGeneration: generation,
      marketRefreshedGameMs: Math.floor(this.company.gameMs),
    };
    this.pending.company = true;
    return { ok: true, data: { generation, listings: this.listings.size } };
  }

  /** Pre-purchase inspection: 0.5 % of the asking price, one in-game day. */
  inspectListing(listingId: string): BookResult<{ fee: number; readyAtGameMs: number }> {
    const l = this.listings.get(listingId);
    if (!l) return fail("unknown_listing", `Listing ${listingId} is no longer on the market`);
    if (l.inspection.status !== "none") {
      return fail("already_inspected", `Listing ${listingId} is already ${l.inspection.status}`);
    }
    const fee = l.inspection.fee;
    if (this.company.cash < fee) {
      return fail("insufficient_cash", `The inspection costs $${fee.toLocaleString("en-US")}`);
    }
    this.post("inspection", -fee, "listing", l.id, `Pre-purchase inspection ${l.id}`);
    const readyAtGameMs = Math.floor(this.company.gameMs + INSPECTION_MS);
    this.touchListing({ ...l, inspection: { status: "pending", fee, readyAtGameMs } });
    return { ok: true, data: { fee, readyAtGameMs } };
  }

  /** Buy a used listing (cash or financed); uninspected purchases roll a hidden grounding defect. */
  buyListing(args: {
    listingId: string;
    financing?: { lenderId: string; termMonths: number; principal: number };
  }): BookResult<{ aircraft: BookAircraft; loan: BookLoan | null; inspected: boolean }> {
    const l = this.listings.get(args.listingId);
    if (!l) return fail("unknown_listing", `Listing ${args.listingId} is no longer on the market`);
    const type = aircraftTypeByKey(l.typeKey);
    if (!type) return fail("unknown_type", `Unknown aircraft type ${l.typeKey}`);
    if (!canBuy(type, this.company.reputation)) {
      return fail(
        "reputation_gate",
        `Buying a ${type.name} needs reputation tier ${purchaseMinTier(type)} (${tierName(purchaseMinTier(type))})`,
      );
    }
    const price = l.askingPrice;
    let quote: LoanQuote | null = null;
    if (args.financing) {
      const lender = lenderById(args.financing.lenderId);
      if (!lender) return fail("unknown_lender", `Unknown lender ${args.financing.lenderId}`);
      quote = this.quoteWith(lender.id, args.financing.principal, args.financing.termMonths, price);
      if (!quote.ok) return fail(quote.code ?? "loan_declined", quote.message ?? "Declined");
    }
    const principal = quote ? quote.principal : 0;
    const fee = quote ? quote.originationFee : 0;
    const needed = round2(price - principal + fee);
    if (this.company.cash < needed) {
      return fail(
        "insufficient_cash",
        `Needs $${needed.toLocaleString("en-US")} in cash (price − loan + 1 % fee)`,
      );
    }
    const inspected = l.inspection.status === "done";
    const a0 = this.addAircraft(type, "owned", l.location, price, {
      ageYears: l.ageYears,
      hours: l.hours,
      cycles: l.cycles,
      systems: l.systems,
    });
    let counter = 0;
    const defects: Defect[] = l.defects.map((d) => ({ ...d, id: `${a0.id}-D${++counter}` }));
    const rolled = purchaseHiddenRoll(this.company.seed, l, `${a0.id}-D${counter + 1}`);
    if (rolled) {
      counter++;
      defects.push(rolled);
    }
    this.touchAircraft({ ...a0, defects, defectCounter: counter });
    this.post(
      "purchase",
      -price,
      "aircraft",
      a0.id,
      `Bought used ${type.name} ${a0.registration} (${l.id})`,
    );
    this.event(a0.id, "purchased", {
      price,
      location: l.location,
      listingId: l.id,
      used: true,
      inspected,
      ageYears: l.ageYears,
      hours: l.hours,
    });
    this.touchListing({ ...l, status: "sold" });
    let loan: BookLoan | null = null;
    if (quote) loan = this.openLoan(quote, { type: "aircraft", id: a0.id });
    return { ok: true, data: { aircraft: this.fleet.get(a0.id) ?? a0, loan, inspected } };
  }

  marketDomain(): MarketState {
    const base = this.airports?.get(this.company.base) ?? null;
    const listings = [...this.listings.values()]
      .sort((x, y) => x.generation - y.generation || listingOrder(x.id) - listingOrder(y.id))
      .map((l) => listingState(l, base, this.airports?.get(l.location) ?? null));
    return {
      listings,
      generation: this.company.marketGeneration,
      refreshedGameMs: this.company.marketRefreshedGameMs,
      nextRefreshGameMs: this.company.marketRefreshedGameMs + MARKET_REFRESH_MS,
    };
  }

  /** Every listing record (hidden defects included) for persistence and tests. */
  listingRecords(): ListingRecord[] {
    return [...this.listings.values()];
  }

  // ---- loans ----

  private quoteWith(
    lenderId: string,
    principal: number,
    termMonths: number,
    collateralValue: number | null,
  ): LoanQuote {
    const lender = lenderById(lenderId);
    const credit = this.credit();
    if (!lender) {
      return {
        lenderId,
        lenderName: lenderId,
        ok: false,
        code: "unknown_lender",
        message: `Unknown lender ${lenderId}`,
        principal,
        termMonths,
        apr: 0,
        payment: 0,
        originationFee: 0,
        totalInterest: 0,
        ltv: null,
      };
    }
    return quoteLoan({
      lender,
      score: credit.score,
      reputation: this.company.reputation,
      defaulted: this.defaulted(),
      principal,
      termMonths,
      collateralValue,
    });
  }

  /** Quotes from one lender or all of them. */
  quote(args: {
    lenderId?: string;
    principal: number;
    termMonths: number;
    collateralValue?: number;
    collateral?: Collateral;
  }): BookResult<LoanQuote[]> {
    let value = args.collateralValue ?? null;
    if (args.collateral) {
      const c = this.collateralCheck(args.collateral);
      if (!c.ok) return c;
      value = c.data;
    }
    const lenders = args.lenderId ? [args.lenderId] : LENDERS.map((l) => l.id);
    return {
      ok: true,
      data: lenders.map((id) => this.quoteWith(id, args.principal, args.termMonths, value)),
    };
  }

  private collateralCheck(collateral: Collateral): BookResult<number> {
    if (collateral.type === "fbo") {
      const f = this.fbos.get(collateral.id);
      if (!f || (f.status !== "active" && f.status !== "building")) {
        return fail("unknown_fbo", `No FBO ${collateral.id}`);
      }
      if (f.loanId && this.loans.get(f.loanId)?.status === "active") {
        return fail("collateral_encumbered", `The FBO at ${f.icao} already secures a loan`);
      }
      return { ok: true, data: fboValue(f.invested) };
    }
    const a = this.aircraft(collateral.id);
    if (!a) return fail("unknown_aircraft", `No aircraft ${collateral.id} in the fleet`);
    if (a.status === "hired") return fail("aircraft_busy", busyMessage(a));
    if (a.ownership !== "owned") return fail("not_owned", "Leased aircraft cannot be pledged");
    if (a.loanId && this.loans.get(a.loanId)?.status === "active") {
      return fail("collateral_encumbered", `${a.registration} already secures a loan`);
    }
    return { ok: true, data: this.aircraftValue(a) };
  }

  takeLoan(args: {
    lenderId: string;
    principal: number;
    termMonths: number;
    collateral: Collateral;
  }): BookResult<BookLoan> {
    const c = this.collateralCheck(args.collateral);
    if (!c.ok) return c;
    const quote = this.quoteWith(args.lenderId, args.principal, args.termMonths, c.data);
    if (!quote.ok) return fail(quote.code ?? "loan_declined", quote.message ?? "Declined");
    return { ok: true, data: this.openLoan(quote, args.collateral) };
  }

  private openLoan(quote: LoanQuote, collateral: Collateral): BookLoan {
    const n = this.company.loanCounter + 1;
    this.company = { ...this.company, loanCounter: n };
    const loan: BookLoan = {
      id: `LN-${n}`,
      lenderId: quote.lenderId,
      principal: quote.principal,
      apr: quote.apr,
      termMonths: quote.termMonths,
      payment: quote.payment,
      balance: quote.principal,
      collateral,
      nextDueGameMs: Math.floor(this.company.gameMs + GAME_MONTH_MS),
      missedCount: 0,
      paymentsMade: 0,
      status: "active",
      takenAt: this.now(),
      takenGameMs: Math.floor(this.company.gameMs),
    };
    this.touchLoan(loan);
    this.post("loan_disbursement", quote.principal, "loan", loan.id, `${quote.lenderName} loan`);
    if (quote.originationFee > 0) {
      this.post(
        "loan_fee",
        -quote.originationFee,
        "loan",
        loan.id,
        `${quote.lenderName} origination fee 1 %`,
      );
    }
    if (collateral.type === "aircraft") {
      const a = this.fleet.get(collateral.id);
      if (a) {
        this.touchAircraft({ ...a, loanId: loan.id });
        this.event(a.id, "financed", { loanId: loan.id, principal: loan.principal });
      }
    } else {
      const f = this.fbos.get(collateral.id);
      if (f) this.touchFbo({ ...f, loanId: loan.id });
    }
    return this.loans.get(loan.id) ?? loan;
  }

  payoff(loanId: string): BookResult<{ amount: number }> {
    const loan = this.loans.get(loanId);
    if (!loan || loan.status !== "active") return fail("unknown_loan", `No active loan ${loanId}`);
    if (this.company.cash < loan.balance) {
      return fail("insufficient_cash", `The payoff is $${loan.balance.toLocaleString("en-US")}`);
    }
    const amount = loan.balance;
    const repair = isRepairLoan(loan);
    this.post(
      repair ? "repair_loan_payment" : "loan_payment",
      -amount,
      "loan",
      loan.id,
      repair ? "Repair loan early payoff (no penalty)" : "Early payoff (no penalty)",
    );
    const paid: BookLoan = { ...loan, balance: 0, status: "paid_off" };
    this.touchLoan(paid);
    if (!repair) this.releaseCollateral(paid);
    return { ok: true, data: { amount } };
  }

  // ---- domains ----

  fleetDomain(selection: Selection): FleetState {
    const aircraft: FleetAircraft[] = this.activeFleet().map((a) => {
      const type = aircraftTypeByKey(a.typeKey);
      const loan = a.loanId ? this.loans.get(a.loanId) : undefined;
      const financed = loan?.status === "active";
      return {
        id: a.id,
        registration: a.registration,
        typeKey: a.typeKey,
        typeName: type?.name ?? a.typeKey,
        ownership: a.ownership,
        status: a.status,
        location: a.location,
        hours: round2(a.hours),
        cycles: a.cycles,
        condition: a.condition,
        airworthy: this.gate(a).ok,
        purchasePrice: a.purchasePrice,
        value: this.aircraftValue(a),
        repairCost: type ? repairCost(type, a.condition) : 0,
        repairHours: repairHours(a.condition),
        ...(a.readyAtGameMs !== null ? { readyAtGameMs: a.readyAtGameMs } : {}),
        financed,
        ...(financed && a.loanId ? { loanId: a.loanId } : {}),
        acquiredAt: new Date(a.acquiredAt).toISOString(),
        ...this.p5Fields(a, type),
      };
    });
    const board = this.activeFleet()
      .flatMap((a) => a.orders.map((o) => ({ ...o, registration: a.registration })))
      .sort((x, y) => x.readyAtGameMs - y.readyAtGameMs || (x.id < y.id ? -1 : 1));
    return {
      aircraft,
      selectedId: selection.id,
      selection: selection.source,
      ambiguous: selection.ambiguous,
      value: this.fleetValue(),
      maintenance: board,
    };
  }

  /** P5 fields of a fleet aircraft (systems, known defects, gate, annual, permit, orders). */
  private p5Fields(a: BookAircraft, type: AircraftType | null): Partial<FleetAircraft> {
    const g = this.gate(a);
    const shop = this.shopFor(a.location, []);
    const annual = type ? annualQuote(type, shop) : { cost: 0, hours: 0 };
    const known = a.defects.filter((d) => !d.hidden);
    const queued = this.queued(a);
    const all = this.repairQuoteFor(
      a,
      known.filter((d) => !queued.has(d.id)),
    );
    const defectView = (d: Defect): Defect => {
      const left = deferralHoursLeft(d, a.hours);
      return left === null ? d : { ...d, deferralHoursLeft: left };
    };
    return {
      ageYears: Math.round(this.ageNow(a) * 10) / 10,
      systems: SYSTEM_KEYS.map((k) => ({
        key: k,
        label: SYSTEM_LABELS[k],
        condition: a.systems[k],
        defects: known.filter((d) => d.system === k).map(defectView),
      })),
      airworthiness: {
        status: g.status,
        reasons: g.reasons,
        ferryEligible:
          a.ferryPermit === null &&
          a.status === "available" &&
          ferryEligible(this.gateInput(a), g) &&
          !this.maintenance.isMaintenanceCapable(a.location),
        payloadPenaltyPct: g.payloadPenaltyPct,
        fuelPenaltyPct: g.fuelPenaltyPct,
      },
      annual: {
        lastGameMs: a.annual.lastGameMs,
        lastHours: a.annual.lastHours,
        dueGameMs: g.annual.dueGameMs,
        dueHours: g.annual.dueHours,
        due: g.annual.due,
        soon: g.annual.soon,
        cost: annual.cost,
        hours: annual.hours,
      },
      ...(a.ferryPermit ? { ferryPermit: a.ferryPermit } : {}),
      maintenance: a.orders.map((o) => ({ ...o, registration: a.registration })),
      repairAllCost: all.cost,
      repairAllHours: all.hours,
      ...(a.ownership === "owned" ? { insurance: this.insuranceState(a) } : {}),
    };
  }

  loansDomain(): LoansState {
    const all = [...this.loans.values()];
    const active = all
      .filter((l) => l.status === "active")
      .sort((a, b) => a.takenGameMs - b.takenGameMs);
    const closed = all
      .filter((l) => l.status !== "active")
      .sort((a, b) => b.takenGameMs - a.takenGameMs)
      .slice(0, 10);
    const credit = this.credit();
    const month = gameMonthIndex(this.company.gameMs);
    const recent = this.company.pnl.filter((m) => m.month > month - 3 && m.month <= month);
    const monthlyIncome = round2(recent.reduce((s, m) => s + m.revenue, 0) / 3);
    const monthlyDebtService = round2(active.reduce((s, l) => s + l.payment, 0));
    return {
      loans: [...active, ...closed].map((l) => loanState(l)),
      creditScore: credit.score,
      defaultUntilGameMs: this.defaulted() ? this.company.defaultUntilGameMs : null,
      offers: LENDERS.map((l) =>
        lenderOffer(l, credit.score, this.company.reputation, this.defaulted()),
      ),
      monthlyDebtService,
      monthlyIncome,
      debtToIncome:
        monthlyIncome > 0 ? Math.round((monthlyDebtService / monthlyIncome) * 1000) / 1000 : null,
    };
  }

  ledgerDomain(): LedgerState {
    const current = gameMonthIndex(this.company.gameMs);
    const months: PnlMonth[] = [];
    for (let m = Math.max(0, current - 11); m <= current; m++) {
      months.push(
        this.company.pnl.find((p) => p.month === m) ?? { month: m, revenue: 0, expense: 0, net: 0 },
      );
    }
    return {
      recent: this.recent.map(ledgerState),
      months,
      startingCash: this.company.startingCash,
      entries: this.company.ledgerCount,
    };
  }

  /** P4 fields of the `company` domain. */
  companyFields(): Pick<
    CompanyState,
    "tierName" | "creditScore" | "netWorth" | "debt" | "startingCash" | "clock" | "milestones"
  > {
    return {
      tierName: tierName(reputationTier(this.company.reputation)),
      creditScore: this.credit().score,
      netWorth: this.netWorth(),
      debt: this.debt(),
      startingCash: this.company.startingCash,
      clock: companyClock(this.company.gameMs),
      milestones: milestoneList(this.company.milestones),
    };
  }

  // ==== P5 part 2: FBOs, demand, insurance, milestones (book-p5b section) ====
  private get dayProcessed(): number {
    return this.company.dayProcessed ?? 0;
  }

  private touchFbo(f: FboRecord): void {
    this.fbos.set(f.id, f);
    const i = this.pending.fbos.findIndex((x) => x.id === f.id);
    if (i >= 0) this.pending.fbos[i] = f;
    else this.pending.fbos.push(f);
    this.pending.company = true;
  }

  private fboTx(
    f: FboRecord,
    kind: string,
    amount: number,
    source: FboTransactionRecord["source"],
    memo: string | null,
  ): void {
    this.pending.fboTransactions.push({
      fboId: f.id,
      at: this.now(),
      gameMs: Math.floor(this.company.gameMs),
      kind,
      amount: round2(amount),
      source,
      memo,
    });
  }

  private airportOf(icao: string): EconomyAirport | null {
    return this.airports?.get(icao) ?? null;
  }

  /** The player's FBO at an airport (active or under construction). */
  fboAt(icao: string): FboRecord | null {
    const id = icao.toUpperCase();
    for (const f of this.fbos.values()) {
      if (f.icao === id && (f.status === "active" || f.status === "building")) return f;
    }
    return null;
  }

  /** The player's operating FBO at an airport. */
  activeFboAt(icao: string): FboRecord | null {
    const f = this.fboAt(icao);
    return f && f.status === "active" ? f : null;
  }

  /** Level of the own maintenance shop at an airport (0 = none). */
  ownShopLevel(icao: string): number {
    return this.activeFboAt(icao)?.modules.maintenance.level ?? 0;
  }

  private readonly baseFuel = new Map<string, FuelPrice>();

  /** The airport's fuel price now (P4 regional price × an active demand event's uplift). */
  fuelPriceAt(airport: EconomyAirport, gameMs: number = this.company.gameMs): FuelPrice {
    let base = this.baseFuel.get(airport.ident);
    if (!base) {
      base = fuelPrice(airport, this.airports?.list ?? [airport]);
      this.baseFuel.set(airport.ident, base);
    }
    const k = fuelEventFactor(airport.ident, this.events, gameMs);
    return k === 1 ? base : { ...base, usdPerKg: Math.round(base.usdPerKg * k * 1000) / 1000 };
  }

  private fboPnlAdd(
    f: FboRecord,
    d: { income?: number; upkeep?: number; savings?: number },
  ): FboRecord {
    const month = gameMonthIndex(this.company.gameMs);
    const pnl = [...f.pnl];
    const i = pnl.findIndex((m) => m.month === month);
    const row =
      i >= 0 && pnl[i] ? { ...pnl[i] } : { month, income: 0, upkeep: 0, savings: 0, net: 0 };
    row.income = round2(row.income + (d.income ?? 0));
    row.upkeep = round2(row.upkeep + (d.upkeep ?? 0));
    row.savings = round2(row.savings + (d.savings ?? 0));
    row.net = round2(row.income - row.upkeep);
    if (i >= 0) pnl[i] = row;
    else pnl.push(row);
    pnl.sort((a, b) => a.month - b.month);
    return { ...f, pnl: pnl.slice(-12) };
  }

  /** Fleet aircraft parked at an airport (not flying), oldest first. */
  private parkedAt(icao: string): BookAircraft[] {
    // Aircraft operated by a hired pilot are not parked (they come and go on their route).
    return this.activeFleet().filter(
      (a) => a.location === icao && a.status !== "in_flight" && a.status !== "hired",
    );
  }

  // ---- FBO acquisition and modules ----

  /** Buy price, build cost, land lease and build time at an airport. */
  quoteFbo(icao: string): BookResult<ReturnType<typeof fboQuote>> {
    const airport = this.airportOf(icao);
    if (!airport) return fail("unknown_airport", `Unknown airport ${icao}`);
    return { ok: true, data: fboQuote(airport) };
  }

  /** Buy the existing FBO at an airport (ramp & services 1 and a fuel farm 1 included). */
  buyFbo(args: {
    icao: string;
    financing?: { lenderId: string; termMonths: number; principal: number };
  }): BookResult<{ fbo: FboState; loan: BookLoan | null }> {
    return this.acquireFbo(args, "bought");
  }

  /** Build an FBO: construction cost now, a monthly land lease, ready in 3–14 in-game days. */
  buildFbo(args: {
    icao: string;
    financing?: { lenderId: string; termMonths: number; principal: number };
  }): BookResult<{ fbo: FboState; loan: BookLoan | null }> {
    return this.acquireFbo(args, "built");
  }

  private acquireFbo(
    args: { icao: string; financing?: { lenderId: string; termMonths: number; principal: number } },
    origin: "bought" | "built",
  ): BookResult<{ fbo: FboState; loan: BookLoan | null }> {
    const airport = this.airportOf(args.icao);
    if (!airport) return fail("unknown_airport", `Unknown airport ${args.icao}`);
    if (this.fboAt(airport.ident)) {
      return fail("fbo_exists", `You already have an FBO at ${airport.ident}`);
    }
    const q = fboQuote(airport);
    const price = origin === "bought" ? q.buyPrice : q.buildCost;
    let quote: LoanQuote | null = null;
    if (args.financing) {
      const lender = lenderById(args.financing.lenderId);
      if (!lender) return fail("unknown_lender", `Unknown lender ${args.financing.lenderId}`);
      quote = this.quoteWith(lender.id, args.financing.principal, args.financing.termMonths, price);
      if (!quote.ok) return fail(quote.code ?? "loan_declined", quote.message ?? "Declined");
    }
    const principal = quote ? quote.principal : 0;
    const fee = quote ? quote.originationFee : 0;
    const needed = round2(price - principal + fee);
    if (this.company.cash < needed) {
      return fail(
        "insufficient_cash",
        `Needs $${needed.toLocaleString("en-US")} in cash (price − loan + 1 % fee)`,
      );
    }
    const n = this.company.fboCounter + 1;
    this.company = { ...this.company, fboCounter: n };
    const rec = newFboRecord({
      id: `FBO-${n}`,
      icao: airport.ident,
      origin,
      gameMs: this.company.gameMs,
      at: this.now(),
      price,
      landLeaseMonthly: origin === "built" ? q.landLeaseMonthly : 0,
      readyAtGameMs:
        origin === "built" ? Math.floor(this.company.gameMs + q.buildDays * GAME_DAY_MS) : null,
      levels: origin === "bought" ? BOUGHT_MODULES : BUILT_MODULES,
    });
    this.touchFbo(rec);
    this.post(
      origin === "bought" ? "fbo_purchase" : "fbo_construction",
      -price,
      "fbo",
      rec.id,
      origin === "bought"
        ? `Bought the FBO at ${airport.ident}`
        : `FBO construction at ${airport.ident} (${q.buildDays} days)`,
    );
    const loan = quote ? this.openLoan(quote, { type: "fbo", id: rec.id }) : null;
    const f = this.fbos.get(rec.id) ?? rec;
    return { ok: true, data: { fbo: this.fboState(f), loan } };
  }

  private ownedFbo(fboId: string): BookResult<FboRecord> {
    const f = this.fbos.get(fboId);
    if (!f || (f.status !== "active" && f.status !== "building")) {
      return fail("unknown_fbo", `No FBO ${fboId}`);
    }
    return { ok: true, data: f };
  }

  /** Sell an operating FBO: 75 % of the money invested; an open loan on it is paid off. */
  sellFbo(fboId: string): BookResult<{ price: number; loanPaid: number }> {
    const r = this.ownedFbo(fboId);
    if (!r.ok) return r;
    let f = r.data;
    if (f.status !== "active") return fail("fbo_building", `The FBO at ${f.icao} is being built`);
    const price = fboSalePrice(f.invested);
    const loan = f.loanId ? this.loans.get(f.loanId) : undefined;
    const owed = loan && loan.status === "active" ? loan.balance : 0;
    if (owed > price) {
      return fail(
        "underwater",
        `The sale ($${price.toLocaleString("en-US")}) does not cover the loan balance ($${owed.toLocaleString("en-US")})`,
      );
    }
    // Today's accrued traffic is paid out first.
    if (f.today.modelled > 0) {
      this.post("fbo_income", f.today.modelled, "fbo", f.id, `FBO ${f.icao}: traffic until sale`);
      f = this.fboPnlAdd(f, { income: f.today.modelled });
    }
    this.post("sale", price, "fbo", f.id, `Sold the FBO at ${f.icao}`);
    if (loan && owed > 0) {
      this.post(
        "loan_payment",
        -owed,
        "loan",
        loan.id,
        `Payoff from the sale of the FBO at ${f.icao}`,
      );
      this.touchLoan({ ...loan, balance: 0, status: "paid_off" });
    }
    this.touchFbo({ ...f, status: "sold", loanId: null, today: emptyToday(f.today.day) });
    return { ok: true, data: { price, loanPaid: owed } };
  }

  /** Install a module (level 1). */
  buyModule(fboId: string, kind: FboModuleKind): BookResult<{ fbo: FboState }> {
    const r = this.ownedFbo(fboId);
    if (!r.ok) return r;
    const m = r.data.modules[kind];
    if (m.level > 0) {
      return fail("module_installed", `${FBO_MODULE_LABELS[kind]} is installed: upgrade it`);
    }
    return this.queueModule(r.data, kind, 1);
  }

  /** Upgrade a module one level (≤ 3). */
  upgradeModule(fboId: string, kind: FboModuleKind): BookResult<{ fbo: FboState }> {
    const r = this.ownedFbo(fboId);
    if (!r.ok) return r;
    const m = r.data.modules[kind];
    if (m.level === 0) {
      return fail("module_not_installed", `${FBO_MODULE_LABELS[kind]} is not installed`);
    }
    if (m.level >= 3) return fail("module_max_level", `${FBO_MODULE_LABELS[kind]} is at level 3`);
    return this.queueModule(r.data, kind, m.level + 1);
  }

  private queueModule(
    f: FboRecord,
    kind: FboModuleKind,
    toLevel: number,
  ): BookResult<{ fbo: FboState }> {
    if (f.status !== "active") {
      return fail("fbo_building", `The FBO at ${f.icao} is still being built`);
    }
    if (f.modules[kind].pending) {
      return fail("module_pending", `${FBO_MODULE_LABELS[kind]} is already being installed`);
    }
    const airport = this.airportOf(f.icao);
    const s = airport ? airportSize(airport).s : 0;
    const cost = moduleCost(kind, toLevel, s);
    if (this.company.cash < cost) {
      return fail(
        "insufficient_cash",
        `${FBO_MODULE_LABELS[kind]} level ${toLevel} costs $${cost.toLocaleString("en-US")}`,
      );
    }
    this.post(
      "fbo_construction",
      -cost,
      "fbo",
      f.id,
      `${FBO_MODULE_LABELS[kind]} level ${toLevel} at ${f.icao}`,
    );
    const readyAtGameMs = Math.floor(this.company.gameMs + moduleDays(kind, toLevel) * GAME_DAY_MS);
    const next: FboRecord = {
      ...f,
      invested: round2(f.invested + cost),
      modules: {
        ...f.modules,
        [kind]: { ...f.modules[kind], pending: { toLevel, cost, readyAtGameMs } },
      },
    };
    this.touchFbo(next);
    return { ok: true, data: { fbo: this.fboState(next) } };
  }

  /** Player pricing: fuel price ratio (0.7–1.5 × regional) and handling fee ($20–$300). */
  setFboPricing(
    fboId: string,
    p: { fuelPriceRatio?: number | undefined; handlingFeeUsd?: number | undefined },
  ): BookResult<{ fbo: FboState }> {
    const r = this.ownedFbo(fboId);
    if (!r.ok) return r;
    const ratio = p.fuelPriceRatio ?? r.data.fuelPriceRatio;
    const fee = p.handlingFeeUsd ?? r.data.handlingFeeUsd;
    if (!(ratio >= FUEL_RATIO_RANGE.min && ratio <= FUEL_RATIO_RANGE.max)) {
      return fail(
        "bad_price",
        `Fuel price ratio is ${FUEL_RATIO_RANGE.min}–${FUEL_RATIO_RANGE.max}`,
      );
    }
    if (!(fee >= HANDLING_RANGE.min && fee <= HANDLING_RANGE.max)) {
      return fail("bad_price", `Handling fee is $${HANDLING_RANGE.min}–$${HANDLING_RANGE.max}`);
    }
    const next = {
      ...r.data,
      fuelPriceRatio: Math.round(ratio * 1000) / 1000,
      handlingFeeUsd: Math.round(fee * 100) / 100,
    };
    this.touchFbo(next);
    return { ok: true, data: { fbo: this.fboState(next) } };
  }

  /** Monthly upkeep: every installed module at its level + the land lease. */
  fboUpkeep(f: FboRecord): number {
    const airport = this.airportOf(f.icao);
    const s = airport ? airportSize(airport).s : 0;
    const modules =
      f.status === "active"
        ? FBO_MODULE_KINDS.reduce((sum, k) => sum + moduleUpkeep(k, f.modules[k].level, s), 0)
        : 0;
    return round2(modules + f.landLeaseMonthly);
  }

  // ---- FBO time: constructions, modules, traffic hours, day close ----

  private processFbos(t: number): void {
    for (const f0 of [...this.fbos.values()]) {
      let f = f0;
      let changed = false;
      if (f.status === "building" && f.readyAtGameMs !== null && f.readyAtGameMs <= t) {
        f = {
          ...f,
          status: "active",
          readyAtGameMs: null,
          builtAt: this.now(),
          nextHour: Math.ceil(t / HOUR_MS),
          today: emptyToday(Math.floor(t / GAME_DAY_MS)),
        };
        changed = true;
        this.notice("fbo.built", { fboId: f.id, icao: f.icao, what: "construction" });
      }
      if (f.status !== "active") {
        if (changed) this.touchFbo(f);
        continue;
      }
      for (const k of FBO_MODULE_KINDS) {
        const p = f.modules[k].pending;
        if (p && p.readyAtGameMs <= t) {
          f = { ...f, modules: { ...f.modules, [k]: { level: p.toLevel, pending: null } } };
          changed = true;
          this.notice("fbo.built", {
            fboId: f.id,
            icao: f.icao,
            what: "module",
            module: k,
            level: p.toLevel,
          });
        }
      }
      while ((f.nextHour + 1) * HOUR_MS <= t) {
        f = this.accrueHour(f, f.nextHour);
        changed = true;
      }
      if (changed) this.touchFbo(f);
    }
  }

  /** One in-game hour of modelled traffic, accrued into today's totals. */
  private accrueHour(f0: FboRecord, hour: number): FboRecord {
    let f = f0;
    const day = Math.floor(hour / 24);
    if (f.today.day < day) f = this.closeFboDay(f, f.today.day);
    const airport = this.airportOf(f.icao);
    if (!airport) return { ...f, nextHour: hour + 1 };
    const levels = levelsOf(f);
    const regional = this.fuelPriceAt(airport, hour * HOUR_MS).usdPerKg;
    const r = trafficHour(
      {
        companySeed: this.company.seed,
        icao: f.icao,
        airportType: airport.type,
        s: airportSize(airport).s,
        levels,
        fuel: fuelPricing(regional, f.fuelPriceRatio, levels.fuel),
        handlingFeeUsd: f.handlingFeeUsd,
        fuelSoldTodayKg: f.today.fuelKg,
      },
      hour,
    );
    const byKind = { ...f.today.byKind };
    for (const k of Object.keys(byKind) as TrafficKind[])
      byKind[k] = round2(byKind[k] + r.byKind[k]);
    return {
      ...f,
      nextHour: hour + 1,
      today: {
        ...f.today,
        modelled: round2(f.today.modelled + r.total),
        movements: f.today.movements + r.captured,
        fuelKg: f.today.fuelKg + r.fuelKg,
        byKind,
      },
    };
  }

  /**
   * Close an FBO's day: overnight hangar rent, then the day's modelled income is posted as
   * one `fbo_income` ledger entry (with one transaction per kind) and the day is charted.
   */
  private closeFboDay(f: FboRecord, day: number): FboRecord {
    const airport = this.airportOf(f.icao);
    const s = airport ? airportSize(airport).s : 0;
    const night = hangarNight(
      this.company.seed,
      f.icao,
      day,
      f.modules.hangar.level,
      this.parkedAt(f.icao).length,
      s,
    );
    const byKind = { ...f.today.byKind, hangar: round2(f.today.byKind.hangar + night.income) };
    const modelled = round2(f.today.modelled + night.income);
    let g: FboRecord = { ...f, rented: night.rented };
    if (modelled > 0) {
      this.post(
        "fbo_income",
        modelled,
        "fbo",
        f.id,
        `FBO ${f.icao} day ${day + 1}: modelled traffic (${f.today.movements} movements)`,
      );
      for (const k of Object.keys(byKind) as TrafficKind[]) {
        if (byKind[k] > 0) this.fboTx(f, k, byKind[k], "modelled", `Day ${day + 1}`);
      }
      g = this.fboPnlAdd(g, { income: modelled });
    }
    const entry = {
      day,
      own: f.today.own,
      modelled,
      simAi: f.today.simAi,
      movements: f.today.movements,
    };
    this.notice("fbo.income", { fboId: f.id, icao: f.icao, source: "modelled", ...entry });
    return { ...g, daily: [...g.daily, entry].slice(-30), today: emptyToday(day + 1) };
  }

  private processDays(t: number): void {
    const day = Math.floor(t / GAME_DAY_MS);
    while (this.dayProcessed < day) {
      const d = this.dayProcessed + 1;
      for (const f of [...this.fbos.values()]) {
        if (f.status === "active") this.touchFbo(this.closeFboDay(f, f.today.day));
      }
      this.weatherWear(d - 1);
      this.demandDay(d);
      this.company = { ...this.company, dayProcessed: d };
      this.pending.company = true;
    }
  }

  /**
   * Storm weather wear for in-game day `day`: aircraft parked (not flying) at an airport
   * with a storm lose 0.4 condition points spread evenly, less inside an own hangar
   * (−60/80/100 % by level, as many aircraft as it has bays, oldest first).
   */
  private weatherWear(day: number): void {
    const t = (day + 1) * GAME_DAY_MS - 1;
    for (const e of this.events) {
      if (e.kind !== "storm" || !(e.startGameMs <= t && t < e.endGameMs)) continue;
      const fbo = this.activeFboAt(e.icao);
      const level = fbo?.modules.hangar.level ?? 0;
      const bays = level > 0 ? (HANGAR.bays[level - 1] ?? 0) : 0;
      this.parkedAt(e.icao).forEach((a, i) => {
        const cut = i < bays ? (HANGAR.weatherWearCut[level - 1] ?? 0) : 0;
        const wear = round2(DEMAND.stormWearPerDay * (1 - cut));
        if (wear <= 0) return;
        const systems = distributeWear(a.systems, { hours: wear, g: 0, overspeed: 0, crash: 0 });
        this.touchAircraft({ ...a, systems });
        this.event(a.id, "weather", { wear, event: e.id, hangar: cut > 0 });
      });
    }
  }

  private candidates(): EconomyAirport[] {
    if (!this.airports) return [];
    const extra = [...this.fbos.values()]
      .filter((f) => f.status === "active" || f.status === "building")
      .map((f) => f.icao)
      .sort();
    const key = `${this.company.base}|${extra.join(",")}`;
    if (this.candidateCache?.key !== key) {
      this.candidateCache = {
        key,
        list: eventCandidates(this.airports.get(this.company.base), this.airports.list, extra),
      };
    }
    return this.candidateCache.list;
  }

  /** Start of in-game day `d`: activity decays, old events are forgotten, the day's roll. */
  private demandDay(d: number): void {
    const t = d * GAME_DAY_MS;
    if (Object.keys(this.company.activity).length > 0) {
      this.company = { ...this.company, activity: decayActivity(this.company.activity) };
      this.pending.activity = true;
    }
    this.events = this.events.filter((e) => e.endGameMs > t - 30 * GAME_DAY_MS);
    const ev = rollDemandEvent(this.company.seed, d, this.candidates(), this.events);
    if (!ev) return;
    this.events.push(ev);
    this.pending.demandEvents.push(ev);
    this.notice("demand.event", {
      event: eventState(ev),
      name: this.airportOf(ev.icao)?.name ?? ev.icao,
    });
  }

  /** Month boundary: FBO upkeep and land leases, then hull insurance premiums. */
  private monthlyFbosAndInsurance(): void {
    const label = this.company.monthBilled + 1;
    for (const f of [...this.fbos.values()]) {
      if (f.status !== "active" && f.status !== "building") continue;
      const upkeep = this.fboUpkeep(f);
      if (upkeep <= 0) continue;
      this.post("fbo_upkeep", -upkeep, "fbo", f.id, `FBO ${f.icao} upkeep, month ${label}`);
      this.touchFbo(this.fboPnlAdd(this.fbos.get(f.id) ?? f, { upkeep }));
    }
    for (const a of this.activeFleet()) {
      if (!a.insurance || a.ownership !== "owned") continue;
      const premium = this.premiumFor(a);
      this.post(
        "insurance",
        -premium,
        "aircraft",
        a.id,
        `${a.registration} hull insurance, month ${label}`,
      );
      this.touchAircraft({ ...a, insurance: { ...a.insurance, premium } });
    }
  }

  // ---- own arrivals and AI traffic ----

  private ownArrival(
    f0: FboRecord,
    a: BookAircraft,
    savings: Array<{ kind: string; amount: number; memo: string }>,
    ref: string,
  ): void {
    let f = this.fbos.get(f0.id) ?? f0;
    const day = Math.floor(this.company.gameMs / GAME_DAY_MS);
    const total = round2(savings.reduce((s, x) => s + x.amount, 0));
    for (const x of savings) this.fboTx(f, x.kind, x.amount, "own", `${a.registration}: ${x.memo}`);
    let reputation = 0;
    if (f.modules.ramp.level >= RAMP.loungeMinLevel && f.loungeDay !== day) {
      reputation = RAMP.loungeReputation;
      this.adjustReputation(reputation);
      f = { ...f, loungeDay: day };
      this.fboTx(
        f,
        "crew_lounge",
        0,
        "own",
        `${a.registration}: crew lounge +${reputation} reputation`,
      );
    }
    f = this.fboPnlAdd(
      { ...f, today: { ...f.today, own: round2(f.today.own + total) } },
      { savings: total },
    );
    this.touchFbo(f);
    this.notice("fbo.income", {
      fboId: f.id,
      icao: f.icao,
      source: "own",
      aircraftId: a.id,
      registration: a.registration,
      ref,
      savings: total,
      reputation,
      items: savings.map((x) => ({ kind: x.kind, amount: x.amount })),
    });
  }

  /** Airports whose AI traffic the connector should watch (active FBOs). */
  aiTargets(): Array<{ fboId: string; icao: string; lat: number; lon: number }> {
    const out: Array<{ fboId: string; icao: string; lat: number; lon: number }> = [];
    for (const f of this.fbos.values()) {
      const airport = f.status === "active" ? this.airportOf(f.icao) : null;
      if (airport) out.push({ fboId: f.id, icao: f.icao, lat: airport.lat, lon: airport.lon });
    }
    return out.sort((x, y) => (x.icao < y.icao ? -1 : 1));
  }

  /**
   * An AI aircraft observed landing at an own FBO airport in the connected simulator: a
   * labelled bonus (source sim_ai) = ramp fee + handling at the player's price × elasticity
   * (+ 400 kg of fuel at the player's margin × elasticity with a fuel farm), turboprop class.
   */
  creditAiArrival(icao: string, objectId: number | string): BookResult<{ amount: number }> {
    const f = this.activeFboAt(icao);
    const airport = this.airportOf(icao);
    if (!f || !airport) return fail("unknown_fbo", `No operating FBO at ${icao}`);
    const levels = levelsOf(f);
    const ff = CLASS_FEE_FACTOR.turboprop;
    const ramp = Math.max(1, levels.ramp);
    let amount = RAMP.feeUsd * ff * (RAMP.levelFactor[ramp - 1] ?? 1);
    amount += f.handlingFeeUsd * ff * elasticity(f.handlingFeeUsd / REFERENCE_HANDLING_USD);
    if (levels.fuel > 0) {
      const p = fuelPricing(this.fuelPriceAt(airport).usdPerKg, f.fuelPriceRatio, levels.fuel);
      amount += AI_ARRIVAL.fuelKg * Math.max(0, p.price - p.cost) * elasticity(f.fuelPriceRatio);
    }
    amount = round2(amount);
    this.post(
      "fbo_income",
      amount,
      "fbo",
      f.id,
      `FBO ${f.icao}: AI arrival observed in the simulator (bonus, object ${objectId})`,
    );
    this.fboTx(f, "ai_arrival", amount, "sim_ai", `Simulator AI object ${objectId}`);
    const next = this.fboPnlAdd(
      {
        ...f,
        aiArrivals: f.aiArrivals + 1,
        today: { ...f.today, simAi: round2(f.today.simAi + amount) },
      },
      { income: amount },
    );
    this.touchFbo(next);
    this.notice("fbo.income", {
      fboId: f.id,
      icao: f.icao,
      source: "sim_ai",
      amount,
      objectId: String(objectId),
    });
    return { ok: true, data: { amount } };
  }

  // ---- demand ----

  /** Demand index at an airport now. */
  demandAt(icao: string): number {
    return demandIndex(icao, this.company.activity, this.events, this.company.gameMs);
  }

  /**
   * Board hooks for the job generator at `origin`: the payout factor per destination
   * (demand of origin and destination × own cargo terminal bonus, 2 decimals) and the
   * terminal's extra jobs.
   */
  jobDemand(origin: string): { demand: (dest: EconomyAirport) => number; extraJobs: number } {
    const oi = this.demandAt(origin);
    const level = this.activeFboAt(origin)?.modules.cargo.level ?? 0;
    const bonus = level > 0 ? (CARGO_TERMINAL.payoutBonus[level - 1] ?? 0) : 0;
    return {
      extraJobs: level > 0 ? (CARGO_TERMINAL.extraJobs[level - 1] ?? 0) : 0,
      demand: (dest) =>
        Math.round(demandFactor(oi, this.demandAt(dest.ident)) * (1 + bonus) * 100) / 100,
    };
  }

  /** A delivered mission: demand activity, delivery count and the landing streak. */
  recordDelivery(d: { origin: string; destination: string; grade: LandingGrade | null }): void {
    let activity = addActivity(this.company.activity, d.origin, DEMAND.departureActivity);
    activity = addActivity(activity, d.destination, DEMAND.deliveryActivity);
    const perfect = d.grade === "A+" || d.grade === "A";
    this.company = {
      ...this.company,
      activity,
      deliveries: this.company.deliveries + 1,
      landingStreak: perfect ? this.company.landingStreak + 1 : 0,
    };
    this.pending.activity = true;
    this.pending.company = true;
  }

  demandEventRecords(): DemandEventRecord[] {
    return [...this.events];
  }

  fboRecords(): FboRecord[] {
    return [...this.fbos.values()];
  }

  // ---- insurance ----

  private premiumFor(a: BookAircraft): number {
    return insurancePremium(this.aircraftValue(a), insuranceRisk(a.incidents, this.company.gameMs));
  }

  insuranceState(a: BookAircraft): InsuranceState {
    return {
      insured: a.insurance !== null,
      premiumMonthly: this.premiumFor(a),
      riskFactor: insuranceRisk(a.incidents, this.company.gameMs),
      coverageShare: INSURANCE.coverageShare,
      deductible: INSURANCE.deductible,
      ...(a.insurance ? { sinceGameMs: a.insurance.sinceGameMs } : {}),
      claims: a.insurance?.claims ?? 0,
      claimsPaid: a.insurance?.claimsPaid ?? 0,
      repairLoan: this.repairLoanView(a),
    };
  }

  /** Repair-loan terms, the bills an insurer would finance now, and the open loan. */
  private repairLoanView(a: BookAircraft): NonNullable<InsuranceState["repairLoan"]> {
    const bill = (kind: RepairKind): number | null => {
      const t = this.repairTarget(a.id, kind);
      return t.ok ? repairLoanBill(t.data.cost, t.data.claim) : null;
    };
    const open = this.openRepairLoan(a.id);
    return {
      apr: REPAIR_LOAN.apr,
      minTermMonths: REPAIR_LOAN.minTermMonths,
      maxTermMonths: REPAIR_LOAN.maxTermMonths,
      minAmount: REPAIR_LOAN.minAmount,
      overhaulBill: bill("overhaul"),
      allDefectsBill: bill("all"),
      open: open
        ? {
            loanId: open.id,
            balance: open.balance,
            payment: open.payment,
            missedCount: open.missedCount,
            nextDueGameMs: open.nextDueGameMs,
          }
        : null,
    };
  }

  /** Hull insurance on an owned aircraft: the first month's premium now. */
  buyInsurance(aircraftId: string): BookResult<{ premium: number }> {
    const a = this.aircraft(aircraftId);
    if (!a) return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
    if (a.status === "hired") return fail("aircraft_busy", busyMessage(a));
    if (a.ownership !== "owned") return fail("not_owned", "Only owned aircraft can be insured");
    if (a.insurance) return fail("already_insured", `${a.registration} is already insured`);
    const premium = this.premiumFor(a);
    if (this.company.cash < premium) {
      return fail("insufficient_cash", `The first premium is $${premium.toLocaleString("en-US")}`);
    }
    this.post(
      "insurance",
      -premium,
      "aircraft",
      a.id,
      `${a.registration} hull insurance, first month`,
    );
    this.touchAircraft({
      ...(this.fleet.get(a.id) ?? a),
      insurance: {
        sinceGameMs: Math.floor(this.company.gameMs),
        premium,
        claims: 0,
        claimsPaid: 0,
      },
    });
    this.event(a.id, "insured", { premium });
    return { ok: true, data: { premium } };
  }

  /** Cancel a policy (no refund of the month already paid). */
  cancelInsurance(aircraftId: string): BookResult<{ aircraftId: string }> {
    const a = this.aircraft(aircraftId);
    if (!a) return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
    if (a.status === "hired") return fail("aircraft_busy", busyMessage(a));
    if (!a.insurance) return fail("not_insured", `${a.registration} is not insured`);
    const open = this.openRepairLoan(a.id);
    if (open) {
      return fail(
        "repair_loan_open",
        `${a.registration} has an open insurer repair loan (${open.id}, $${open.balance.toLocaleString("en-US")}): pay it off before cancelling the policy`,
      );
    }
    this.touchAircraft({ ...a, insurance: null });
    this.event(a.id, "insurance.cancelled", {});
    return { ok: true, data: { aircraftId } };
  }

  /** An insured repair of incident defects (hard landing, crash): 80 % above $2,000. */
  /** Incident share of a repair (hard landing, crash defects) and the claim it would pay. */
  private incidentClaim(defects: readonly Defect[], shop: Shop): { cost: number; claim: number } {
    const claimable = defects.filter((d) => CLAIMABLE_CAUSES.has(d.cause));
    if (claimable.length === 0) return { cost: 0, claim: 0 };
    const cost = repairQuote(claimable, shop).cost;
    return { cost, claim: repairClaim(cost) };
  }

  private claimRepair(aircraftId: string, defects: readonly Defect[], shop: Shop): void {
    const a = this.fleet.get(aircraftId);
    if (!a?.insurance) return;
    const { cost, claim } = this.incidentClaim(defects, shop);
    if (claim <= 0) return;
    this.post(
      "insurance_claim",
      claim,
      "aircraft",
      a.id,
      `${a.registration} incident repair claim (80 % of $${cost.toLocaleString("en-US")} − $${INSURANCE.deductible.toLocaleString("en-US")})`,
    );
    this.touchAircraft({
      ...a,
      insurance: {
        ...a.insurance,
        claims: a.insurance.claims + 1,
        claimsPaid: round2(a.insurance.claimsPaid + claim),
      },
    });
    this.notice("insurance.claim", {
      aircraftId: a.id,
      registration: a.registration,
      kind: "repair",
      amount: claim,
      cost,
    });
  }

  /**
   * An insured write-off: 80 % of the hull value before the crash is paid, and a loan on
   * the aircraft is settled from it (fully when the payout covers the balance).
   */
  private settleWriteOff(a: BookAircraft, valueBefore: number): void {
    if (!a.insurance) return;
    const claim = writeOffClaim(valueBefore);
    this.post(
      "insurance_claim",
      claim,
      "aircraft",
      a.id,
      `${a.registration} hull write-off claim (80 % of $${valueBefore.toLocaleString("en-US")})`,
    );
    // The insurer nets its own repair loan off the payout first; the rest settles the bank
    // loan. A repair-loan remainder the payout does not cover is due at once (from cash).
    let left = claim;
    let repairLoanPaid = 0;
    const repairLoan = this.openRepairLoan(a.id);
    if (repairLoan) {
      repairLoanPaid = round2(Math.min(repairLoan.balance, left));
      left = round2(left - repairLoanPaid);
      if (repairLoanPaid > 0) {
        this.post(
          "repair_loan_payment",
          -repairLoanPaid,
          "loan",
          repairLoan.id,
          `Repair loan netted off the write-off claim for ${a.registration}`,
        );
      }
      const rest = round2(repairLoan.balance - repairLoanPaid);
      if (rest < 0.005) this.touchLoan({ ...repairLoan, balance: 0, status: "paid_off" });
      else this.callRepairLoan({ ...repairLoan, balance: rest }, "aircraft_written_off");
    }
    let loanPaid = 0;
    let loanId = a.loanId;
    const loan = a.loanId ? this.loans.get(a.loanId) : undefined;
    if (loan && loan.status === "active" && left > 0) {
      loanPaid = round2(Math.min(loan.balance, left));
      this.post(
        "loan_payment",
        -loanPaid,
        "loan",
        loan.id,
        `Settled from the insurance payout for ${a.registration}`,
      );
      const balance = round2(loan.balance - loanPaid);
      const cleared = balance < 0.005;
      this.touchLoan({
        ...loan,
        balance: cleared ? 0 : balance,
        status: cleared ? "paid_off" : "active",
      });
      if (cleared) loanId = null;
    }
    this.touchAircraft({
      ...a,
      loanId,
      insurance: {
        ...a.insurance,
        claims: a.insurance.claims + 1,
        claimsPaid: round2(a.insurance.claimsPaid + claim),
      },
    });
    this.notice("insurance.claim", {
      aircraftId: a.id,
      registration: a.registration,
      kind: "write_off",
      amount: claim,
      loanPaid,
      ...(repairLoan ? { repairLoanPaid } : {}),
    });
  }

  // ==== Hired pilots (simulated operations, plan §7.4) ====
  //
  // A hired pilot flies one owned aircraft origin → destination → origin … on the company
  // clock. Nothing here produces telemetry, logbook flights or landing grades: each leg is
  // booked when it completes (income, fuel, landing fee, wear) and the aircraft is
  // unavailable to the player (status "hired") until the pilot is unassigned.

  readonly pilots = new Map<string, HiredPilotRecord>();

  private touchPilot(p: HiredPilotRecord): void {
    this.pilots.set(p.id, p);
    const i = this.pending.pilots.findIndex((x) => x.id === p.id);
    if (i >= 0) this.pending.pilots[i] = p;
    else this.pending.pilots.push(p);
    this.pending.company = true;
  }

  /** Pilots on the payroll, in hiring order. */
  activePilots(): HiredPilotRecord[] {
    return [...this.pilots.values()]
      .filter((p) => p.status === "hired")
      .sort((a, b) => a.hiredGameMs - b.hiredGameMs || pilotOrder(a.id) - pilotOrder(b.id));
  }

  private hiredPilot(pilotId: string): BookResult<HiredPilotRecord> {
    const p = this.pilots.get(pilotId);
    if (!p || p.status !== "hired") return fail("unknown_pilot", `No hired pilot ${pilotId}`);
    return { ok: true, data: p };
  }

  /** The pilot flying an aircraft, if any. */
  pilotOf(aircraftId: string): HiredPilotRecord | null {
    return this.activePilots().find((p) => p.assignment?.aircraftId === aircraftId) ?? null;
  }

  /**
   * Hire a pilot: the rest of this in-game month's wage is paid now, pro-rated by the time
   * left in the month (`firstMonthWage`); no refund when fired.
   */
  hirePilot(rating: PilotRating): BookResult<{ pilot: HiredPilotRecord }> {
    if (this.activePilots().length >= HIRED_PILOTS.maxPilots) {
      return fail("pilot_limit", `At most ${HIRED_PILOTS.maxPilots} hired pilots`);
    }
    const wage = pilotWage(rating);
    const first = firstMonthWage(wage, this.company.gameMs);
    if (this.company.cash < first) {
      return fail(
        "insufficient_cash",
        `The first (pro-rated) month's wage is $${first.toLocaleString("en-US")}`,
      );
    }
    const n = (this.company.pilotCounter ?? 0) + 1;
    this.company = { ...this.company, pilotCounter: n };
    const id = `HP-${n}`;
    const name = pilotName(this.company.seed, n);
    this.post(
      "pilot_wage",
      -first,
      "pilot",
      id,
      `${name} (hired pilot) wage, rest of month ${gameMonthIndex(this.company.gameMs) + 1}`,
    );
    const pilot: HiredPilotRecord = {
      id,
      name,
      rating,
      wageMonthly: wage,
      status: "hired",
      hiredGameMs: Math.floor(this.company.gameMs),
      hiredAt: this.now(),
      firedGameMs: null,
      assignment: null,
      stopped: null,
      legsFlown: 0,
      pnl: addPilotPnl([], gameMonthIndex(this.company.gameMs), { wages: first }),
      recent: [],
    };
    this.touchPilot(pilot);
    return { ok: true, data: { pilot } };
  }

  /** Let a pilot go: an assigned aircraft is released where it is; wages stop. */
  firePilot(pilotId: string): BookResult<{ pilotId: string }> {
    const r = this.hiredPilot(pilotId);
    if (!r.ok) return r;
    let p = r.data;
    if (p.assignment) {
      this.releaseAircraft(p, "pilot.fired", null);
      p = { ...p, assignment: null };
    }
    this.touchPilot({ ...p, status: "fired", firedGameMs: Math.floor(this.company.gameMs) });
    return { ok: true, data: { pilotId } };
  }

  /** Airports the company serves: base, fleet locations, FBOs, recent activity, `extra`. */
  servedAirports(extra: readonly string[] = []): string[] {
    const set = new Set<string>([this.company.base, ...extra.map((x) => x.toUpperCase())]);
    for (const a of this.activeFleet()) set.add(a.location);
    for (const f of this.fbos.values()) {
      if (f.status === "active" || f.status === "building") set.add(f.icao);
    }
    for (const icao of Object.keys(this.company.activity)) set.add(icao);
    for (const p of this.activePilots()) {
      if (p.assignment) {
        set.add(p.assignment.origin);
        set.add(p.assignment.destination);
      }
    }
    return [...set].filter((i) => !this.airports || this.airports.get(i) !== undefined).sort();
  }

  /** A route the type can fly both ways: 20 nm to 80 % of range, runways, a payload. */
  private routeCheck(
    type: AircraftType,
    origin: EconomyAirport,
    dest: EconomyAirport,
  ): BookResult<{ distanceNm: number }> {
    const distanceNm = round1(greatCircleNm(origin, dest));
    if (distanceNm < MIN_JOB_NM) {
      return fail("route_too_short", `${origin.ident}–${dest.ident} is under ${MIN_JOB_NM} nm`);
    }
    if (distanceNm > maxJobDistanceNm(type)) {
      return fail(
        "out_of_range",
        `${distanceNm} nm is beyond 80 % of the ${type.name}'s ${type.rangeNm} nm range`,
      );
    }
    for (const end of [origin, dest]) {
      const rwy = runwaySuitability(end, type);
      if (!rwy.ok) {
        return fail(
          "runway_unsuitable",
          `${end.ident} runway does not suit the ${type.name} (${rwy.issues.join(", ")})`,
        );
      }
    }
    if (payloadLimitKg(type, distanceNm) < 50) {
      return fail("payload_too_low", `The ${type.name} carries no useful load that far`);
    }
    return { ok: true, data: { distanceNm } };
  }

  /**
   * Assign a pilot to an owned, available, airworthy aircraft on a route from where it is
   * parked to a served airport. The first leg departs at the next duty-window time.
   */
  assignPilot(args: {
    pilotId: string;
    aircraftId: string;
    origin?: string;
    destination: string;
    served?: readonly string[];
  }): BookResult<{ pilot: HiredPilotRecord }> {
    const r = this.hiredPilot(args.pilotId);
    if (!r.ok) return r;
    const p = r.data;
    if (p.assignment) {
      return fail("pilot_assigned", `${p.name} already flies a route: unassign first`);
    }
    const a0 = this.aircraft(args.aircraftId);
    if (!a0) return fail("unknown_aircraft", `No aircraft ${args.aircraftId} in the fleet`);
    if (a0.ownership !== "owned") {
      return fail("not_owned", "Hired pilots fly owned aircraft only (not leased ones)");
    }
    if (a0.status === "maintenance") {
      return fail("aircraft_in_maintenance", `${a0.registration} is in maintenance`);
    }
    if (a0.status !== "available") return fail("aircraft_busy", busyMessage(a0));
    if (a0.ferryPermit) {
      return fail("ferry_only", `${a0.registration} holds a ferry permit: fly the ferry first`);
    }
    const type = aircraftTypeByKey(a0.typeKey);
    if (!type) return fail("unknown_type", a0.typeKey);
    if (ratingFor(type.category) !== p.rating) {
      return fail(
        "rating_mismatch",
        `${p.name} holds a ${p.rating} rating; the ${type.name} needs ${ratingFor(type.category) ?? "another"}`,
      );
    }
    const gate = this.dispatchCheck(a0.id);
    if (!gate.ok) return gate;
    const a = this.fleet.get(a0.id) ?? a0;
    const originId = (args.origin ?? a.location).toUpperCase();
    if (originId !== a.location) {
      return fail(
        "aircraft_not_at_origin",
        `${a.registration} is parked at ${a.location}: the route starts there`,
      );
    }
    const destId = args.destination.toUpperCase();
    if (destId === originId) return fail("same_airport", "The route needs two airports");
    if (!this.servedAirports(args.served ?? []).includes(destId)) {
      return fail(
        "airport_not_served",
        `${destId} is not an airport the company serves (base, fleet, FBOs, boards, recent deliveries)`,
      );
    }
    const origin = this.airportOf(originId);
    const dest = this.airportOf(destId);
    if (!origin || !dest) return fail("unknown_airport", `Unknown airport ${destId}`);
    const route = this.routeCheck(type, origin, dest);
    if (!route.ok) return route;
    const now = Math.floor(this.company.gameMs);
    const pilot: HiredPilotRecord = {
      ...p,
      stopped: null,
      assignment: {
        aircraftId: a.id,
        origin: originId,
        destination: destId,
        sinceGameMs: now,
        legs: 0,
        nextDepartureGameMs: nextDutyDeparture(now),
        leg: null,
      },
    };
    this.touchAircraft({ ...a, status: "hired" });
    this.event(a.id, "pilot.assigned", {
      pilotId: p.id,
      origin: originId,
      destination: destId,
      simulated: true,
    });
    this.touchPilot(pilot);
    return { ok: true, data: { pilot } };
  }

  /**
   * Take a pilot off the route: the aircraft is available again where it is parked. A leg
   * in progress is cancelled (the aircraft stays at the leg's departure airport; nothing is
   * booked for it).
   */
  unassignPilot(pilotId: string): BookResult<{ pilot: HiredPilotRecord }> {
    const r = this.hiredPilot(pilotId);
    if (!r.ok) return r;
    if (!r.data.assignment) return fail("not_assigned", `${r.data.name} has no route`);
    this.releaseAircraft(r.data, "pilot.unassigned", null);
    const pilot = { ...r.data, assignment: null };
    this.touchPilot(pilot);
    return { ok: true, data: { pilot } };
  }

  private releaseAircraft(
    p: HiredPilotRecord,
    kind: string,
    reason: { code: string; message: string } | null,
  ): void {
    const as = p.assignment;
    if (!as) return;
    const a = this.fleet.get(as.aircraftId);
    if (a && a.status === "hired") this.touchAircraft({ ...a, status: "available" });
    if (a) {
      this.event(a.id, kind, {
        pilotId: p.id,
        legs: as.legs,
        ...(as.leg ? { cancelledLeg: { from: as.leg.from, to: as.leg.to } } : {}),
        ...(reason ? { reason } : {}),
        simulated: true,
      });
    }
  }

  /** The route stops (grounded aircraft, defect found, aircraft gone): the pilot stays hired. */
  private stopRoute(
    p: HiredPilotRecord,
    code: string,
    message: string,
    reasons?: Reason[],
  ): HiredPilotRecord {
    const a = p.assignment ? this.fleet.get(p.assignment.aircraftId) : undefined;
    this.releaseAircraft(p, "pilot.route_stopped", { code, message });
    const next: HiredPilotRecord = {
      ...p,
      assignment: null,
      stopped: { code, message, gameMs: Math.floor(this.company.gameMs) },
    };
    this.touchPilot(next);
    this.notice("pilot.route_stopped", {
      pilotId: p.id,
      name: p.name,
      ...(a ? { aircraftId: a.id, registration: a.registration } : {}),
      code,
      message,
      ...(reasons?.length ? { reasons } : {}),
      simulated: true,
    });
    return next;
  }

  /** Legs that arrive and depart at `t` (called in time order by `advance`). */
  private processPilots(t: number): void {
    for (const p0 of this.activePilots()) {
      let p = p0;
      for (let guard = 0; guard < 8 && p.assignment; guard++) {
        const as: NonNullable<HiredPilotRecord["assignment"]> = p.assignment;
        const a = this.fleet.get(as.aircraftId);
        if (!a || a.status !== "hired") {
          p = this.stopRoute(
            p,
            "aircraft_unavailable",
            `${a?.registration ?? as.aircraftId} is no longer available to the pilot`,
          );
          break;
        }
        if (as.leg) {
          if (as.leg.arriveGameMs > t) break;
          p = this.pilotArrive(p, a, as.leg);
        } else {
          if (as.nextDepartureGameMs > t) break;
          p = this.pilotDepart(p, a, t);
        }
      }
    }
  }

  private pilotDepart(p: HiredPilotRecord, a0: BookAircraft, t: number): HiredPilotRecord {
    const as = p.assignment;
    if (!as) return p;
    // Same dispatch rule as the player's: hidden defects surface, then the gate runs.
    this.revealHidden(a0.id, "dispatch");
    const a = this.fleet.get(a0.id) ?? a0;
    const g = this.gate(a);
    if (!g.ok) {
      return this.stopRoute(
        p,
        "aircraft_unairworthy",
        `${a.registration} is not airworthy: ${g.reasons.map((x) => x.message).join("; ")}`,
        g.reasons.map((x) => ({ code: x.code, message: x.message })),
      );
    }
    const to =
      a.location === as.origin ? as.destination : a.location === as.destination ? as.origin : null;
    const type = aircraftTypeByKey(a.typeKey);
    const from = this.airportOf(a.location);
    const dest = to ? this.airportOf(to) : null;
    if (!to || !type || !from || !dest) {
      return this.stopRoute(
        p,
        "off_route",
        `${a.registration} is at ${a.location}, not on the route ${as.origin}–${as.destination}`,
      );
    }
    const times = legTimes(type, round1(greatCircleNm(from, dest)));
    const next: HiredPilotRecord = {
      ...p,
      assignment: {
        ...as,
        leg: {
          from: a.location,
          to,
          departGameMs: Math.floor(t),
          arriveGameMs: Math.floor(t) + times.blockMin * 60_000,
        },
      },
    };
    this.touchPilot(next);
    return next;
  }

  private pilotArrive(
    p: HiredPilotRecord,
    a: BookAircraft,
    leg: NonNullable<NonNullable<HiredPilotRecord["assignment"]>["leg"]>,
  ): HiredPilotRecord {
    const as = p.assignment;
    const type = aircraftTypeByKey(a.typeKey);
    const from = this.airportOf(leg.from);
    const dest = this.airportOf(leg.to);
    if (!as || !type || !from || !dest) {
      return this.stopRoute(p, "off_route", `Unknown route ${leg.from}–${leg.to}`);
    }
    const n = p.legsFlown + 1;
    const distanceNm = round1(greatCircleNm(from, dest));
    const times = legTimes(type, distanceNm);
    const inc = legIncome({
      type,
      distanceNm,
      reputation: this.company.reputation,
      share: legLoadShare(this.company.seed, p.id, n),
      payloadPenaltyPct: this.gate(a).payloadPenaltyPct,
    });
    const memo = `Hired pilot ${p.name} (simulated) ${a.registration} ${leg.from}→${leg.to}`;
    if (inc.income > 0) {
      this.post("hired_income", inc.income, "pilot", p.id, `${memo}, ${inc.loadKg} kg`);
    }
    const settled = this.settleFlight(a.id, {
      fuelKg: legFuelBurnKg(type, times.blockMin),
      fuelAirport: dest,
      landingAirport: dest,
      blockMin: times.blockMin,
      airborneMin: times.airborneMin,
      peakG: null,
      overspeedEvents: 0,
      crashed: false,
      landings: 1,
      refType: "pilot",
      refId: p.id,
      memo,
      hired: true,
    });
    if (!settled.ok) return this.stopRoute(p, settled.code, settled.message);
    const s = settled.data;
    const fuel = s.costs.find((c) => c.key === "fuel")?.amount ?? 0;
    const fee = s.costs.find((c) => c.key === "landing_fee")?.amount ?? 0;
    const wear = s.wear.total;
    const wearValue = repairCost(type, 100 - wear);
    const record: PilotLeg = {
      n,
      aircraftId: a.id,
      registration: a.registration,
      from: leg.from,
      to: leg.to,
      departGameMs: leg.departGameMs,
      arriveGameMs: leg.arriveGameMs,
      distanceNm,
      loadKg: inc.loadKg,
      boardPayout: inc.boardPayout,
      income: inc.income,
      fuel,
      landingFee: fee,
      wear,
      defects: s.defects.length,
    };
    let next: HiredPilotRecord = {
      ...p,
      legsFlown: n,
      recent: [record, ...p.recent].slice(0, HIRED_PILOTS.recentLegs),
      pnl: addPilotPnl(p.pnl, gameMonthIndex(this.company.gameMs), {
        income: inc.income,
        fuel,
        fees: fee,
        legs: 1,
        wear,
        wearValue,
      }),
      assignment: {
        ...as,
        legs: as.legs + 1,
        leg: null,
        nextDepartureGameMs: nextDutyDeparture(
          leg.arriveGameMs + HIRED_PILOTS.turnaroundMin * 60_000,
        ),
      },
    };
    this.touchPilot(next);
    // A defect found on the leg that grounds the aircraft stops the route at once.
    const after = this.fleet.get(a.id);
    const g = after ? this.gate(after) : null;
    if (g && !g.ok) {
      next = this.stopRoute(
        next,
        "aircraft_grounded",
        `${a.registration} was grounded after a hired leg: ${g.reasons.map((x) => x.message).join("; ")}`,
        g.reasons.map((x) => ({ code: x.code, message: x.message })),
      );
    }
    return next;
  }

  /** Month boundary: every hired pilot's wage for the coming month (cash may go negative). */
  private monthlyPilots(): void {
    const label = this.company.monthBilled + 1;
    for (const p of this.activePilots()) {
      this.post("pilot_wage", -p.wageMonthly, "pilot", p.id, `${p.name} wage, month ${label}`);
      const cur = this.pilots.get(p.id) ?? p;
      this.touchPilot({
        ...cur,
        pnl: addPilotPnl(cur.pnl, gameMonthIndex(this.company.gameMs), { wages: p.wageMonthly }),
      });
    }
  }

  private pilotState(p: HiredPilotRecord): HiredPilot {
    const as = p.assignment;
    const a = as ? this.fleet.get(as.aircraftId) : undefined;
    const type = a ? aircraftTypeByKey(a.typeKey) : null;
    const o = as ? this.airportOf(as.origin) : null;
    const d = as ? this.airportOf(as.destination) : null;
    return {
      id: p.id,
      name: p.name,
      rating: p.rating,
      wageMonthly: p.wageMonthly,
      hiredGameMs: p.hiredGameMs,
      status: p.status === "fired" ? "fired" : !as ? "unassigned" : as.leg ? "flying" : "scheduled",
      ...(p.firedGameMs !== null ? { firedGameMs: p.firedGameMs } : {}),
      assignment: as
        ? {
            aircraftId: as.aircraftId,
            registration: a?.registration ?? as.aircraftId,
            typeName: type?.name ?? a?.typeKey ?? "",
            origin: as.origin,
            destination: as.destination,
            distanceNm: o && d ? round1(greatCircleNm(o, d)) : 0,
            sinceGameMs: as.sinceGameMs,
            legs: as.legs,
            ...(as.leg ? { leg: as.leg } : { nextDepartureGameMs: as.nextDepartureGameMs }),
          }
        : null,
      ...(p.stopped ? { stopped: p.stopped } : {}),
      legsFlown: p.legsFlown,
      pnl: p.pnl.slice(-12),
      recent: p.recent.slice(0, HIRED_PILOTS.recentLegs),
      simulated: true,
    };
  }

  /** `pilots` domain; `extra` adds served airports the book does not know (board origins). */
  pilotsDomain(extra: readonly string[] = []): PilotsState {
    const served = this.servedAirports(extra);
    const month = gameMonthIndex(this.company.gameMs);
    // Hired pilots, then pilots let go who still have a P&L row this month (shown as fired).
    const pilots = [
      ...this.activePilots(),
      ...this.pilotRecords().filter(
        (p) => p.status === "fired" && p.pnl.some((m) => m.month === month),
      ),
    ];
    // This month's totals over every pilot record (a pilot let go keeps the wage paid).
    let monthIncome = 0;
    let monthCosts = 0;
    for (const p of this.pilots.values()) {
      const row = p.pnl.find((m) => m.month === month);
      monthIncome += row?.income ?? 0;
      monthCosts += (row?.wages ?? 0) + (row?.fuel ?? 0) + (row?.fees ?? 0);
    }
    const options: PilotsState["options"] = [];
    for (const a of this.activeFleet()) {
      if (a.ownership !== "owned" || a.status !== "available" || a.ferryPermit) continue;
      const type = aircraftTypeByKey(a.typeKey);
      const rating = type ? ratingFor(type.category) : null;
      const origin = this.airportOf(a.location);
      if (!type || !rating || !origin || !this.gate(a).ok) continue;
      const destinations: PilotsState["options"][number]["destinations"] = [];
      for (const icao of served) {
        const dest = icao === a.location ? null : this.airportOf(icao);
        if (!dest) continue;
        const route = this.routeCheck(type, origin, dest);
        if (!route.ok) continue;
        const nm = route.data.distanceNm;
        const times = legTimes(type, nm);
        const inc = legIncome({
          type,
          distanceNm: nm,
          reputation: this.company.reputation,
          share: AVERAGE_LOAD_SHARE,
        });
        const costs = round2(
          fuelCost(legFuelBurnKg(type, times.blockMin), this.fuelPriceAt(dest)) +
            landingFee(dest, type),
        );
        destinations.push({
          icao,
          distanceNm: nm,
          blockMin: times.blockMin,
          boardPayout: inc.boardPayout,
          income: inc.income,
          costs,
        });
      }
      options.push({
        aircraftId: a.id,
        registration: a.registration,
        typeName: type.name,
        rating,
        origin: a.location,
        destinations,
      });
    }
    return {
      simulated: true,
      pilots: pilots.map((p) => this.pilotState(p)),
      servedAirports: served,
      options,
      wages: { ...HIRED_PILOTS.wages },
      payoutShare: HIRED_PILOTS.payoutShare,
      maxPilots: HIRED_PILOTS.maxPilots,
      monthIncome: round2(monthIncome),
      monthCosts: round2(monthCosts),
    };
  }

  /** Every pilot record (persistence and export). */
  pilotRecords(): HiredPilotRecord[] {
    return [...this.pilots.values()].sort((a, b) => pilotOrder(a.id) - pilotOrder(b.id));
  }

  // ---- milestones ----

  /** Mark milestones reached since the last check (called by `drain`). */
  checkMilestones(): void {
    const have = new Set<MilestoneId>(this.company.milestones.map((m) => m.id));
    const owned = [...this.fbos.values()].filter(
      (f) => f.status === "active" || f.status === "building",
    ).length;
    const loans = [...this.loans.values()];
    const reached: Record<MilestoneId, boolean> = {
      first_delivery: this.company.deliveries >= 1,
      hours_100: this.company.flightHours >= MILESTONES.hours,
      first_fbo: this.fbos.size > 0,
      debt_free: loans.length > 0 && loans.every((l) => l.status === "paid_off"),
      landing_streak: this.company.landingStreak >= MILESTONES.streak,
      first_restoration: this.company.restorations >= 1,
      fleet_three: this.activeFleet().length >= MILESTONES.fleet,
      fbo_network: owned >= MILESTONES.fboNetwork,
    };
    const fresh: MilestoneRecord[] = [];
    for (const id of MILESTONE_IDS) {
      if (have.has(id) || !reached[id]) continue;
      fresh.push({ id, gameMs: Math.floor(this.company.gameMs), at: this.now() });
    }
    if (fresh.length === 0) return;
    this.company = { ...this.company, milestones: [...this.company.milestones, ...fresh] };
    this.pending.company = true;
    for (const m of fresh) {
      this.pending.milestones.push(m);
      const view = milestoneList([m]).find((x) => x.id === m.id);
      this.notice("milestone.reached", { id: m.id, title: view?.title ?? m.id, gameMs: m.gameMs });
    }
  }

  // ---- domains ----

  fboState(f: FboRecord): FboState {
    const airport = this.airportOf(f.icao);
    const s = airport ? airportSize(airport).s : 0;
    const regional = airport ? this.fuelPriceAt(airport).usdPerKg : 0;
    const levels = levelsOf(f);
    const fp = fuelPricing(regional, f.fuelPriceRatio, levels.fuel);
    const bays = levels.hangar > 0 ? (HANGAR.bays[levels.hangar - 1] ?? 0) : 0;
    const owned = Math.min(bays, this.parkedAt(f.icao).length);
    const rented = Math.min(f.rented, Math.max(0, bays - owned));
    const queue: FboState["queue"] = [];
    if (f.status === "building" && f.readyAtGameMs !== null) {
      queue.push({
        kind: "construction",
        label: "FBO construction",
        readyAtGameMs: f.readyAtGameMs,
      });
    }
    for (const k of FBO_MODULE_KINDS) {
      const p = f.modules[k].pending;
      if (p) {
        queue.push({
          kind: "module",
          module: k,
          toLevel: p.toLevel,
          label: `${FBO_MODULE_LABELS[k]} level ${p.toLevel}`,
          readyAtGameMs: p.readyAtGameMs,
        });
      }
    }
    queue.sort((x, y) => x.readyAtGameMs - y.readyAtGameMs);
    const loan = f.loanId ? this.loans.get(f.loanId) : undefined;
    const financed = loan?.status === "active";
    return {
      id: f.id,
      icao: f.icao,
      name: airport?.name ?? f.icao,
      airportType: airport?.type ?? "medium",
      lat: airport?.lat ?? 0,
      lon: airport?.lon ?? 0,
      status: f.status === "building" ? "building" : "active",
      origin: f.origin,
      acquiredGameMs: f.acquiredGameMs,
      ...(f.readyAtGameMs !== null ? { readyAtGameMs: f.readyAtGameMs } : {}),
      price: f.price,
      invested: f.invested,
      value: fboValue(f.invested),
      financed,
      ...(financed && f.loanId ? { loanId: f.loanId } : {}),
      landLeaseMonthly: f.landLeaseMonthly,
      upkeepMonthly: this.fboUpkeep(f),
      sizeFactor: s,
      movementsPerDay: movementsPerDay(s),
      modules: FBO_MODULE_KINDS.map((k) => {
        const m = f.modules[k];
        const next = m.level < 3 ? m.level + 1 : null;
        return {
          kind: k,
          label: FBO_MODULE_LABELS[k],
          level: m.level,
          upkeepMonthly: moduleUpkeep(k, m.level, s),
          nextCost: next ? moduleCost(k, next, s) : null,
          nextDays: next ? moduleDays(k, next) : null,
          ...(m.pending ? { pending: m.pending } : {}),
          effect: moduleEffect(k, m.level),
        };
      }),
      pricing: {
        fuelPriceRatio: f.fuelPriceRatio,
        fuelUsdPerKg: fp.price,
        regionalUsdPerKg: regional,
        costUsdPerKg: fp.cost,
        handlingFeeUsd: f.handlingFeeUsd,
        referenceHandlingUsd: REFERENCE_HANDLING_USD,
        fuelDemand: elasticity(f.fuelPriceRatio),
        handlingDemand: elasticity(f.handlingFeeUsd / REFERENCE_HANDLING_USD),
      },
      occupancy: {
        bays,
        owned,
        rented,
        ratio: bays > 0 ? Math.round(((owned + rented) / bays) * 1000) / 1000 : 0,
      },
      today: {
        own: f.today.own,
        modelled: f.today.modelled,
        simAi: f.today.simAi,
        movements: f.today.movements,
      },
      daily: f.daily.slice(-30),
      pnl: f.pnl.slice(-12),
      queue,
      aiArrivals: f.aiArrivals,
    };
  }

  fbosDomain(): FbosState {
    const month = gameMonthIndex(this.company.gameMs);
    const fbos = [...this.fbos.values()]
      .filter((f) => f.status === "active" || f.status === "building")
      .sort((a, b) => a.acquiredGameMs - b.acquiredGameMs || (a.id < b.id ? -1 : 1));
    let monthIncome = 0;
    let monthUpkeep = 0;
    for (const f of fbos) {
      const row = f.pnl.find((m) => m.month === month);
      monthIncome += row?.income ?? 0;
      monthUpkeep += row?.upkeep ?? 0;
    }
    return {
      fbos: fbos.map((f) => this.fboState(f)),
      monthIncome: round2(monthIncome),
      monthUpkeep: round2(monthUpkeep),
      value: this.fboTotalValue(),
    };
  }

  demandDomain(): DemandState {
    const t = this.company.gameMs;
    const active = this.events
      .filter((e) => e.startGameMs <= t && t < e.endGameMs)
      .sort((a, b) => a.startGameMs - b.startGameMs || (a.id < b.id ? -1 : 1));
    const idents = new Set([...Object.keys(this.company.activity), ...active.map((e) => e.icao)]);
    const indices = [...idents].sort().map((icao) => {
      const e = activeEvent(icao, this.events, t);
      return {
        icao,
        index: this.demandAt(icao),
        activity: this.company.activity[icao] ?? 0,
        ...(e ? { eventId: e.id } : {}),
      };
    });
    return { indices, events: active.map(eventState) };
  }
}

const INSPECTION_MS = INSPECTION_HOURS * 3_600_000;

function pilotOrder(id: string): number {
  return Number(id.split("-").at(-1)) || 0;
}

function listingOrder(id: string): number {
  return Number(id.split("-").at(-1)) || 0;
}

export function leaseMonthlyFee(type: AircraftType): number {
  return round2(type.priceUsd * LEASE_MONTHLY_SHARE);
}

function emptyChanges(): BookChanges {
  return {
    company: false,
    ledger: [],
    aircraft: [],
    loans: [],
    events: [],
    notices: [],
    listings: [],
    fbos: [],
    fboTransactions: [],
    demandEvents: [],
    activity: false,
    milestones: [],
    pilots: [],
  };
}

/** Display name of a loan's lender (the insurer for repair loans). */
export function loanLenderName(l: Pick<BookLoan, "kind" | "lenderId">): string {
  if (isRepairLoan(l)) return REPAIR_LOAN.lenderName;
  return lenderById(l.lenderId)?.name ?? l.lenderId;
}

export function loanState(l: BookLoan): LoanState {
  return {
    id: l.id,
    lenderId: l.lenderId,
    lenderName: loanLenderName(l),
    principal: l.principal,
    apr: l.apr,
    termMonths: l.termMonths,
    payment: l.payment,
    balance: l.balance,
    collateral: l.collateral,
    nextDueGameMs: l.nextDueGameMs,
    missedCount: l.missedCount,
    paymentsMade: l.paymentsMade,
    status: l.status,
    takenAt: new Date(l.takenAt).toISOString(),
    takenGameMs: l.takenGameMs,
    ...(l.kind ? { kind: l.kind } : {}),
    ...(l.orderId ? { orderId: l.orderId } : {}),
  };
}

export function ledgerState(e: BookLedgerEntry): LedgerEntryState {
  return {
    at: new Date(e.at).toISOString(),
    gameMs: e.gameMs,
    category: e.category,
    amount: e.amount,
    balance: e.balance,
    refType: e.refType,
    refId: e.refId,
    memo: e.memo,
  };
}

/** Fresh company core fields (merged into a new company record). */
export function newCompanyCore(
  startingCash: number,
): Omit<CompanyCore, "name" | "base" | "seed" | "cash" | "reputation"> & { pilotCounter: number } {
  return {
    startingCash,
    gameMs: 0,
    monthBilled: 0,
    defaultUntilGameMs: null,
    fleetCounter: 0,
    loanCounter: 0,
    selectedAircraftId: null,
    pnl: [],
    ledgerCount: 0,
    marketGeneration: 0,
    marketRefreshedGameMs: 0,
    orderCounter: 0,
    fboCounter: 0,
    dayProcessed: 0,
    activity: {},
    flightHours: 0,
    deliveries: 0,
    landingStreak: 0,
    restorations: 0,
    milestones: [],
    pilotCounter: 0,
  };
}
