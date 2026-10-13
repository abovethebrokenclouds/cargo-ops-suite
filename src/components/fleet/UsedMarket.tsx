import { Clock, MapPin, Repeat, Search, ShoppingCart, Sparkles } from "lucide-react";
import { useState } from "react";

import type {
  CompanyState,
  LoansState,
  MarketListing,
  MarketState,
  Source,
} from "@cargo-ops/protocol";
import { formatGameTime, reputationTier, tierName } from "@cargo-ops/economy";
import { primaryButton, secondaryButton } from "@/components/company/styles";
import { SourceTag } from "@/components/status/SourceTag";
import { formatInt, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

import { PurchaseDialog, type RunCommand } from "./AircraftMarket";
import { DefectRow } from "./Airworthiness";
import { TypeSilhouette } from "./TypeSilhouette";

interface UsedMarketProps {
  market: MarketState | null;
  company: CompanyState | null;
  loans: LoansState | null;
  source: Source | null;
  enabled: boolean;
  disabledNote?: string | undefined;
  busy: boolean;
  run: RunCommand;
}

/** Used aircraft listings: inspect (0.5 %, one in-game day) and buy, cash or financed. */
export function UsedMarket({
  market,
  company,
  loans,
  source,
  enabled,
  disabledNote,
  busy,
  run,
}: UsedMarketProps) {
  const tier = company ? reputationTier(company.reputation) : 0;
  const [buying, setBuying] = useState<MarketListing | null>(null);
  if (!market) {
    return <p className="text-sm text-muted-foreground">No market data yet.</p>;
  }
  return (
    <>
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
        <p>
          Generation {market.generation} · next listings {formatGameTime(market.nextRefreshGameMs)}.
          Prices follow age, hours, condition and the defects the seller disclosed; an inspection
          reveals the rest.
        </p>
        <button
          type="button"
          className={cn(secondaryButton, "px-3 py-1.5 text-xs")}
          disabled={!enabled || busy}
          title={disabledNote}
          onClick={() => void run("market.refresh", {}, "New listings on the market")}
          data-testid="market-refresh"
        >
          <Repeat className="size-3.5" aria-hidden="true" /> Refresh listings
        </button>
      </div>
      <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3" data-testid="used-market">
        {market.listings.map((l) => (
          <ListingCard
            key={l.id}
            listing={l}
            canBuy={tier >= l.purchaseMinTier}
            source={source}
            enabled={enabled}
            disabledNote={disabledNote}
            busy={busy}
            onInspect={() =>
              void run("market.inspect", { listingId: l.id }, `Inspection of ${l.id} booked`)
            }
            onBuy={() => setBuying(l)}
          />
        ))}
      </ul>
      <PurchaseDialog
        open={buying !== null}
        title={`Buy ${buying?.typeName ?? ""} (${buying?.id ?? ""})`}
        description={`Asking ${formatUsd(buying?.askingPrice ?? 0)} at ${buying?.location ?? ""}. The aircraft stays where it is listed: fly or ferry it from there.`}
        warning={
          buying && buying.inspection.status !== "done"
            ? "Not inspected: hidden defects (possibly grounding ones) may surface on the first dispatch."
            : undefined
        }
        price={buying?.askingPrice ?? 0}
        company={company}
        loans={loans}
        busy={busy}
        onClose={() => setBuying(null)}
        onConfirm={(financing) =>
          buying
            ? run(
                "market.buy",
                financing ? { listingId: buying.id, financing } : { listingId: buying.id },
                `Bought ${buying.typeName} (${buying.id})`,
              )
            : Promise.resolve(false)
        }
      />
    </>
  );
}

function ListingCard({
  listing: l,
  canBuy,
  source,
  enabled,
  disabledNote,
  busy,
  onInspect,
  onBuy,
}: {
  listing: MarketListing;
  canBuy: boolean;
  source: Source | null;
  enabled: boolean;
  disabledNote?: string | undefined;
  busy: boolean;
  onInspect: () => void;
  onBuy: () => void;
}) {
  const share = Math.round((l.askingPrice / l.catalogPrice) * 100);
  const grounded = l.knownDefects.some((d) => d.severity === "grounding");
  const inspected = l.inspection.status === "done";
  return (
    <li
      className="panel-elevated flex flex-col gap-4 p-5"
      data-testid="listing-card"
      data-listing-id={l.id}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{l.typeName}</p>
          <p className="mt-1 font-mono text-[0.6875rem] uppercase tracking-[0.14em] text-muted-foreground">
            {l.id}
          </p>
        </div>
        <SourceTag source={source} />
      </div>

      <div className="flex items-center gap-4">
        <div className="panel-inset relative grid size-20 shrink-0 place-items-center overflow-hidden">
          <TypeSilhouette
            category={l.category}
            className={cn(
              "size-14 rotate-45",
              grounded ? "text-destructive" : canBuy ? "text-accent" : "text-muted-foreground/50",
            )}
          />
        </div>
        <div className="min-w-0 flex-1">
          <p
            className="font-display text-2xl font-semibold text-gradient font-tabular"
            data-testid="asking-price"
          >
            {formatUsd(l.askingPrice)}
          </p>
          <p className="text-xs text-muted-foreground">
            {share} % of new · {l.condition.toFixed(1)} % condition
          </p>
        </div>
      </div>

      <dl className="grid grid-cols-3 gap-2 text-xs">
        <div>
          <dt className="label-eyebrow">Age</dt>
          <dd className="mt-1 font-mono text-foreground font-tabular">{l.ageYears} y</dd>
        </div>
        <div>
          <dt className="label-eyebrow">Hours</dt>
          <dd className="mt-1 flex items-center gap-1 font-mono text-foreground font-tabular">
            <Clock className="size-3 text-muted-foreground" aria-hidden="true" />
            {formatInt(l.hours)}
          </dd>
        </div>
        <div>
          <dt className="label-eyebrow">Location</dt>
          <dd
            className="mt-1 flex items-center gap-1 font-mono text-foreground"
            title={`${l.distanceFromBaseNm} nm from the base`}
            data-testid="listing-location"
          >
            <MapPin className="size-3 text-accent" aria-hidden="true" />
            {l.location}
          </dd>
        </div>
      </dl>

      <p className="text-sm italic text-muted-foreground">“{l.sellerNote}”</p>

      <div>
        <p className="label-eyebrow mb-1">
          Known defects ({l.knownDefects.length})
          {inspected ? (
            <span
              className="ml-2 inline-flex items-center gap-1 text-accent"
              data-testid="inspection-result"
            >
              <Sparkles className="size-3" aria-hidden="true" />
              inspected · {l.inspection.found ?? 0} hidden found
            </span>
          ) : null}
        </p>
        {l.knownDefects.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {inspected ? "None: the inspection found nothing else." : "None disclosed."}
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {l.knownDefects.map((d) => (
              <DefectRow key={d.id} defect={d} />
            ))}
          </ul>
        )}
      </div>

      <div className="mt-auto flex flex-wrap items-center gap-2 border-t border-border pt-4">
        {l.inspection.status === "none" ? (
          <button
            type="button"
            className={cn(secondaryButton, "px-3 py-1.5 text-xs")}
            disabled={!enabled || busy}
            title={disabledNote ?? "Reveals hidden defects after one in-game day"}
            onClick={onInspect}
            data-testid="inspect-listing"
          >
            <Search className="size-3.5" aria-hidden="true" /> Inspect {formatUsd(l.inspection.fee)}
          </button>
        ) : l.inspection.status === "pending" ? (
          <span className="font-mono text-xs text-warning" data-testid="inspection-pending">
            Inspecting until{" "}
            {l.inspection.readyAtGameMs !== undefined
              ? formatGameTime(l.inspection.readyAtGameMs)
              : "—"}
          </span>
        ) : null}
        <button
          type="button"
          className={cn(primaryButton, "ml-auto px-3 py-1.5 text-xs")}
          disabled={!enabled || busy || !canBuy}
          title={
            !enabled
              ? disabledNote
              : canBuy
                ? undefined
                : `Needs reputation tier ${l.purchaseMinTier} (${tierName(l.purchaseMinTier)})`
          }
          onClick={onBuy}
          data-testid="buy-listing"
        >
          <ShoppingCart className="size-3.5" aria-hidden="true" /> Buy
        </button>
      </div>
    </li>
  );
}
