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
  LoanQuote,
  LoanState,
  LoansState,
  Ownership,
  AircraftStatus,
  PnlMonth,
} from "../../protocol/src/company";
import type { CompanyState, MissionCost } from "../../protocol/src/economy";
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
import { companyClock, gameMonthIndex } from "./clock";
import {
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
import { fuelCost, fuelPrice, landingFee } from "./costs";
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
import { round2 } from "./geo";
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
}

const P5_KEYS = [
  "ageYears",
  "systems",
  "defects",
  "annual",
  "ferryPermit",
  "orders",
  "defectCounter",
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
const CAPITAL: ReadonlySet<LedgerCategory> = new Set<LedgerCategory>([
  "loan_disbursement",
  "loan_payment",
  "purchase",
  "sale",
]);

/** Fuel at or below max(1 lb, 0.5 % of the fuel at block-out) means the tanks ran dry. */
export function tanksDryThresholdLb(fuelAtStartLb: number): number {
  return Math.max(TANKS_DRY_MIN_LB, TANKS_DRY_SHARE * Math.max(0, fuelAtStartLb));
}

const ACTIVE: ReadonlySet<AircraftStatus> = new Set<AircraftStatus>([
  "available",
  "in_flight",
  "maintenance",
]);

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
  /** Where maintenance is available (default: large airports; the FBO lane extends it). */
  maintenance?: MaintenanceCapability;
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
  readonly maintenance: MaintenanceCapability;

  constructor(options: BookOptions<C>) {
    this.company = {
      ...options.company,
      marketGeneration: options.company.marketGeneration ?? 0,
      marketRefreshedGameMs: options.company.marketRefreshedGameMs ?? 0,
      orderCounter: options.company.orderCounter ?? 0,
    };
    for (const a of options.fleet ?? []) {
      this.fleet.set(a.id, normalizeAircraft(a, this.company.gameMs));
    }
    for (const l of options.loans ?? []) this.loans.set(l.id, { ...l });
    for (const l of options.market ?? []) if (l.status === "listed") this.listings.set(l.id, l);
    this.recent = [...(options.recent ?? [])].slice(0, 20);
    this.airports = options.airports;
    this.now = options.now;
    this.maintenance = options.maintenance ?? largeAirportMaintenance(options.airports);
  }

  /** Changes since the last drain (to persist), then reset. */
  drain(): BookChanges {
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
      p.listings.length > 0
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

  netWorth(): number {
    return round2(this.company.cash + this.fleetValue() - this.debt());
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
      assets: Math.max(0, this.company.cash) + this.fleetValue(),
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
    return next;
  }

  private processDue(t: number): void {
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
    }
    // Loan auto-debits.
    for (const loan of this.activeLoans()) {
      if (loan.nextDueGameMs <= t) this.debitLoan(loan);
    }
  }

  private debitLoan(loan: BookLoan): void {
    const lender = lenderById(loan.lenderId);
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
          `${lender?.name ?? loan.lenderId} interest`,
        );
      this.post(
        "loan_payment",
        -principal,
        "loan",
        loan.id,
        `${lender?.name ?? loan.lenderId} principal`,
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
      if (paid.status === "paid_off") this.releaseCollateral(paid);
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
    this.post("late_fee", -fee, "loan", loan.id, `${lender?.name ?? loan.lenderId} late fee`);
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
    });
    if (missed.missedCount >= REPOSSESS_AFTER_MISSES) this.repossess(missed);
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
        if (this.company.selectedAircraftId === a.id) {
          this.company = { ...this.company, selectedAircraftId: null };
        }
      }
    }
    this.notice("aircraft.repossessed", {
      loanId: loan.id,
      collateral: loan.collateral,
      balanceWrittenOff: loan.balance,
    });
  }

  private releaseCollateral(loan: BookLoan): void {
    if (loan.collateral.type !== "aircraft") return;
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

  sell(aircraftId: string): BookResult<{ price: number; loanPaid: number }> {
    const a = this.aircraft(aircraftId);
    if (!a) return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
    if (a.ownership !== "owned") return fail("not_owned", "Leased aircraft are returned, not sold");
    if (a.status !== "available") return fail("aircraft_busy", `${a.registration} is ${a.status}`);
    const type = aircraftTypeByKey(a.typeKey);
    if (!type) return fail("unknown_type", a.typeKey);
    // Resale uses the used-market value (P4 value for a new airframe) × 90 %.
    const price = round2(this.aircraftValue(a) * SALE_SHARE);
    const loan = a.loanId ? this.loans.get(a.loanId) : undefined;
    const owed = loan && loan.status === "active" ? loan.balance : 0;
    if (owed > price) {
      return fail(
        "underwater",
        `The sale ($${price.toLocaleString("en-US")}) does not cover the loan balance ($${owed.toLocaleString("en-US")})`,
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
    this.touchAircraft({ ...a, status: "sold", loanId: null });
    this.event(a.id, "sold", { price, loanPaid: owed });
    if (this.company.selectedAircraftId === a.id) {
      this.company = { ...this.company, selectedAircraftId: null };
    }
    return { ok: true, data: { price, loanPaid: owed } };
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
    if (a.status !== "available") return fail("aircraft_busy", `${a.registration} is ${a.status}`);
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
    const a = this.aircraft(aircraftId);
    if (!a) return fail("unknown_aircraft", `No aircraft ${aircraftId} in the fleet`);
    if (a.status !== "available") return fail("aircraft_busy", `${a.registration} is ${a.status}`);
    if (a.condition >= 100) return fail("no_wear", `${a.registration} needs no repair`);
    const type = aircraftTypeByKey(a.typeKey);
    if (!type) return fail("unknown_type", a.typeKey);
    const cost = repairCost(type, a.condition);
    const hours = repairHours(a.condition);
    if (this.company.cash < cost) {
      return fail("insufficient_cash", `The repair costs $${cost.toLocaleString("en-US")}`);
    }
    this.post(
      "repair",
      -cost,
      "aircraft",
      a.id,
      `${a.registration} repair (${round2(100 - a.condition)} % wear)`,
    );
    const order = this.openOrder(a, {
      kind: "overhaul",
      defectIds: [],
      label: `Overhaul (${round2(100 - a.condition)} % wear)`,
      shop: "maintenance",
      cost,
      hours,
    });
    return { ok: true, data: { cost, hours, readyAtGameMs: order.readyAtGameMs } };
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
    // P5: known minor (1 % each) and major (5–15 %) defects burn extra fuel.
    const penalty = airworthinessGate(this.gateInput(a), this.company.gameMs).fuelPenaltyPct;
    if (a.ownership !== "wet_lease" && f.fuelKg > 0 && f.fuelAirport) {
      const price = fuelPrice(f.fuelAirport, this.airports?.list ?? [f.fuelAirport]);
      const billedKg = f.fuelKg * (1 + penalty / 100);
      const amount = fuelCost(billedKg, price);
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
            penalty > 0
              ? `${round2(f.fuelKg)} kg + ${penalty} % defect burn × $${price.usdPerKg.toFixed(3)}/kg`
              : `${round2(f.fuelKg)} kg × $${price.usdPerKg.toFixed(3)}/kg`,
        });
      }
    }
    if (f.landingAirport && f.landings > 0) {
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
    const next: BookAircraft = {
      ...a,
      systems,
      condition,
      defects,
      defectCounter: counter,
      hours: round2(a.hours + Math.max(0, f.airborneMin) / 60),
      cycles: a.cycles + Math.max(0, f.landings),
      status: writtenOff ? "written_off" : a.status === "in_flight" ? "available" : a.status,
      location: f.landingAirport && !f.crashed ? f.landingAirport.ident : a.location,
    };
    this.touchAircraft(next);
    const found = [...rolls.escalated, ...rolls.added];
    this.event(a.id, "flight", {
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
    if (writtenOff) {
      this.event(a.id, "written_off", { condition });
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
    return { ok: true, data: a };
  }

  private queued(a: BookAircraft): Set<string> {
    return new Set(a.orders.flatMap((o) => o.defectIds));
  }

  /** Cost and time to repair these defects where the aircraft is parked. */
  repairQuoteFor(a: BookAircraft, defects: readonly Defect[]) {
    const shop = shopAt(this.maintenance, a.location);
    return { shop, ...repairQuote(defects, shop) };
  }

  /** Repair one known defect (queued behind any running order). */
  repairDefect(aircraftId: string, defectId: string): BookResult<{ order: MaintenanceOrder }> {
    const w = this.workable(aircraftId);
    if (!w.ok) return w;
    const a = w.data;
    const d = a.defects.find((x) => x.id === defectId && !x.hidden);
    if (!d) return fail("unknown_defect", `No known defect ${defectId} on ${a.registration}`);
    if (this.queued(a).has(d.id)) return fail("already_queued", `${d.title} is already queued`);
    const q = this.repairQuoteFor(a, [d]);
    if (this.company.cash < q.cost) {
      return fail("insufficient_cash", `The repair costs $${q.cost.toLocaleString("en-US")}`);
    }
    this.post("repair", -q.cost, "aircraft", a.id, `${a.registration} repair: ${d.title}`);
    const order = this.openOrder(this.fleet.get(a.id) ?? a, {
      kind: "defect",
      defectIds: [d.id],
      label: d.title,
      shop: q.shop,
      cost: q.cost,
      hours: q.hours,
    });
    return { ok: true, data: { order } };
  }

  /** Repair every known defect not already queued, as one order. */
  repairAll(aircraftId: string): BookResult<{ order: MaintenanceOrder }> {
    const w = this.workable(aircraftId);
    if (!w.ok) return w;
    const a = w.data;
    const queued = this.queued(a);
    const open = a.defects.filter((d) => !d.hidden && !queued.has(d.id));
    if (open.length === 0) return fail("no_defects", `${a.registration} has no open defects`);
    const q = this.repairQuoteFor(a, open);
    if (this.company.cash < q.cost) {
      return fail("insufficient_cash", `The repairs cost $${q.cost.toLocaleString("en-US")}`);
    }
    this.post(
      "repair",
      -q.cost,
      "aircraft",
      a.id,
      `${a.registration} repair of ${open.length} defect(s)`,
    );
    const order = this.openOrder(this.fleet.get(a.id) ?? a, {
      kind: "defect",
      defectIds: open.map((d) => d.id),
      label: open.length === 1 ? (open[0]?.title ?? "Defect") : `${open.length} defects`,
      shop: q.shop,
      cost: q.cost,
      hours: q.hours,
    });
    return { ok: true, data: { order } };
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
    const shop = shopAt(this.maintenance, a.location);
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
      return fail("aircraft_busy", `${a0.registration} is ${a0.status}`);
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
    if (collateral.type !== "aircraft") {
      return fail("unsupported_collateral", "Only aircraft can be pledged until FBOs exist (P5)");
    }
    const a = this.aircraft(collateral.id);
    if (!a) return fail("unknown_aircraft", `No aircraft ${collateral.id} in the fleet`);
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
    this.post("loan_payment", -amount, "loan", loan.id, "Early payoff (no penalty)");
    const paid: BookLoan = { ...loan, balance: 0, status: "paid_off" };
    this.touchLoan(paid);
    this.releaseCollateral(paid);
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
    const shop = shopAt(this.maintenance, a.location);
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
    "tierName" | "creditScore" | "netWorth" | "debt" | "startingCash" | "clock"
  > {
    return {
      tierName: tierName(reputationTier(this.company.reputation)),
      creditScore: this.credit().score,
      netWorth: this.netWorth(),
      debt: this.debt(),
      startingCash: this.company.startingCash,
      clock: companyClock(this.company.gameMs),
    };
  }
}

const INSPECTION_MS = INSPECTION_HOURS * 3_600_000;

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
  };
}

export function loanState(l: BookLoan): LoanState {
  return {
    id: l.id,
    lenderId: l.lenderId,
    lenderName: lenderById(l.lenderId)?.name ?? l.lenderId,
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
): Omit<CompanyCore, "name" | "base" | "seed" | "cash" | "reputation"> {
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
  };
}
