// Bank loans (plan §7.2): three fictional lenders, the credit score, offers, standard
// amortisation and quotes. Pure functions; the company book applies them.
//
// The lender names are invented for the game. Any resemblance to a real institution is
// unintended.

import type { Lender, LenderOffer, LoanQuote, PnlMonth } from "../../protocol/src/company";
import { CREDIT, MIN_LOAN_USD, ORIGINATION_FEE_SHARE } from "./company-constants";
import { round2 } from "./geo";
import { reputationTier } from "./payout";

export const LENDERS: readonly Lender[] = [
  {
    id: "altocirrus",
    name: "Altocirrus Bank",
    appetite: "conservative",
    minApr: 5.5,
    maxApr: 8,
    maxLtv: 0.7,
    minTermMonths: 24,
    maxTermMonths: 120,
    minScore: 600,
    minTier: 2,
  },
  {
    id: "vectorline",
    name: "Vectorline Mutual",
    appetite: "balanced",
    minApr: 8,
    maxApr: 12,
    maxLtv: 0.8,
    minTermMonths: 12,
    maxTermMonths: 84,
    minScore: 450,
    minTier: 1,
  },
  {
    id: "jetwash",
    name: "Jetwash Credit",
    appetite: "aggressive",
    minApr: 12,
    maxApr: 18,
    maxLtv: 0.85,
    minTermMonths: 6,
    maxTermMonths: 60,
    minScore: 300,
    minTier: 0,
  },
];

export function lenderById(id: string | null | undefined): Lender | null {
  return LENDERS.find((l) => l.id === id) ?? null;
}

// ---- credit score ----

export interface CreditInput {
  reputation: number;
  /** Closed in-game months (of the last 12) with positive operating cash flow. */
  positiveMonths: number;
  /** Outstanding loan principal. */
  debt: number;
  /** Cash (≥ 0) + owned aircraft value. */
  assets: number;
  /** A repossession happened less than 12 in-game months ago. */
  defaulted: boolean;
}

export interface CreditScore {
  score: number;
  reputation: number;
  cashFlow: number;
  debt: number;
  debtRatio: number;
  halved: boolean;
}

/**
 * Credit score 0–850: 3 × reputation (≤ 300) + 25 × positive months (≤ 12 → 300) +
 * 250 × (1 − min(1, debt / assets)); halved (floor) while the default flag applies.
 */
export function creditScore(input: CreditInput): CreditScore {
  const rep = Math.round(CREDIT.perReputationPoint * Math.max(0, Math.min(100, input.reputation)));
  const months = Math.max(0, Math.min(CREDIT.positiveMonthsCap, Math.floor(input.positiveMonths)));
  const cashFlow = CREDIT.perPositiveMonth * months;
  const debtRatio = input.debt <= 0 ? 0 : Math.min(1, input.debt / Math.max(1, input.assets));
  const debt = Math.round(CREDIT.debtWeight * (1 - debtRatio));
  const raw = Math.min(CREDIT.max, rep + cashFlow + debt);
  const score = input.defaulted ? Math.floor(raw / 2) : raw;
  return {
    score,
    reputation: rep,
    cashFlow,
    debt,
    debtRatio: Math.round(debtRatio * 10_000) / 10_000,
    halved: input.defaulted,
  };
}

/** Closed months (before `currentMonth`, the last 12) with net > 0. */
export function positiveMonths(pnl: readonly PnlMonth[], currentMonth: number): number {
  return pnl.filter((m) => m.month < currentMonth && m.month >= currentMonth - 12 && m.net > 0)
    .length;
}

// ---- offers ----

/**
 * APR offered by a lender: minApr + (maxApr − minApr) × (850 − score) / (850 − minScore),
 * clamped to [minApr, maxApr], rounded to 0.01 %.
 */
export function offerApr(lender: Lender, score: number): number {
  const span = Math.max(1, CREDIT.max - lender.minScore);
  const share = Math.max(0, Math.min(1, (CREDIT.max - score) / span));
  return Math.round((lender.minApr + (lender.maxApr - lender.minApr) * share) * 100) / 100;
}

export function lenderOffer(
  lender: Lender,
  score: number,
  reputation: number,
  defaulted: boolean,
): LenderOffer {
  const tier = reputationTier(reputation);
  let reason: string | undefined;
  if (tier < lender.minTier) reason = `Needs reputation tier ${lender.minTier}`;
  else if (score < lender.minScore) reason = `Needs a credit score of ${lender.minScore}`;
  else if (defaulted && lender.appetite !== "aggressive") reason = "Declines after a default";
  return {
    lenderId: lender.id,
    lenderName: lender.name,
    eligible: reason === undefined,
    ...(reason ? { reason } : {}),
    apr: offerApr(lender, score),
    maxLtv: lender.maxLtv,
    minTermMonths: lender.minTermMonths,
    maxTermMonths: lender.maxTermMonths,
  };
}

// ---- amortisation ----

/**
 * Standard amortisation payment: P × r / (1 − (1 + r)^−n) with r = APR / 12, rounded to
 * cents (P / n when the rate is 0).
 */
export function monthlyPayment(principal: number, aprPercent: number, termMonths: number): number {
  if (termMonths <= 0) return round2(principal);
  const r = aprPercent / 100 / 12;
  if (r === 0) return round2(principal / termMonths);
  return round2((principal * r) / (1 - Math.pow(1 + r, -termMonths)));
}

/** Interest of one month on a balance, cents-rounded. */
export function monthInterest(balance: number, aprPercent: number): number {
  return round2((balance * aprPercent) / 100 / 12);
}

export interface AmortisationRow {
  month: number;
  payment: number;
  interest: number;
  principal: number;
  balance: number;
}

/**
 * Full schedule: each month interest = round2(balance × r), principal = payment −
 * interest; the last payment clears the balance exactly.
 */
export function amortisationSchedule(
  principal: number,
  aprPercent: number,
  termMonths: number,
): AmortisationRow[] {
  const payment = monthlyPayment(principal, aprPercent, termMonths);
  const rows: AmortisationRow[] = [];
  let balance = round2(principal);
  for (let month = 1; month <= termMonths && balance > 0; month++) {
    const interest = monthInterest(balance, aprPercent);
    const due =
      month === termMonths
        ? round2(balance + interest)
        : Math.min(payment, round2(balance + interest));
    const princ = round2(due - interest);
    balance = round2(balance - princ);
    rows.push({ month, payment: due, interest, principal: princ, balance });
  }
  return rows;
}

export function originationFee(principal: number): number {
  return round2(principal * ORIGINATION_FEE_SHARE);
}

export interface QuoteInput {
  lender: Lender;
  score: number;
  reputation: number;
  defaulted: boolean;
  principal: number;
  termMonths: number;
  /** Value of the collateral (aircraft price or market value); null = no collateral. */
  collateralValue: number | null;
}

/** A lender's quote, with the refusal code when it declines. */
export function quoteLoan(input: QuoteInput): LoanQuote {
  const { lender, principal, termMonths } = input;
  const offer = lenderOffer(lender, input.score, input.reputation, input.defaulted);
  const apr = offer.apr;
  const payment = monthlyPayment(principal, apr, termMonths);
  const schedule = amortisationSchedule(principal, apr, termMonths);
  const totalInterest = round2(schedule.reduce((s, r) => s + r.interest, 0));
  const ltv =
    input.collateralValue && input.collateralValue > 0
      ? Math.round((principal / input.collateralValue) * 10_000) / 10_000
      : null;
  const base = {
    lenderId: lender.id,
    lenderName: lender.name,
    principal: round2(principal),
    termMonths,
    apr,
    payment,
    originationFee: originationFee(principal),
    totalInterest,
    ltv,
  };
  const no = (code: string, message: string): LoanQuote => ({ ...base, ok: false, code, message });
  if (!offer.eligible) {
    const code = offer.reason?.startsWith("Needs reputation")
      ? "reputation_gate"
      : offer.reason?.startsWith("Needs a credit")
        ? "credit_score_too_low"
        : "declined_after_default";
    return no(code, `${lender.name}: ${offer.reason ?? "declined"}`);
  }
  if (
    !Number.isInteger(termMonths) ||
    termMonths < lender.minTermMonths ||
    termMonths > lender.maxTermMonths
  ) {
    return no(
      "bad_term",
      `${lender.name} lends for ${lender.minTermMonths}–${lender.maxTermMonths} months`,
    );
  }
  if (principal < MIN_LOAN_USD) return no("bad_principal", `At least $${MIN_LOAN_USD}`);
  if (ltv === null) return no("no_collateral", "A loan needs collateral (an aircraft)");
  if (ltv > lender.maxLtv + 1e-9) {
    return no(
      "ltv_exceeded",
      `${lender.name} lends at most ${Math.round(lender.maxLtv * 100)} % of the collateral value`,
    );
  }
  return { ...base, ok: true };
}
