import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, History, Package, Plane, Radio } from "lucide-react";

import { PageHero } from "@/components/AppNav";
import { EmptyState } from "@/components/EmptyState";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { DemoTag, Panel } from "@/components/dashboard/Panel";
import { SimStatusChip } from "@/components/status/SimStatusChip";
import { formatMinutes, formatUsd } from "@/lib/format";
import { company, fleet, jobs } from "@/lib/mock-data";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Ops Dashboard — Cargo Ops" },
      {
        name: "description",
        content: "Run your MSFS 2020/2024 cargo operation: connection, missions, fleet and cash.",
      },
      { property: "og:title", content: "Ops Dashboard — Cargo Ops" },
      {
        property: "og:description",
        content: "Run your MSFS 2020/2024 cargo operation: connection, missions, fleet and cash.",
      },
    ],
  }),
  component: Index,
});

const fleetTone = {
  Ready: "text-success",
  "En route": "text-accent",
  Maintenance: "text-warning",
} as const;

function Index() {
  const next = jobs[0];
  return (
    <>
      <PageHero
        eyebrow={`Ops centre · Hub ${company.hub}`}
        title="Move the world."
        sub="Your cargo operation for Microsoft Flight Simulator 2020 and 2024. Dispatch, fly, get paid."
      >
        <Link
          to="/flight"
          className="inline-flex items-center gap-2 rounded-xl bg-gradient-brand px-5 py-3 text-sm font-semibold text-primary-foreground shadow-glow transition-transform hover:scale-[1.03]"
        >
          Live Flight <ArrowRight className="size-4" aria-hidden="true" />
        </Link>
      </PageHero>

      <div className="grid-ops">
        <MetricTile
          className="col-span-12 md:col-span-6 xl:col-span-4"
          label="Company cash"
          value={company.cash}
          format={formatUsd}
          size="xl"
          source="demo"
          hint="Demo seed balance. The ledger arrives in P4."
        />
        <MetricTile
          className="col-span-12 sm:col-span-6 xl:col-span-4"
          label="Active mission ETE"
          value={null}
          format={formatMinutes}
          size="xl"
          hint="No active mission."
        />
        <MetricTile
          className="col-span-12 sm:col-span-6 xl:col-span-4"
          label="Fuel endurance"
          value={null}
          format={formatMinutes}
          size="xl"
          hint="Needs a live simulator connection."
        />

        <Panel
          className="col-span-12 lg:col-span-5"
          eyebrow="Connection"
          title="Simulator link"
          icon={Radio}
        >
          <div className="flex flex-col gap-5">
            <SimStatusChip status="demo" className="self-start" />
            <p className="text-sm text-muted-foreground">
              Showing demo seed data. The local connector (P1) bridges SimConnect to this app; the
              chip switches to live only after a real handshake.
            </p>
            <dl className="grid grid-cols-2 gap-3 font-mono text-xs">
              <div className="panel-inset p-3">
                <dt className="text-muted-foreground">Simulator</dt>
                <dd className="mt-1 text-foreground">—</dd>
              </div>
              <div className="panel-inset p-3">
                <dt className="text-muted-foreground">Protocol</dt>
                <dd className="mt-1 text-foreground">—</dd>
              </div>
            </dl>
          </div>
        </Panel>

        <Panel
          className="col-span-12 lg:col-span-7"
          eyebrow="Dispatch"
          title="Next best job"
          icon={Package}
          action={<DemoTag />}
        >
          {next ? (
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="min-w-0">
                <p className="font-mono text-xs text-muted-foreground">
                  {next.id} · due in {next.deadline}
                </p>
                <p className="mt-2 font-display text-4xl font-bold tracking-tight md:text-5xl">
                  {next.from} <span className="text-gradient">→</span> {next.to}
                </p>
                <p className="mt-2 text-muted-foreground">
                  {next.cargo} ·{" "}
                  <span className="font-tabular">{next.weightKg.toLocaleString("en-US")}</span> kg
                </p>
              </div>
              <div className="sm:text-right">
                <p className="label-eyebrow">Payout</p>
                <p className="metric-lg mt-2">{formatUsd(next.payout)}</p>
                <Link
                  to="/jobs"
                  className="mt-4 inline-flex items-center gap-2 text-sm font-medium text-accent hover:text-foreground"
                >
                  Job board <ArrowRight className="size-4" aria-hidden="true" />
                </Link>
              </div>
            </div>
          ) : (
            <EmptyState icon={Package} title="No jobs available" />
          )}
        </Panel>

        <Panel
          className="col-span-12 lg:col-span-5"
          eyebrow="Hangar"
          title="Fleet summary"
          icon={Plane}
          action={<DemoTag />}
        >
          <ul className="flex flex-col gap-2">
            {fleet.map((a) => (
              <li
                key={a.reg}
                className="panel-inset flex items-center justify-between gap-3 px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="font-mono text-sm font-semibold text-foreground">{a.reg}</p>
                  <p className="truncate text-xs text-muted-foreground">{a.type}</p>
                </div>
                <span className={`flex items-center gap-2 text-xs ${fleetTone[a.status]}`}>
                  <span className="status-dot" aria-hidden="true" />
                  {a.status}
                </span>
              </li>
            ))}
          </ul>
        </Panel>

        <Panel
          className="col-span-12 lg:col-span-7"
          eyebrow="Logbook"
          title="Recent flights"
          icon={History}
        >
          <EmptyState
            icon={History}
            title="No flights logged yet"
            description="Completed flights appear here with landing grade, distance and payload once tracking lands in P2–P3."
          />
        </Panel>
      </div>
    </>
  );
}
