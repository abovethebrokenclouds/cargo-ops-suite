import { useMemo, useState } from "react";

import type { FleetState, LoansState } from "@cargo-ops/protocol";
import {
  amortisationSchedule,
  formatGameTime,
  monthlyPayment,
  originationFee,
} from "@cargo-ops/economy";
import { formatUsd, formatUsdCents as formatUsd2 } from "@/lib/format";
import { cn } from "@/lib/utils";

import { inputClass, primaryButton, ghostButton } from "./styles";

export type RunCommand = (name: string, args: unknown, success: string) => Promise<boolean>;

/** Debt service ÷ income as a semicircular gauge: green ≤ 35 %, amber ≤ 50 %, red above. */
export function DtiGauge({ value }: { value: number | null }) {
  const v = value === null ? 0 : Math.max(0, Math.min(1, value));
  const tone =
    value === null
      ? "text-muted-foreground"
      : value <= 0.35
        ? "text-success"
        : value <= 0.5
          ? "text-warning"
          : "text-destructive";
  const r = 42;
  const arc = Math.PI * r;
  return (
    <div className="flex flex-col items-center" data-testid="dti-gauge">
      <svg viewBox="0 0 100 58" className="w-40" aria-hidden="true">
        <path
          d="M8 50 A42 42 0 0 1 92 50"
          fill="none"
          className="stroke-secondary"
          strokeWidth="8"
          strokeLinecap="round"
        />
        <path
          d="M8 50 A42 42 0 0 1 92 50"
          fill="none"
          className={cn("stroke-current", tone)}
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray={`${arc * v} ${arc}`}
        />
      </svg>
      <p className={cn("-mt-6 font-display text-2xl font-semibold font-tabular", tone)}>
        {value === null ? "—" : `${Math.round(value * 100)} %`}
      </p>
      <p className="label-eyebrow mt-1">Debt-to-income</p>
    </div>
  );
}

/** Active loans with payoff, the lender offers and a live loan calculator. */
export function LoansPanel({
  loans,
  fleet,
  enabled,
  disabledNote,
  busy,
  run,
}: {
  loans: LoansState | null;
  fleet: FleetState | null;
  enabled: boolean;
  disabledNote?: string | undefined;
  busy: boolean;
  run: RunCommand;
}) {
  const offers = loans?.offers ?? [];
  const [lenderId, setLenderId] = useState("");
  const [principal, setPrincipal] = useState("250000");
  const [term, setTerm] = useState("36");
  const [collateralId, setCollateralId] = useState("");
  const offer =
    offers.find((o) => o.lenderId === lenderId) ??
    offers.find((o) => o.eligible) ??
    offers[0] ??
    null;
  const pledgeable = (fleet?.aircraft ?? []).filter((a) => a.ownership === "owned" && !a.financed);
  const collateral = pledgeable.find((a) => a.id === collateralId) ?? pledgeable[0] ?? null;
  const p = Math.max(0, Number(principal) || 0);
  const n = Math.max(0, Math.floor(Number(term) || 0));
  const payment = offer && p > 0 && n > 0 ? monthlyPayment(p, offer.apr, n) : null;
  const schedule = useMemo(
    () => (offer && p > 0 && n > 0 && n <= 240 ? amortisationSchedule(p, offer.apr, n) : []),
    [offer, p, n],
  );
  const totalInterest = schedule.reduce((s, r) => s + r.interest, 0);
  const maxPrincipal = collateral && offer ? Math.floor(collateral.value * offer.maxLtv) : 0;
  const registrations = new Map((fleet?.aircraft ?? []).map((a) => [a.id, a.registration]));
  const active = (loans?.loans ?? []).filter((l) => l.status === "active");
  const closed = (loans?.loans ?? []).filter((l) => l.status !== "active");
  return (
    <div className="flex flex-col gap-5">
      {active.length === 0 ? (
        <p className="text-sm text-muted-foreground">No active loans.</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="active-loans">
          {active.map((l) => (
            <li
              key={l.id}
              className="panel-inset flex flex-col gap-2 p-3"
              data-testid="active-loan"
              data-kind={l.kind ?? "bank"}
            >
              <div className="flex items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-foreground">
                  {l.lenderName}
                  {l.kind === "repair" ? (
                    <span className="font-normal text-muted-foreground">
                      {" "}
                      · repair loan, {registrations.get(l.collateral.id) ?? l.collateral.id} (no
                      collateral)
                    </span>
                  ) : null}{" "}
                  <span className="font-mono text-xs text-muted-foreground">{l.id}</span>
                </p>
                <p className="font-mono text-sm text-accent font-tabular">
                  {formatUsd2(l.payment)}/mo
                </p>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-secondary">
                <span
                  className="block h-full rounded-full bg-gradient-brand"
                  style={{
                    width: `${Math.max(0, Math.min(100, (1 - l.balance / l.principal) * 100))}%`,
                  }}
                />
              </div>
              <p className="flex flex-wrap justify-between gap-2 font-mono text-xs text-muted-foreground">
                <span>
                  {formatUsd(l.balance)} of {formatUsd(l.principal)} · {l.apr.toFixed(2)} % ·{" "}
                  {l.paymentsMade}/{l.termMonths}
                </span>
                <span>next {formatGameTime(l.nextDueGameMs)}</span>
              </p>
              {l.missedCount > 0 ? (
                <p className="text-xs text-destructive">
                  {l.missedCount} missed payment{l.missedCount > 1 ? "s" : ""}:{" "}
                  {l.kind === "repair"
                    ? "three in a row cancel the hull policy and move the balance to cash (no repossession)."
                    : "three in a row repossess the collateral."}
                </p>
              ) : null}
              <div>
                <button
                  type="button"
                  className={ghostButton}
                  disabled={!enabled || busy}
                  title={!enabled ? disabledNote : undefined}
                  onClick={() => void run("loan.payoff", { loanId: l.id }, `Loan ${l.id} paid off`)}
                >
                  Pay off {formatUsd(l.balance)} (no penalty)
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {closed.length > 0 ? (
        <p className="text-xs text-muted-foreground">
          Closed:{" "}
          {closed
            .map((l) =>
              l.status === "called"
                ? `${l.id} called by the insurer (balance moved to cash)`
                : `${l.id} ${l.kind === "repair" ? "repair loan " : ""}${l.status.replace("_", " ")}`,
            )
            .join(" · ")}
        </p>
      ) : null}

      <div
        className="flex flex-col gap-3 border-t border-border pt-4"
        data-testid="loan-calculator"
      >
        <p className="label-eyebrow">Loan calculator</p>
        <div className="grid grid-cols-2 gap-3">
          <label className="col-span-2 flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Lender</span>
            <select
              className={inputClass}
              value={offer?.lenderId ?? ""}
              onChange={(e) => setLenderId(e.target.value)}
              aria-label="Lender"
            >
              {offers.map((o) => (
                <option key={o.lenderId} value={o.lenderId}>
                  {o.lenderName} · {o.apr.toFixed(2)} %
                  {o.eligible ? "" : ` · ${o.reason ?? "declines"}`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Principal ($)</span>
            <input
              className={inputClass}
              inputMode="numeric"
              value={principal}
              onChange={(e) => setPrincipal(e.target.value.replace(/[^0-9.]/g, ""))}
              aria-label="Principal"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Term (months)</span>
            <input
              className={inputClass}
              inputMode="numeric"
              value={term}
              onChange={(e) => setTerm(e.target.value.replace(/[^0-9]/g, ""))}
              aria-label="Term"
            />
          </label>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="panel-inset p-2">
            <p className="label-eyebrow">Monthly</p>
            <p
              className="mt-1 font-display text-lg font-semibold text-gradient font-tabular"
              data-testid="calc-payment"
            >
              {payment === null ? "—" : formatUsd2(payment)}
            </p>
          </div>
          <div className="panel-inset p-2">
            <p className="label-eyebrow">Interest</p>
            <p className="mt-1 font-mono text-sm text-foreground font-tabular">
              {formatUsd(totalInterest)}
            </p>
          </div>
          <div className="panel-inset p-2">
            <p className="label-eyebrow">Fee 1 %</p>
            <p className="mt-1 font-mono text-sm text-foreground font-tabular">
              {formatUsd(p > 0 ? originationFee(p) : 0)}
            </p>
          </div>
        </div>
        {offer ? (
          <p className="text-xs text-muted-foreground">
            {offer.lenderName}: {offer.minTermMonths}–{offer.maxTermMonths} months, up to{" "}
            {Math.round(offer.maxLtv * 100)} % of the collateral value
            {collateral ? ` (max ${formatUsd(maxPrincipal)} on ${collateral.registration})` : ""}.
          </p>
        ) : null}
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex min-w-40 flex-1 flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Collateral</span>
            <select
              className={inputClass}
              value={collateral?.id ?? ""}
              onChange={(e) => setCollateralId(e.target.value)}
              aria-label="Collateral"
            >
              {pledgeable.length === 0 ? (
                <option value="">No unencumbered owned aircraft</option>
              ) : null}
              {pledgeable.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.registration} · {formatUsd(a.value)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={primaryButton}
            disabled={!enabled || busy || !offer?.eligible || !collateral || payment === null}
            title={!enabled ? disabledNote : offer?.eligible ? undefined : offer?.reason}
            data-testid="take-loan"
            onClick={() =>
              offer && collateral
                ? void run(
                    "loan.take",
                    {
                      lenderId: offer.lenderId,
                      principal: p,
                      termMonths: n,
                      collateral: { type: "aircraft", id: collateral.id },
                    },
                    `Loan from ${offer.lenderName} disbursed`,
                  )
                : undefined
            }
          >
            Take loan
          </button>
        </div>
      </div>
    </div>
  );
}
