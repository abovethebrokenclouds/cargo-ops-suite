import { createFileRoute } from "@tanstack/react-router";
import {
  BarChart3,
  Building2,
  CheckCircle2,
  Landmark,
  ListOrdered,
  Medal,
  Trophy,
} from "lucide-react";
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

function Company() {
  const { state } = useSimConnection();
  const command = useCommand();
  const lookup = useAirportLookup();
  const view = useCompanyView(state, lookup);
  const { company, fleet, loans, ledger, fbos, source, connector, demo } = view;
  const milestones = company?.milestones ?? [];
  const fboMonth = company?.clock ? company.clock.month - 1 : null;
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
            eyebrow="FBOs"
            title="Monthly P&L per FBO"
            icon={Building2}
            action={<SourceTag source={fbos ? source : null} />}
            bodyClassName="p-2 md:p-3"
          >
            {fbos && fbos.fbos.length > 0 ? (
              <table className="w-full text-sm" data-testid="fbo-pnl-lines">
                <thead>
                  <tr className="label-eyebrow text-left">
                    <th className="px-3 py-2 font-normal">FBO</th>
                    <th className="px-3 py-2 text-right font-normal">Income</th>
                    <th className="px-3 py-2 text-right font-normal">Upkeep</th>
                    <th className="px-3 py-2 text-right font-normal">Net</th>
                    <th className="hidden px-3 py-2 text-right font-normal md:table-cell">
                      Own-fleet savings
                    </th>
                  </tr>
                </thead>
                <tbody className="font-mono font-tabular">
                  {fbos.fbos.map((f) => {
                    const m = f.pnl.find((p) => p.month === fboMonth) ?? null;
                    return (
                      <tr key={f.id} className="border-t border-border">
                        <td className="px-3 py-2 text-foreground">
                          {f.icao}
                          <span className="ml-2 text-xs text-muted-foreground">
                            M{(fboMonth ?? 0) + 1}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right text-success">
                          {formatUsd(m?.income ?? 0)}
                        </td>
                        <td className="px-3 py-2 text-right text-destructive">
                          {formatUsd(m?.upkeep ?? 0)}
                        </td>
                        <td
                          className={cn(
                            "px-3 py-2 text-right",
                            (m?.net ?? 0) >= 0 ? "text-foreground" : "text-destructive",
                          )}
                        >
                          {formatUsd(m?.net ?? 0)}
                        </td>
                        <td className="hidden px-3 py-2 text-right text-muted-foreground md:table-cell">
                          {formatUsd(m?.savings ?? 0)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            ) : (
              <p className="p-3 text-sm text-muted-foreground">
                No FBO yet: buy or build one on the FBOs page. Its income (fbo_income) and upkeep
                (fbo_upkeep) lines land in the ledger below.
              </p>
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
          <Panel
            eyebrow="Progress"
            title={`Milestones · ${milestones.filter((m) => m.reached).length} / ${milestones.length || 8}`}
            icon={Trophy}
            action={<SourceTag source={company?.milestones ? source : null} />}
          >
            {milestones.length > 0 ? (
              <ul className="flex flex-col gap-2.5" data-testid="milestones">
                {milestones.map((m) => (
                  <li
                    key={m.id}
                    className="flex items-start gap-3 text-sm"
                    data-testid="milestone"
                    data-reached={m.reached ? "true" : "false"}
                  >
                    {m.reached ? (
                      <CheckCircle2
                        className="mt-0.5 size-4 shrink-0 text-success"
                        aria-hidden="true"
                      />
                    ) : (
                      <span
                        className="status-dot mt-1.5 size-2 shrink-0 text-muted-foreground/50"
                        aria-hidden="true"
                      />
                    )}
                    <div className="min-w-0">
                      <p className={m.reached ? "text-foreground" : "text-muted-foreground"}>
                        {m.title}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {m.reached && m.gameMs !== undefined
                          ? `${formatGameTime(m.gameMs)}${m.at ? ` · ${m.at.slice(0, 10)}` : ""}`
                          : m.description}
                      </p>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                Milestones appear with the company (first delivery, 100 hours, first FBO, debt-free,
                a perfect landing streak, …).
              </p>
            )}
          </Panel>
        </div>
      </div>
    </>
  );
}
