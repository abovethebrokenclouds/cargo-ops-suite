// Company, fleet, loans and ledger for the web app. Live/replay: the connector's
// `company`, `fleet`, `loans` and `ledger` domains (authoritative). Demo (no connector):
// a seeded company computed in the browser with the SAME book, payout, cost and wear
// code (packages/economy), every value tagged DEMO, every action disabled.

import { useEffect, useState } from "react";
import type {
  CompanyState,
  DemandState,
  FbosState,
  FleetState,
  LedgerState,
  LoansState,
  MarketState,
  Source,
} from "@cargo-ops/protocol";
import type { AirportLookup } from "@cargo-ops/economy";
import type { ClientSimState } from "@/lib/sim-state";

import { demoDomains, type DemoDomains } from "./demo-domains";

export { demoDomains, type DemoDomains };

export interface CompanyView {
  /** sim/replay from the connector, demo from the in-browser seed, null when unknown. */
  source: Source | null;
  company: CompanyState | null;
  fleet: FleetState | null;
  loans: LoansState | null;
  ledger: LedgerState | null;
  /** P5 used aircraft market. */
  market: MarketState | null;
  /** P5 part 2: owned FBOs and local demand. */
  fbos: FbosState | null;
  demand: DemandState | null;
  /** True when commands go to a real connector. */
  connector: boolean;
  demo: boolean;
}

let demoPromise: Promise<DemoDomains> | null = null;
let demoResolved: DemoDomains | null = null;

function computeInWorker(lookup: AirportLookup): Promise<DemoDomains> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./demo-domains.worker.ts", import.meta.url), {
      type: "module",
    });
    const done = () => worker.terminate();
    worker.onmessage = (
      ev: MessageEvent<{ ok: true; domains: DemoDomains } | { ok: false; error: string }>,
    ) => {
      done();
      if (ev.data.ok) resolve(ev.data.domains);
      else reject(new Error(ev.data.error));
    };
    worker.onerror = (ev) => {
      done();
      ev.preventDefault();
      reject(new Error(ev.message || "demo company worker failed"));
    };
    worker.postMessage({ airports: lookup.list });
  });
}

/**
 * The DEMO company, computed once per page load (it is deterministic) and off the main
 * thread when the browser has workers: simulating its months of history blocked the page
 * for over a second on a slow machine, on every demo page that showed company data.
 * Without workers (or if the worker fails) it runs on the page after a macrotask.
 */
export function loadDemoDomains(lookup: AirportLookup): Promise<DemoDomains> {
  const onPage = () =>
    new Promise<DemoDomains>((resolve) => setTimeout(() => resolve(demoDomains(lookup)), 0));
  demoPromise ??= (typeof Worker === "function" ? computeInWorker(lookup) : onPage())
    .catch(onPage)
    .then((d) => (demoResolved = d))
    .catch((err: unknown) => {
      demoPromise = null;
      throw err;
    });
  return demoPromise;
}

/** The DEMO company's domains once `lookup` is known; null until then (and when null). */
export function useDemoDomains(lookup: AirportLookup | null): DemoDomains | null {
  const [data, setData] = useState<DemoDomains | null>(() => (lookup ? demoResolved : null));
  useEffect(() => {
    if (!lookup) return;
    let alive = true;
    loadDemoDomains(lookup)
      .then((d) => alive && setData(d))
      .catch(() => alive && setData(null));
    return () => {
      alive = false;
    };
  }, [lookup]);
  return lookup ? data : null;
}

/** Live/replay domains from state, or the DEMO company when no connector exists. */
export function useCompanyView(state: ClientSimState, lookup: AirportLookup | null): CompanyView {
  const demo = state.connection === "demo";
  const demoData = useDemoDomains(demo ? lookup : null);
  if (demo) {
    return {
      source: "demo",
      company: demoData?.company ?? null,
      fleet: demoData?.fleet ?? null,
      loans: demoData?.loans ?? null,
      ledger: demoData?.ledger ?? null,
      market: demoData?.market ?? null,
      fbos: demoData?.fbos ?? null,
      demand: demoData?.demand ?? null,
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
    fbos: state.sim.fbos ?? null,
    demand: state.sim.demand ?? null,
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
  fbo_income: "FBO income",
  fbo_upkeep: "FBO upkeep",
  fbo_purchase: "FBO purchase",
  fbo_construction: "FBO construction",
  insurance_claim: "Insurance claim",
};

export const OWNERSHIP_LABELS = {
  owned: "Owned",
  dry_lease: "Dry lease",
  wet_lease: "Wet lease",
} as const;
