import { KeyRound, Lock, ShoppingCart } from "lucide-react";
import { useMemo, useState } from "react";

import {
  AIRCRAFT_TYPES,
  type AircraftType,
  type CompanyState,
  type LoansState,
  type Source,
} from "@cargo-ops/protocol";
import {
  leaseMinTier,
  leaseMonthlyFee,
  monthlyPayment,
  originationFee,
  purchaseMinTier,
  reputationTier,
  tierName,
} from "@cargo-ops/economy";
import {
  inputClass,
  primaryButton,
  secondaryButton,
  dialogClass,
} from "@/components/company/styles";
import { SourceTag } from "@/components/status/SourceTag";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

import { TypeSilhouette } from "./TypeSilhouette";

export type RunCommand = (name: string, args: unknown, success: string) => Promise<boolean>;

interface MarketProps {
  company: CompanyState | null;
  loans: LoansState | null;
  source: Source | null;
  /** Commands go to a real connector. */
  enabled: boolean;
  disabledNote?: string | undefined;
  busy: boolean;
  run: RunCommand;
}

/** New-aircraft catalogue with price, reputation gates, buy/finance and lease flows. */
export function AircraftMarket({
  company,
  loans,
  source,
  enabled,
  disabledNote,
  busy,
  run,
}: MarketProps) {
  const tier = company ? reputationTier(company.reputation) : 0;
  const [buying, setBuying] = useState<AircraftType | null>(null);
  const [leasing, setLeasing] = useState<AircraftType | null>(null);
  return (
    <>
      <ul className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3" data-testid="aircraft-market">
        {AIRCRAFT_TYPES.map((t) => {
          const buyTier = purchaseMinTier(t);
          const leaseTier = leaseMinTier(t);
          const canBuy = tier >= buyTier;
          const canLease = tier >= leaseTier;
          return (
            <li
              key={t.key}
              className="panel-inset flex gap-4 p-4"
              data-testid="market-type"
              data-type={t.key}
            >
              <TypeSilhouette
                category={t.category}
                className={cn(
                  "size-14 shrink-0 rotate-45",
                  canBuy ? "text-primary" : "text-muted-foreground/50",
                )}
              />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <div className="flex items-start justify-between gap-2">
                  <p className="truncate text-sm font-semibold text-foreground">{t.name}</p>
                  <SourceTag source={source === "demo" ? "demo" : null} />
                </div>
                <p className="font-display text-xl font-semibold text-gradient font-tabular">
                  {formatUsd(t.priceUsd)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t.maxPayloadKg.toLocaleString("en-US")} kg · {t.rangeNm.toLocaleString("en-US")}{" "}
                  nm · {t.cruiseKt} kt
                </p>
                <p className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[0.625rem] uppercase tracking-[0.14em]",
                      canBuy ? "bg-success/15 text-success" : "bg-secondary text-muted-foreground",
                    )}
                    data-testid="reputation-gate"
                  >
                    {canBuy ? null : <Lock className="size-3" aria-hidden="true" />}
                    Buy tier {buyTier} · {tierName(buyTier)}
                  </span>
                  <span className="font-mono text-[0.625rem] text-muted-foreground">
                    lease tier {leaseTier}
                  </span>
                </p>
                <div className="mt-1 flex flex-wrap gap-2">
                  <button
                    type="button"
                    className={cn(primaryButton, "px-3 py-1.5 text-xs")}
                    disabled={!enabled || busy || !canBuy}
                    title={
                      !enabled
                        ? disabledNote
                        : canBuy
                          ? undefined
                          : `Needs reputation tier ${buyTier}`
                    }
                    onClick={() => setBuying(t)}
                    data-testid="buy-aircraft"
                  >
                    <ShoppingCart className="size-3.5" aria-hidden="true" /> Buy / finance
                  </button>
                  <button
                    type="button"
                    className={cn(secondaryButton, "px-3 py-1.5 text-xs")}
                    disabled={!enabled || busy || !canLease}
                    title={
                      !enabled
                        ? disabledNote
                        : canLease
                          ? undefined
                          : `Needs reputation tier ${leaseTier}`
                    }
                    onClick={() => setLeasing(t)}
                    data-testid="lease-aircraft"
                  >
                    <KeyRound className="size-3.5" aria-hidden="true" /> Lease
                  </button>
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      <BuyDialog
        type={buying}
        company={company}
        loans={loans}
        busy={busy}
        onClose={() => setBuying(null)}
        run={run}
      />
      <LeaseDialog type={leasing} busy={busy} onClose={() => setLeasing(null)} run={run} />
    </>
  );
}

function BuyDialog({
  type,
  company,
  loans,
  busy,
  onClose,
  run,
}: {
  type: AircraftType | null;
  company: CompanyState | null;
  loans: LoansState | null;
  busy: boolean;
  onClose: () => void;
  run: RunCommand;
}) {
  const eligible = useMemo(() => (loans?.offers ?? []).filter((o) => o.eligible), [loans]);
  const [finance, setFinance] = useState(false);
  const [lenderId, setLenderId] = useState("");
  const [term, setTerm] = useState("60");
  const [share, setShare] = useState(70);
  const offer = eligible.find((o) => o.lenderId === lenderId) ?? eligible[0] ?? null;
  const price = type?.priceUsd ?? 0;
  const maxShare = Math.round((offer?.maxLtv ?? 0) * 100);
  const pct = Math.min(share, maxShare);
  const principal = finance && offer ? Math.round((price * pct) / 100) : 0;
  const months = Number(term) || 0;
  const payment =
    offer && principal > 0 && months > 0 ? monthlyPayment(principal, offer.apr, months) : 0;
  const fee = principal > 0 ? originationFee(principal) : 0;
  const cashNeeded = price - principal + fee;
  const cash = company?.cash ?? 0;
  const termOk = offer ? months >= offer.minTermMonths && months <= offer.maxTermMonths : true;
  return (
    <Dialog open={type !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className={dialogClass}>
        <DialogHeader>
          <DialogTitle>Buy {type?.name}</DialogTitle>
          <DialogDescription>
            Catalogue price {formatUsd(price)} (approximate, for gameplay). Delivered to the active
            aircraft's airport, else the base.
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            className="size-4 accent-primary"
            checked={finance}
            disabled={eligible.length === 0}
            onChange={(e) => setFinance(e.target.checked)}
          />
          Finance with a bank loan
          {eligible.length === 0 ? (
            <span className="text-xs text-muted-foreground">(no lender offers you credit yet)</span>
          ) : null}
        </label>
        {finance && offer ? (
          <div className="grid grid-cols-2 gap-3">
            <label className="col-span-2 flex flex-col gap-1.5">
              <span className="label-eyebrow">Lender</span>
              <select
                className={inputClass}
                value={offer.lenderId}
                onChange={(e) => setLenderId(e.target.value)}
              >
                {eligible.map((o) => (
                  <option key={o.lenderId} value={o.lenderId}>
                    {o.lenderName} · {o.apr.toFixed(2)} % APR · LTV ≤ {Math.round(o.maxLtv * 100)} %
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label-eyebrow">Loan share {pct} %</span>
              <input
                type="range"
                min={10}
                max={maxShare}
                value={pct}
                className="accent-primary"
                onChange={(e) => setShare(Number(e.target.value))}
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label-eyebrow">
                Term ({offer.minTermMonths}–{offer.maxTermMonths} mo)
              </span>
              <input
                className={inputClass}
                inputMode="numeric"
                value={term}
                onChange={(e) => setTerm(e.target.value)}
              />
            </label>
          </div>
        ) : null}
        <dl className="grid grid-cols-2 gap-2 font-mono text-sm">
          <dt className="text-muted-foreground">Loan</dt>
          <dd className="text-right font-tabular">{formatUsd(principal)}</dd>
          <dt className="text-muted-foreground">Monthly payment</dt>
          <dd className="text-right font-tabular text-accent" data-testid="buy-monthly-payment">
            {payment > 0
              ? `$${payment.toLocaleString("en-US", { minimumFractionDigits: 2 })}`
              : "—"}
          </dd>
          <dt className="text-muted-foreground">Origination fee 1 %</dt>
          <dd className="text-right font-tabular">{formatUsd(fee)}</dd>
          <dt className="text-muted-foreground">Cash needed</dt>
          <dd
            className={cn(
              "text-right font-tabular",
              cashNeeded > cash ? "text-destructive" : "text-foreground",
            )}
          >
            {formatUsd(cashNeeded)} of {formatUsd(cash)}
          </dd>
        </dl>
        <DialogFooter>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={busy || !type || cashNeeded > cash || (finance && !termOk)}
            onClick={() => {
              if (!type) return;
              const args =
                finance && offer && principal > 0
                  ? {
                      typeKey: type.key,
                      financing: { lenderId: offer.lenderId, termMonths: months, principal },
                    }
                  : { typeKey: type.key };
              void run("fleet.buy", args, `Bought a ${type.name}`).then((ok) => ok && onClose());
            }}
          >
            Confirm purchase
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function LeaseDialog({
  type,
  busy,
  onClose,
  run,
}: {
  type: AircraftType | null;
  busy: boolean;
  onClose: () => void;
  run: RunCommand;
}) {
  const [kind, setKind] = useState<"dry" | "wet">("dry");
  const monthly = type ? leaseMonthlyFee(type) : 0;
  return (
    <Dialog open={type !== null} onOpenChange={(open) => (open ? null : onClose())}>
      <DialogContent className={dialogClass}>
        <DialogHeader>
          <DialogTitle>Lease {type?.name}</DialogTitle>
          <DialogDescription>
            Leases bill {formatUsd(monthly)} per in-game month (the first month now) plus flight
            hours after every mission. Return the aircraft at any time; wear is charged on return.
          </DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          {(["dry", "wet"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className={cn(
                "panel-inset flex flex-col gap-1 p-3 text-left",
                kind === k && "ring-1 ring-primary/60",
              )}
              onClick={() => setKind(k)}
              aria-pressed={kind === k}
            >
              <span className="label-eyebrow">{k === "dry" ? "Dry lease" : "Wet lease"}</span>
              <span className="font-mono text-sm text-foreground font-tabular">
                {type
                  ? k === "dry"
                    ? `${formatUsd(type.dryLeaseUsdPerEngineHour)} / engine-hour`
                    : `${formatUsd(type.wetLeaseUsdPerBlockHour)} / block hour`
                  : "—"}
              </span>
              <span className="text-xs text-muted-foreground">
                {k === "dry" ? "You pay the fuel" : "Fuel included"}
              </span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <button type="button" className={secondaryButton} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={primaryButton}
            disabled={busy || !type}
            onClick={() => {
              if (!type) return;
              void run("fleet.lease", { typeKey: type.key, kind }, `Leased a ${type.name}`).then(
                (ok) => ok && onClose(),
              );
            }}
          >
            Confirm lease
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
