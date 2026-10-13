import { createFileRoute } from "@tanstack/react-router";
import { BarChart3, Landmark, Trophy } from "lucide-react";

import { PageHero } from "@/components/AppNav";
import { EmptyState } from "@/components/EmptyState";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { Panel } from "@/components/dashboard/Panel";
import { formatUsd } from "@/lib/format";
import { company } from "@/lib/mock-data";

export const Route = createFileRoute("/company")({
  head: () => ({
    meta: [
      { title: "Company — Cargo Ops" },
      {
        name: "description",
        content: "Cash, reputation, revenue and expenses, loans and milestones.",
      },
      { property: "og:title", content: "Company — Cargo Ops" },
      {
        property: "og:description",
        content: "Cash, reputation, revenue and expenses, loans and milestones.",
      },
    ],
  }),
  component: Company,
});

function Company() {
  return (
    <>
      <PageHero
        eyebrow={company.name}
        title="Company"
        sub="Reputation opens bigger contracts and better aircraft. Every dollar is on the ledger."
      />
      <div className="grid-ops">
        <MetricTile
          className="col-span-12 md:col-span-6"
          label="Reputation"
          value={null}
          unit="/ 100"
          size="xl"
          hint="Reputation scoring arrives in P4."
        />
        <MetricTile
          className="col-span-12 md:col-span-6"
          label="Cash"
          value={company.cash}
          format={formatUsd}
          size="xl"
          source="demo"
        />
        <Panel
          className="col-span-12 lg:col-span-8"
          eyebrow="Ledger"
          title="Revenue and expenses"
          icon={BarChart3}
        >
          <EmptyState
            icon={BarChart3}
            title="No ledger entries yet"
            description="Payouts, fuel, fees, wear and loan payments are charted here once the economy lands in P4."
          />
        </Panel>
        <div className="col-span-12 flex flex-col gap-3 md:gap-4 lg:col-span-4">
          <Panel eyebrow="Finance" title="Loans" icon={Landmark}>
            <p className="text-sm text-muted-foreground">No loans. Lenders open in P4.</p>
          </Panel>
          <Panel eyebrow="Progress" title="Milestones" icon={Trophy}>
            <p className="text-sm text-muted-foreground">Milestones unlock as you fly.</p>
          </Panel>
        </div>
      </div>
    </>
  );
}
