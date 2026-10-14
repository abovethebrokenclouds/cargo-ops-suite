// The seeded DEMO company's domains, computed from the bundled airport list. Pure (no React,
// no DOM) so it runs both on the page and in demo-domains.worker.ts.

import type {
  CompanyState,
  DemandState,
  FbosState,
  FleetState,
  LedgerState,
  LoansState,
  MarketState,
  PilotsState,
} from "@cargo-ops/protocol";
import { buildDemoCompany, reputationTier, type AirportLookup } from "@cargo-ops/economy";

export interface DemoDomains {
  company: CompanyState;
  fleet: FleetState;
  loans: LoansState;
  ledger: LedgerState;
  market: MarketState;
  fbos: FbosState;
  demand: DemandState;
  pilots: PilotsState;
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
    fbos: book.fbosDomain(),
    demand: book.demandDomain(),
    pilots: book.pilotsDomain(),
  };
}
