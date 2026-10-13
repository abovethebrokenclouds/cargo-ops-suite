import { Search } from "lucide-react";
import { useMemo, useState } from "react";

import type { LoansState } from "@cargo-ops/protocol";
import {
  emptyLevels,
  expectedDailyIncome,
  fboQuote,
  fuelPrice,
  fuelPricing,
  monthlyPayment,
  REFERENCE_HANDLING_USD,
  type AirportLookup,
  type EconomyAirport,
} from "@cargo-ops/economy";
import { inputClass, primaryButton, secondaryButton } from "@/components/company/styles";
import { formatInt, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const MAX_RESULTS = 6;

function search(lookup: AirportLookup, query: string): EconomyAirport[] {
  const q = query.trim().toUpperCase();
  if (q.length < 2) return [];
  const exact = lookup.get(q);
  const out: EconomyAirport[] = exact ? [exact] : [];
  for (const a of lookup.list) {
    if (out.length >= MAX_RESULTS) break;
    if (a === exact) continue;
    if (a.ident.startsWith(q) || a.iata?.toUpperCase() === q || a.name.toUpperCase().includes(q)) {
      out.push(a);
    }
  }
  return out;
}

export interface FboFinancing {
  lenderId: string;
  termMonths: number;
  principal: number;
}

/**
 * Buy or build flow: search the bundled airports, see the quote (price ∝ airport size), the
 * expected modelled income with the starting modules, and optional loan financing.
 */
export function FboBuyPanel({
  lookup,
  owned,
  loans,
  enabled,
  busy,
  disabledNote,
  onBuy,
  onBuild,
}: {
  lookup: AirportLookup | null;
  owned: ReadonlySet<string>;
  loans: LoansState | null;
  enabled: boolean;
  busy: boolean;
  disabledNote: string | undefined;
  onBuy: (icao: string, financing: FboFinancing | null) => void;
  onBuild: (icao: string, financing: FboFinancing | null) => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<string | null>(null);
  const [finance, setFinance] = useState(false);
  const results = useMemo(() => (lookup ? search(lookup, query) : []), [lookup, query]);
  const airport = picked && lookup ? lookup.get(picked) : null;
  const quote = useMemo(() => (airport ? fboQuote(airport) : null), [airport]);
  const estimate = useMemo(() => {
    if (!airport || !lookup || !quote) return null;
    const regional = fuelPrice(airport, lookup.list).usdPerKg;
    const levels = { ...emptyLevels(), ramp: 1, fuel: 1 };
    return expectedDailyIncome({
      airportType: airport.type,
      s: quote.sizeFactor,
      levels,
      fuel: fuelPricing(regional, 1, 1),
      handlingFeeUsd: REFERENCE_HANDLING_USD,
    });
  }, [airport, lookup, quote]);
  const offer = loans?.offers.find((o) => o.eligible) ?? null;
  const financing = (price: number): FboFinancing | null => {
    if (!finance || !offer) return null;
    const principal = Math.floor((price * Math.min(offer.maxLtv, 0.8)) / 1_000) * 1_000;
    const termMonths = Math.max(offer.minTermMonths, Math.min(60, offer.maxTermMonths));
    return principal >= 1_000 ? { lenderId: offer.lenderId, termMonths, principal } : null;
  };
  const exists = airport ? owned.has(airport.ident) : false;
  const buyFin = quote ? financing(quote.buyPrice) : null;

  return (
    <div className="flex flex-col gap-4" data-testid="fbo-buy-panel">
      <label className="relative block">
        <span className="sr-only">Search airports</span>
        <Search
          className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <input
          type="search"
          className={cn(inputClass, "pl-9")}
          placeholder="ICAO, IATA or name (e.g. KATL)"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setPicked(null);
          }}
          data-testid="fbo-search"
        />
      </label>
      {results.length > 0 && !airport ? (
        <ul className="flex flex-col gap-1" data-testid="fbo-search-results">
          {results.map((a) => (
            <li key={a.ident}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-secondary"
                onClick={() => setPicked(a.ident)}
              >
                <span className="min-w-0 truncate">
                  <span className="font-mono font-semibold text-foreground">{a.ident}</span>{" "}
                  <span className="text-muted-foreground">{a.name}</span>
                </span>
                <span className="label-eyebrow shrink-0">{a.type}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {airport && quote ? (
        <div className="panel-inset flex flex-col gap-3 p-4" data-testid="fbo-quote">
          <div className="flex items-baseline justify-between gap-2">
            <p className="min-w-0 truncate text-sm text-foreground">
              <span className="font-mono font-semibold">{airport.ident}</span> {airport.name}
            </p>
            <span className="label-eyebrow shrink-0">size {quote.sizeFactor.toFixed(2)}</span>
          </div>
          <dl className="grid grid-cols-2 gap-3 font-mono text-xs">
            <div>
              <dt className="text-muted-foreground">Buy existing</dt>
              <dd className="text-base text-foreground font-tabular">
                {formatUsd(quote.buyPrice)}
              </dd>
              <dd className="text-muted-foreground">fuel farm + ramp included</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Build</dt>
              <dd className="text-base text-foreground font-tabular">
                {formatUsd(quote.buildCost)}
              </dd>
              <dd className="text-muted-foreground">
                + {formatUsd(quote.landLeaseMonthly)}/mo lease · {quote.buildDays} days
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Traffic</dt>
              <dd className="text-foreground font-tabular">
                {formatInt(quote.movementsPerDay)} movements/day
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Expected income</dt>
              <dd className="text-foreground font-tabular">{formatUsd(estimate)}/day</dd>
            </div>
          </dl>
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              checked={finance}
              disabled={!enabled || !offer}
              onChange={(e) => setFinance(e.target.checked)}
              className="accent-primary"
            />
            {offer
              ? `Finance up to ${Math.round(Math.min(offer.maxLtv, 0.8) * 100)} % with ${offer.lenderName} at ${offer.apr} %`
              : "No lender offers a loan right now"}
          </label>
          {buyFin && offer ? (
            <p className="font-mono text-[0.6875rem] text-muted-foreground">
              Loan {formatUsd(buyFin.principal)} over {buyFin.termMonths} months ≈{" "}
              {formatUsd(monthlyPayment(buyFin.principal, offer.apr, buyFin.termMonths))}/mo
            </p>
          ) : null}
          {exists ? <p className="text-xs text-warning">You already have an FBO here.</p> : null}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className={primaryButton}
              disabled={!enabled || busy || exists}
              title={disabledNote}
              onClick={() => onBuy(airport.ident, buyFin)}
              data-testid="fbo-buy"
            >
              Buy {formatUsd(quote.buyPrice)}
            </button>
            <button
              type="button"
              className={secondaryButton}
              disabled={!enabled || busy || exists}
              title={disabledNote}
              onClick={() => onBuild(airport.ident, financing(quote.buildCost))}
              data-testid="fbo-build"
            >
              Build {formatUsd(quote.buildCost)}
            </button>
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Price follows the airport&apos;s size: its type, longest runway and scheduled service. One
          FBO per airport.
        </p>
      )}
    </div>
  );
}
