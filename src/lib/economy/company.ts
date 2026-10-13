// Company, fleet, loans and ledger for the web app. Live/replay: the connector's
// `company`, `fleet`, `loans` and `ledger` domains (authoritative). Demo (no connector):
// a seeded company computed in the browser with the SAME book, payout, cost and wear
// code (packages/economy), every value tagged DEMO, every action disabled.

import { useMemo } from "react";
import type {
  CompanyState,
  FleetState,
  LedgerState,
  LoansState,
  MarketState,
  Source,
} from "@cargo-ops/protocol";
import { buildDemoCompany, reputationTier, type AirportLookup } from "@cargo-ops/economy";
import type { ClientSimState } from "@/lib/sim-state";

export interface CompanyView {
  /** sim/replay from the connector, demo from the in-browser seed, null when unknown. */
  source: Source | null;
  company: CompanyState | null;
  fleet: FleetState | null;
  loans: LoansState | null;
  ledger: LedgerState | null;
  /** P5 used aircraft market. */
  market: MarketState | null;
  /** True when commands go to a real connector. */
  connector: boolean;
  demo: boolean;
}

export interface DemoDomains {
  company: CompanyState;
  fleet: FleetState;
  loans: LoansState;
  ledger: LedgerState;
  market: MarketState;
}

/** The seeded DEMO company's domains (deterministic for the bundled airport list). */
export function demoDomains(lookup: AirportLookup): DemoDomains {
  const { book, selection } = buildDemoCompany(lookup);
  const c = book.company;
  return {
    company: {
      name: c.name,
      base: c.base,
      cash: Math.round(c.cash * 100) / 100,
      reputation: c.reputation,
      reputationTier: reputationTier(c.reputation),
      ...book.companyFields(),
    },
    fleet: book.fleetDomain(selection),
    loans: book.loansDomain(),
    ledger: book.ledgerDomain(),
    market: book.marketDomain(),
  };
}

/** Live/replay domains from state, or the DEMO company when no connector exists. */
export function useCompanyView(state: ClientSimState, lookup: AirportLookup | null): CompanyView {
  const demo = state.connection === "demo";
  const demoData = useMemo(() => (demo && lookup ? demoDomains(lookup) : null), [demo, lookup]);
  if (demo) {
    return {
      source: "demo",
      company: demoData?.company ?? null,
      fleet: demoData?.fleet ?? null,
      loans: demoData?.loans ?? null,
      ledger: demoData?.ledger ?? null,
      market: demoData?.market ?? null,
      connector: false,
      demo: true,
    };
  }
  const connected = state.connection === "live" || state.connection === "replay";
  return {
    source: connected ? (state.source ?? (state.connection === "replay" ? "replay" : "sim")) : null,
    company: state.sim.company ?? null,
    fleet: state.sim.fleet ?? null,
    loans: state.sim.loans ?? null,
    ledger: state.sim.ledger ?? null,
    market: state.sim.market ?? null,
    connector: connected,
    demo: false,
  };
}

export const LEDGER_LABELS: Record<string, string> = {
  mission_payout: "Mission payout",
  fuel: "Fuel",
  landing_fee: "Landing fee",
  lease: "Lease",
  repair: "Repair",
  purchase: "Aircraft purchase",
  sale: "Aircraft sale",
  loan_disbursement: "Loan disbursement",
  loan_payment: "Loan principal",
  loan_fee: "Origination fee",
  late_fee: "Late fee",
  interest: "Interest",
  insurance: "Insurance",
  adjustment: "Adjustment",
  inspection: "Inspection",
  permit: "Ferry permit",
};

export const OWNERSHIP_LABELS = {
  owned: "Owned",
  dry_lease: "Dry lease",
  wet_lease: "Wet lease",
} as const;
