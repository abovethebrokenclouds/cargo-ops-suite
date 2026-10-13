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
import type { EventName } from "../../protocol/src/messages";
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
  applyWear,
  canBuy,
  canLease,
  flightWear,
  isAirworthy,
  leaseMinTier,
  marketValue,
  purchaseMinTier,
  registrationFor,
  repairCost,
  repairHours,
  salePrice,
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
}

export type BookResult<T> = { ok: true; data: T } | { ok: false; code: string; message: string };
const fail = (code: string, message: string) => ({ ok: false as const, code, message });

/** Categories that are capital flows, not operating revenue/expense. */
const CAPITAL: ReadonlySet<LedgerCategory> = new Set<LedgerCategory>([
  "loan_disbursement",
  "loan_payment",
  "purchase",
  "sale",
]);

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
}

export interface SettlementResult {
  costs: MissionCost[];
  wear: WearResult;
  condition: number;
}

export interface BookOptions<C extends CompanyCore> {
  company: C;
  fleet?: readonly BookAircraft[];
  loans?: readonly BookLoan[];
  /** Newest first. */
  recent?: readonly BookLedgerEntry[];
  airports: AirportLookup | null;
  now: () => number;
}

export class CompanyBook<C extends CompanyCore = CompanyCore> {
  company: C;
  readonly fleet = new Map<string, BookAircraft>();
  readonly loans = new Map<string, BookLoan>();
  private recent: BookLedgerEntry[];
  private readonly airports: AirportLookup | null;
  private readonly now: () => number;
  private pending: BookChanges = emptyChanges();

  constructor(options: BookOptions<C>) {
    this.company = options.company;
    for (const a of options.fleet ?? []) this.fleet.set(a.id, { ...a });
    for (const l of options.loans ?? []) this.loans.set(l.id, { ...l });
    this.recent = [...(options.recent ?? [])].slice(0, 20);
    this.airports = options.airports;
    this.now = options.now;
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
      p.notices.length > 0
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
  ): BookAircraft {
    const n = this.company.fleetCounter + 1;
    const taken = new Set([...this.fleet.values()].map((a) => a.registration));
    const a: BookAircraft = {
      id: `AC-${n}`,
      registration: registrationFor(this.company.seed, n, taken),
      typeKey: type.key,
      ownership,
      status: "available",
      location,
      hours: 0,
      cycles: 0,
      condition: 100,
      purchasePrice: round2(price),
      acquiredAt: this.now(),
      acquiredGameMs: Math.floor(this.company.gameMs),
      readyAtGameMs: null,
      loanId: null,
    };
    this.company = { ...this.company, fleetCounter: n };
    this.fleet.set(a.id, a);
    this.touchAircraft(a);
    return a;
  }

  private touchAircraft(a: BookAircraft): void {
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

  updateAircraft(id: string, patch: Partial<BookAircraft>): BookAircraft | null {
    const a = this.fleet.get(id);
    if (!a) return null;
    const next = { ...a, ...patch };
    this.touchAircraft(next);
    return next;
  }

  // ---- totals ----

  activeLoans(): BookLoan[] {
    return [...this.loans.values()].filter((l) => l.status === "active");
  }

  debt(): number {
    return round2(this.activeLoans().reduce((s, l) => s + l.balance, 0));
  }

  aircraftValue(a: BookAircraft): number {
    if (a.ownership !== "owned") return 0;
    const type = aircraftTypeByKey(a.typeKey);
    return type ? marketValue(type, a.hours, a.condition) : 0;
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
      if (a.status === "maintenance" && a.readyAtGameMs !== null)
        next = Math.min(next, a.readyAtGameMs);
    }
    return next;
  }

  private processDue(t: number): void {
    // Repairs that are done.
    for (const a of this.activeFleet()) {
      if (a.status === "maintenance" && a.readyAtGameMs !== null && a.readyAtGameMs <= t) {
        const done = { ...a, status: "available" as const, condition: 100, readyAtGameMs: null };
        this.touchAircraft(done);
        this.event(a.id, "repair.completed", { condition: 100 });
        this.notice("repair.completed", { aircraftId: a.id, registration: a.registration });
      }
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
    const price = salePrice(type, a.hours, a.condition);
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
    const readyAtGameMs = Math.floor(this.company.gameMs + hours * 3_600_000);
    this.touchAircraft({ ...a, status: "maintenance", readyAtGameMs });
    this.event(a.id, "repair.started", { cost, hours, readyAtGameMs });
    return { ok: true, data: { cost, hours, readyAtGameMs } };
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
    if (a.ownership !== "wet_lease" && f.fuelKg > 0 && f.fuelAirport) {
      const price = fuelPrice(f.fuelAirport, this.airports?.list ?? [f.fuelAirport]);
      const amount = fuelCost(f.fuelKg, price);
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
          note: `${round2(f.fuelKg)} kg × $${price.usdPerKg.toFixed(3)}/kg`,
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
    const condition = applyWear(a.condition, wear.total);
    const next: BookAircraft = {
      ...a,
      condition,
      hours: round2(a.hours + Math.max(0, f.airborneMin) / 60),
      cycles: a.cycles + Math.max(0, f.landings),
      status: a.status === "in_flight" ? "available" : a.status,
      location: f.landingAirport && !f.crashed ? f.landingAirport.ident : a.location,
    };
    this.touchAircraft(next);
    this.event(a.id, "flight", {
      ref: f.refId,
      wear,
      condition,
      location: next.location,
      costs: costs.map((c) => ({ key: c.key, amount: c.amount })),
    });
    return { ok: true, data: { costs, wear, condition } };
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
        airworthy: isAirworthy(a.condition),
        purchasePrice: a.purchasePrice,
        value: this.aircraftValue(a),
        repairCost: type ? repairCost(type, a.condition) : 0,
        repairHours: repairHours(a.condition),
        ...(a.readyAtGameMs !== null ? { readyAtGameMs: a.readyAtGameMs } : {}),
        financed,
        ...(financed && a.loanId ? { loanId: a.loanId } : {}),
        acquiredAt: new Date(a.acquiredAt).toISOString(),
      };
    });
    return {
      aircraft,
      selectedId: selection.id,
      selection: selection.source,
      ambiguous: selection.ambiguous,
      value: this.fleetValue(),
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

export function leaseMonthlyFee(type: AircraftType): number {
  return round2(type.priceUsd * LEASE_MONTHLY_SHARE);
}

function emptyChanges(): BookChanges {
  return { company: false, ledger: [], aircraft: [], loans: [], events: [], notices: [] };
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
  };
}
