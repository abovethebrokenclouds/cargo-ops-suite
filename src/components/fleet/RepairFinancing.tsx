import { useState } from "react";
import { ShieldCheck } from "lucide-react";

import type { FleetAircraft } from "@cargo-ops/protocol";
import { formatGameTime, repairLoanTerms } from "@cargo-ops/economy";
import { inputClass, primaryButton } from "@/components/company/styles";
import { DemoTag } from "@/components/dashboard/Panel";
import { formatUsd, formatUsdCents } from "@/lib/format";

import type { RunCommand } from "./AircraftMarket";

type Choice = "overhaul" | "all";

/**
 * "Finance with insurer" in the repair flow (docs/ECONOMY.md "Insurer repair loans"): an
 * insured, owned aircraft orders the wear overhaul or every open defect repair and the
 * insurer lends up to the bill (cost − incident claim) at a fixed APR. Missed payments never
 * repossess; three in a row cancel the policy and move the balance to cash. In demo mode the
 * form is shown tagged DEMO with every control disabled.
 */
export function RepairFinancing({
  aircraft: a,
  enabled,
  demo,
  disabledNote,
  busy,
  run,
}: {
  aircraft: FleetAircraft;
  enabled: boolean;
  demo: boolean;
  disabledNote?: string | undefined;
  busy: boolean;
  run: RunCommand;
}) {
  const ins = a.insurance;
  const view = ins?.repairLoan;
  const choices: Array<{ value: Choice; label: string; bill: number }> = [];
  if (view?.overhaulBill != null && view.overhaulBill > 0) {
    choices.push({ value: "overhaul", label: "Wear overhaul", bill: view.overhaulBill });
  }
  if (view?.allDefectsBill != null && view.allDefectsBill > 0) {
    choices.push({
      value: "all",
      label: "All open defects (after the incident claim)",
      bill: view.allDefectsBill,
    });
  }
  const [choiceKey, setChoiceKey] = useState<Choice | "">("");
  const choice = choices.find((c) => c.value === choiceKey) ?? choices[0] ?? null;
  const [amountText, setAmountText] = useState("");
  const [termText, setTermText] = useState("12");
  const amount = amountText === "" ? (choice?.bill ?? 0) : Math.max(0, Number(amountText) || 0);
  const term = Math.floor(Number(termText) || 0);
  if (!ins || !view) return null;

  const open = view.open;
  const hired = a.status === "hired";
  const termOk = term >= view.minTermMonths && term <= view.maxTermMonths;
  const amountOk = choice !== null && amount >= view.minAmount && amount <= choice.bill;
  const terms = amountOk && termOk ? repairLoanTerms(amount, term) : null;
  const blocked = !ins.insured
    ? "Insure the aircraft first: repair loans need an active hull policy"
    : hired
      ? "Assigned to a hired pilot (simulated route): unassign the pilot first"
      : open
        ? "One open repair loan per aircraft: pay it off first"
        : choices.length === 0
          ? "Nothing to repair right now"
          : null;
  const canSubmit = enabled && !busy && blocked === null && terms !== null;

  return (
    <div className="flex flex-col gap-3" data-testid="repair-financing">
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        {demo ? <DemoTag /> : null}
        <ShieldCheck className="size-4 text-accent" aria-hidden="true" />
        Hull insurer: {view.apr.toFixed(2)} % fixed, {view.minTermMonths}–{view.maxTermMonths}{" "}
        months, no fee. A missed payment costs a late fee and 5 reputation but never repossesses the
        aircraft; three in a row cancel the policy and move the balance to cash.
      </p>

      {open ? (
        <div className="panel-inset flex flex-col gap-1 p-3 text-sm" data-testid="open-repair-loan">
          <p className="text-foreground">
            Open repair loan <span className="font-mono text-xs">{open.loanId}</span>:{" "}
            {formatUsd(open.balance)} left · {formatUsdCents(open.payment)}/mo · next{" "}
            {formatGameTime(open.nextDueGameMs)}
          </p>
          {open.missedCount > 0 ? (
            <p className="text-xs text-destructive">
              {open.missedCount} missed payment{open.missedCount > 1 ? "s" : ""}: the third in a row
              cancels the policy and moves the balance to cash.
            </p>
          ) : null}
        </div>
      ) : null}

      {blocked ? (
        <p className="text-xs text-muted-foreground" data-testid="repair-financing-blocked">
          {blocked}
        </p>
      ) : null}

      {choices.length > 0 && !open ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Repair</span>
            <select
              className={inputClass}
              value={choice?.value ?? ""}
              disabled={!enabled}
              onChange={(e) => {
                setChoiceKey(e.target.value as Choice);
                setAmountText("");
              }}
              aria-label="Repair to finance"
            >
              {choices.map((c) => (
                <option key={c.value} value={c.value}>
                  {c.label} · bill {formatUsdCents(c.bill)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Amount ($)</span>
            <input
              className={inputClass}
              inputMode="decimal"
              value={amountText === "" ? String(choice?.bill ?? "") : amountText}
              disabled={!enabled}
              onChange={(e) => setAmountText(e.target.value.replace(/[^0-9.]/g, ""))}
              aria-label="Repair loan amount"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">Term (months)</span>
            <input
              className={inputClass}
              inputMode="numeric"
              value={termText}
              disabled={!enabled}
              onChange={(e) => setTermText(e.target.value.replace(/[^0-9]/g, ""))}
              aria-label="Repair loan term"
            />
          </label>
        </div>
      ) : null}

      {choices.length > 0 && !open ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="font-mono text-xs text-muted-foreground" data-testid="repair-loan-quote">
            {terms
              ? `${formatUsdCents(terms.payment)}/mo · ${formatUsdCents(terms.totalInterest)} interest`
              : !termOk
                ? `Term ${view.minTermMonths}–${view.maxTermMonths} months`
                : `Amount ${formatUsd(view.minAmount)}–${formatUsdCents(choice?.bill ?? 0)}`}
          </p>
          <button
            type="button"
            className={primaryButton}
            disabled={!canSubmit}
            title={!enabled ? disabledNote : (blocked ?? undefined)}
            data-testid="finance-with-insurer"
            onClick={() =>
              choice
                ? void run(
                    "insurance.repairLoan",
                    {
                      aircraftId: a.id,
                      repair: choice.value,
                      principal: amount,
                      termMonths: term,
                    },
                    `${a.registration}: repair ordered, financed by the insurer`,
                  )
                : undefined
            }
          >
            Finance with insurer
          </button>
        </div>
      ) : null}
    </div>
  );
}
