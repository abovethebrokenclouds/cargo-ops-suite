import { createFileRoute } from "@tanstack/react-router";
import { Clock, Package, Weight } from "lucide-react";

import { PageHero } from "@/components/AppNav";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { DemoTag } from "@/components/dashboard/Panel";
import { formatInt, formatUsd } from "@/lib/format";
import { jobs } from "@/lib/mock-data";

export const Route = createFileRoute("/jobs")({
  head: () => ({
    meta: [
      { title: "Job Board — Cargo Ops" },
      {
        name: "description",
        content: "Browse cargo contracts for your MSFS 2020/2024 fleet.",
      },
      { property: "og:title", content: "Job Board — Cargo Ops" },
      {
        property: "og:description",
        content: "Browse cargo contracts for your MSFS 2020/2024 fleet.",
      },
    ],
  }),
  component: Jobs,
});

function Jobs() {
  const totalPayout = jobs.reduce((sum, j) => sum + j.payout, 0);
  const totalWeight = jobs.reduce((sum, j) => sum + j.weightKg, 0);
  return (
    <>
      <PageHero
        eyebrow="Job board"
        title="Cargo Jobs"
        sub="Contracts available from your bases. Generated jobs, filters and the route finder arrive in P3."
      />

      <div className="grid-ops">
        <MetricTile
          className="col-span-12 md:col-span-6"
          label="Open payout"
          value={totalPayout}
          format={formatUsd}
          size="xl"
          source="demo"
        />
        <MetricTile
          className="col-span-6 md:col-span-3"
          label="Contracts"
          value={jobs.length}
          source="demo"
        />
        <MetricTile
          className="col-span-6 md:col-span-3"
          label="Total load"
          value={totalWeight}
          unit="kg"
          source="demo"
        />

        <ul className="col-span-12 flex flex-col gap-3" aria-label="Contracts">
          {jobs.map((j) => (
            <li
              key={j.id}
              className="panel-elevated grid grid-cols-1 gap-5 p-5 md:grid-cols-[1fr_auto] md:items-center md:p-6"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-xs text-muted-foreground">{j.id}</span>
                  <DemoTag />
                </div>
                <p className="mt-2 font-display text-3xl font-bold tracking-tight md:text-4xl">
                  {j.from} <span className="text-gradient">→</span> {j.to}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-2 text-sm text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Package className="size-4 text-accent" aria-hidden="true" />
                    {j.cargo}
                  </span>
                  <span className="flex items-center gap-1.5 font-tabular">
                    <Weight className="size-4 text-accent" aria-hidden="true" />
                    {formatInt(j.weightKg)} kg
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Clock className="size-4 text-accent" aria-hidden="true" />
                    due in {j.deadline}
                  </span>
                </div>
              </div>
              <div className="flex items-end justify-between gap-4 md:flex-col md:items-end">
                <div className="md:text-right">
                  <p className="label-eyebrow">Payout</p>
                  <p className="metric-md mt-1">{formatUsd(j.payout)}</p>
                </div>
                <button
                  type="button"
                  disabled
                  title="Dispatch arrives in P3"
                  className="rounded-lg border border-border bg-secondary px-4 py-2 text-sm font-medium text-muted-foreground disabled:cursor-not-allowed"
                >
                  Accept · P3
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}
