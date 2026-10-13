import { createFileRoute } from "@tanstack/react-router";
import { BarChart3, Landmark, ListOrdered, Medal, Trophy } from "lucide-react";
import { useState } from "react";

import { formatGameTime, tierTable } from "@cargo-ops/economy";
import { PageHero } from "@/components/AppNav";
import { EmptyState } from "@/components/EmptyState";
import { LedgerTable } from "@/components/company/LedgerTable";
import { DtiGauge, LoansPanel } from "@/components/company/LoansPanel";
import { PnlChart } from "@/components/company/PnlChart";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { DemoTag, Panel } from "@/components/dashboard/Panel";
import { SourceTag } from "@/components/status/SourceTag";
import { useAirportLookup } from "@/lib/economy/board";
import { useCompanyView } from "@/lib/economy/company";
import { formatInt, formatUsd } from "@/lib/format";
import { useCommand, useSimConnection } from "@/lib/transport/useSimConnection";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/company")({
  head: () => ({
    meta: [
      { title: "Company — Cargo Ops" },
      {
        name: "description",
        content: "Cash, reputation, credit, revenue and expenses, loans and milestones.",
      },
      { property: "og:title", content: "Company — Cargo Ops" },
      {
        property: "og:description",
        content: "Cash, reputation, credit, revenue and expenses, loans and milestones.",
      },
    ],
  }),
  component: Company,
});

const MILESTONES = [
  "First delivery",
  "100 flight hours",
  "Debt-free",
  "Perfect landing streak",
  "First FBO",
];

function Company() {
  const { state } = useSimConnection();
  const command = useCommand();
  const lookup = useAirportLookup();
  const view = useCompanyView(state, lookup);
  const { company, fleet, loans, ledger, source, connector, demo } = view;
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (name: string, args: unknown, success: string) => {
    setBusy(true);
    const r = await command(name, args);
    setBusy(false);
    setMessage(
      r.ok
        ? { ok: true, text: success }
        : { ok: false, text: `${r.error.message} (${r.error.code})` },
    );
    return r.ok;
  };
  const disabledNote = demo
    ? "Demo company: loans need the local connector"
    : !connector
      ? "Not connected to the connector"
      : undefined;
  const tiers = tierTable();
  const months = ledger?.months ?? [];
  const totals = months.reduce(
    (s, m) => ({ revenue: s.revenue + m.revenue, expense: s.expense + m.expense }),
    { revenue: 0, expense: 0 },
  );

  return (
    <>
      <PageHero
        eyebrow={company?.name ?? "Company"}
        title="Company"
        sub="Reputation opens bigger contracts and better aircraft. Every dollar is on the ledger."
      />
      <div className="grid-ops">
        {demo ? (
          <div
            className="panel-inset col-span-12 flex flex-wrap items-center gap-3 px-5 py-4 text-sm text-muted-foreground"
            data-testid="demo-company-note"
          >
            <DemoTag />A seeded demo company computed in your browser with the same economy code the
            connector runs. Loans, purchases and repairs are disabled: they need the local
            connector.
          </div>
        ) : null}

        <MetricTile
          className="col-span-12 lg:col-span-6"
          label="Cash"
          value={company?.cash ?? null}
          format={formatUsd}
          size="xl"
          source={company ? source : null}
          hint={
            company?.clock
              ? `Company clock: ${formatGameTime(company.clock.gameMs)}`
              : "Start the local connector to run your company."
          }
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="Reputation"
          value={company?.reputation ?? null}
          unit="/ 100"
          size="lg"
          source={company ? source : null}
          hint={company ? `Tier ${company.reputationTier} · ${company.tierName ?? ""}` : undefined}
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="Credit score"
          value={company?.creditScore ?? null}
          unit="/ 850"
          size="lg"
          source={company ? source : null}
          {...(loans?.defaultUntilGameMs
            ? { tone: "critical" as const, hint: "Halved after a default" }
            : { hint: "Reputation, cash flow, debt" })}
        />
        <MetricTile
          className="col-span-6 md:col-span-4"
          label="Net worth"
          value={company?.netWorth ?? null}
          format={formatUsd}
          size="md"
          source={company ? source : null}
        />
        <MetricTile
          className="col-span-6 md:col-span-4"
          label="Debt"
          value={company?.debt ?? null}
          format={formatUsd}
          size="md"
          source={company ? source : null}
        />
        <MetricTile
          className="col-span-12 md:col-span-4"
          label="Fleet value"
          value={fleet?.value ?? null}
          format={formatUsd}
          size="md"
          source={fleet ? source : null}
          hint={fleet ? `${formatInt(fleet.aircraft.length)} aircraft` : undefined}
        />

        <div className="col-span-12 flex flex-col gap-3 md:gap-4 xl:col-span-8">
          <Panel
            eyebrow="Operating P&L"
            title="Revenue and expenses by in-game month"
            icon={BarChart3}
            action={<SourceTag source={source} />}
          >
            {ledger && ledger.entries > 0 ? (
              <>
                <PnlChart months={months} />
                <p className="mt-3 flex flex-wrap gap-4 font-mono text-xs text-muted-foreground">
                  <span>
                    Revenue <span className="text-success">{formatUsd(totals.revenue)}</span>
                  </span>
                  <span>
                    Expense <span className="text-destructive">{formatUsd(totals.expense)}</span>
                  </span>
                  <span>Capital flows (purchases, sales, loan principal) are excluded.</span>
                </p>
              </>
            ) : (
              <EmptyState
                icon={BarChart3}
                title="No ledger entries yet"
                description="Payouts, fuel, landing fees, leases, repairs and loan payments are charted here as they happen."
              />
            )}
          </Panel>
          <Panel
            eyebrow="Ledger"
            title="Recent entries"
            icon={ListOrdered}
            action={<SourceTag source={source} />}
            bodyClassName="p-2 md:p-3"
          >
            {ledger && ledger.recent.length > 0 ? (
              <>
                <LedgerTable entries={ledger.recent} />
                <p className="px-3 pb-2 pt-3 text-xs text-muted-foreground">
                  {formatInt(ledger.entries)} entries since founding with{" "}
                  {formatUsd(ledger.startingCash)}. Every cash change is an entry; the balance
                  column is the running cash.
                </p>
              </>
            ) : (
              <p className="p-4 text-sm text-muted-foreground">No entries yet.</p>
            )}
          </Panel>
        </div>
        <div className="col-span-12 flex flex-col gap-3 md:gap-4 xl:col-span-4">
          <Panel
            eyebrow="Finance"
            title="Loans"
            icon={Landmark}
            action={<SourceTag source={source} />}
          >
            <div className="flex flex-col gap-5">
              <div className="flex items-center justify-around gap-4">
                <DtiGauge value={loans?.debtToIncome ?? null} />
                <dl className="flex flex-col gap-2 font-mono text-xs">
                  <div>
                    <dt className="text-muted-foreground">Debt service</dt>
                    <dd className="text-foreground font-tabular">
                      {formatUsd(loans?.monthlyDebtService ?? null)}/mo
                    </dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Income (3-mo avg)</dt>
                    <dd className="text-foreground font-tabular">
                      {formatUsd(loans?.monthlyIncome ?? null)}/mo
                    </dd>
                  </div>
                </dl>
              </div>
              <LoansPanel
                loans={loans}
                fleet={fleet}
                enabled={connector}
                disabledNote={disabledNote}
                busy={busy}
                run={run}
              />
              {demo ? (
                <p className="text-xs text-muted-foreground" data-testid="loan-disabled-note">
                  Taking and paying off loans is disabled in demo mode: it needs the connector.
                </p>
              ) : null}
              <p
                role="status"
                aria-live="polite"
                className={cn(
                  "min-h-5 text-sm",
                  message?.ok === false ? "text-destructive" : "text-success",
                )}
                data-testid="command-message"
              >
                {message?.text ?? ""}
              </p>
            </div>
          </Panel>
          <Panel eyebrow="Reputation" title="Tiers and gates" icon={Medal}>
            <ul className="flex flex-col gap-1.5" data-testid="tier-table">
              {tiers.map((t) => (
                <li
                  key={t.tier}
                  className={cn(
                    "flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-xs",
                    company?.reputationTier === t.tier
                      ? "bg-primary/15 text-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  <span className="font-semibold">
                    {t.tier} · {t.name}
                  </span>
                  <span className="font-mono">
                    {t.from}–{t.to}
                  </span>
                  <span className="truncate text-right">
                    {t.aircraftClasses.at(-1)?.replace("-", " ")}
                    {t.jobKinds.includes("hazmat")
                      ? " · hazmat"
                      : t.jobKinds.includes("medical")
                        ? " · medical"
                        : ""}
                  </span>
                </li>
              ))}
            </ul>
          </Panel>
          <Panel eyebrow="Progress" title="Milestones" icon={Trophy}>
            <ul className="flex flex-col gap-2 text-sm text-muted-foreground">
              {MILESTONES.map((m) => (
                <li key={m} className="flex items-center gap-2">
                  <span className="status-dot text-muted-foreground/50" aria-hidden="true" />
                  {m}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">Milestone tracking arrives in P5.</p>
          </Panel>
        </div>
      </div>
    </>
  );
}
