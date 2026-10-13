import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight, History, Package, Plane, Radio } from "lucide-react";

import { PageHero } from "@/components/AppNav";
import { EmptyState } from "@/components/EmptyState";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { DemoTag, Panel } from "@/components/dashboard/Panel";
import { KindBadge } from "@/components/cargo/MissionCard";
import { MissionStrip } from "@/components/cargo/MissionStrip";
import { ConnectedStatusChip } from "@/components/status/ConnectedStatusChip";
import { SourceTag } from "@/components/status/SourceTag";
import { routeView } from "@/lib/flight/flight-view";
import { EMPTY, formatMinutes, formatUsd } from "@/lib/format";
import { jobs } from "@/lib/mock-data";
import { useAirportLookup } from "@/lib/economy/board";
import { useCompanyView } from "@/lib/economy/company";
import { fuelEnduranceMin, type ClientSimState } from "@/lib/sim-state";
import { useSimConnection } from "@/lib/transport/useSimConnection";

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

const fleetStatus = {
  available: "Ready",
  in_flight: "Flying",
  maintenance: "Maintenance",
  sold: "Sold",
  returned: "Returned",
  repossessed: "Repossessed",
} as const;

const fleetTone: Record<string, string> = {
  Ready: "text-success",
  Flying: "text-accent",
  Maintenance: "text-warning",
  Grounded: "text-destructive",
};

function linkCopy(state: ClientSimState): string {
  switch (state.connection) {
    case "demo":
      return "Replaying the built-in demo flight; telemetry tiles are tagged DEMO. Run the local connector to bridge SimConnect to this app. The chip switches to live only after a real handshake.";
    case "replay":
      return "The connector is replaying a recorded flight; values are tagged REPLAY.";
    case "live":
      return state.welcome?.sim.connected || state.sim.sim?.connected
        ? "Connected to the local connector with the simulator running."
        : "Connected to the local connector. Start the simulator to stream telemetry.";
    case "disconnected":
    case "error":
      return "The local connector is not reachable. Start it, then this page reconnects automatically.";
    default:
      return "Connecting to the simulator link…";
  }
}

function Index() {
  const { state } = useSimConnection();
  const lookup = useAirportLookup();
  const view = useCompanyView(state, lookup);
  const liveJobs = state.connection === "demo" ? null : (state.sim.jobs ?? null);
  const liveCompany = view.company;
  const fleetList = view.fleet?.aircraft ?? [];
  const liveNext =
    liveJobs?.available.reduce<(typeof liveJobs.available)[number] | null>(
      (best, j) => (!best || j.payoutEstimate > best.payoutEstimate ? j : best),
      null,
    ) ?? null;
  const next = liveNext
    ? {
        id: liveNext.id,
        from: liveNext.origin,
        to: liveNext.destination,
        cargo: liveNext.kind,
        weightKg: liveNext.weightKg,
        payout: liveNext.payoutEstimate,
        deadline: formatMinutes(liveNext.timeLimitMin),
      }
    : liveJobs
      ? null
      : jobs[0];
  const route = routeView(state);
  const endurance = fuelEnduranceMin(state.sim.fuel);
  const simName = state.sim.sim?.name ?? state.welcome?.sim.name ?? null;
  const protocol = state.welcome?.sim.protocol ?? null;
  return (
    <>
      <PageHero
        eyebrow={`Ops centre · Hub ${liveCompany?.base ?? "KMEM"}`}
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
        <MissionStrip
          mission={state.sim.mission ?? null}
          source={state.source}
          className="col-span-12"
        />
        <MetricTile
          className="col-span-12 md:col-span-6 xl:col-span-4"
          label="Company cash"
          value={liveCompany ? liveCompany.cash : null}
          format={formatUsd}
          size="xl"
          source={liveCompany ? view.source : null}
          hint={
            liveCompany ? (
              <span data-testid="dashboard-reputation">
                Reputation {liveCompany.reputation} / 100 · tier {liveCompany.reputationTier}
                {liveCompany.tierName ? ` ${liveCompany.tierName}` : ""}
                {liveCompany.creditScore !== undefined
                  ? ` · credit ${liveCompany.creditScore}`
                  : ""}
              </span>
            ) : view.demo ? (
              "Building the demo company…"
            ) : (
              "Start the local connector to run your company."
            )
          }
        />
        <MetricTile
          className="col-span-12 sm:col-span-6 xl:col-span-4"
          label="Active mission ETE"
          value={route.eteMin}
          format={formatMinutes}
          size="xl"
          source={route.eteMin === null ? null : state.source}
          hint={
            route.origin && route.destination
              ? `${route.origin} → ${route.destination} · from the sim flight plan`
              : "No active flight plan."
          }
        />
        <MetricTile
          className="col-span-12 sm:col-span-6 xl:col-span-4"
          label="Fuel endurance"
          value={endurance}
          format={formatMinutes}
          size="xl"
          source={endurance === null ? null : state.source}
          hint={
            endurance === null
              ? "Needs fuel quantity and flow from the simulator."
              : "At the current total fuel flow."
          }
        />

        <Panel
          className="col-span-12 lg:col-span-5"
          eyebrow="Connection"
          title="Simulator link"
          icon={Radio}
        >
          <div className="flex flex-col gap-5">
            <ConnectedStatusChip className="self-start" />
            <p className="text-sm text-muted-foreground">{linkCopy(state)}</p>
            <dl className="grid grid-cols-2 gap-3 font-mono text-xs">
              <div className="panel-inset p-3">
                <dt className="text-muted-foreground">Simulator</dt>
                <dd className="mt-1 truncate text-foreground">{simName ?? EMPTY}</dd>
              </div>
              <div className="panel-inset p-3">
                <dt className="text-muted-foreground">Protocol</dt>
                <dd className="mt-1 truncate text-foreground">{protocol ?? EMPTY}</dd>
              </div>
            </dl>
          </div>
        </Panel>

        <Panel
          className="col-span-12 lg:col-span-7"
          eyebrow="Dispatch"
          title="Next best job"
          icon={Package}
          action={liveJobs ? <SourceTag source={state.source} /> : <DemoTag />}
        >
          {next ? (
            <div className="flex flex-wrap items-end justify-between gap-6">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-mono text-xs text-muted-foreground">
                  {next.id} · {liveNext ? `${next.deadline} limit` : `due in ${next.deadline}`}
                  {liveNext ? <KindBadge kind={liveNext.kind} /> : null}
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
          action={<SourceTag source={view.fleet ? view.source : null} />}
        >
          {fleetList.length === 0 ? (
            <EmptyState
              icon={Plane}
              title={view.demo ? "Building the demo fleet…" : "No fleet data"}
              description={
                view.demo ? undefined : "Start the local connector to manage your fleet."
              }
            />
          ) : (
            <ul className="flex flex-col gap-2" data-testid="dashboard-fleet">
              {fleetList.map((a) => {
                const status = !a.airworthy ? "Grounded" : fleetStatus[a.status];
                return (
                  <li
                    key={a.id}
                    className="panel-inset flex items-center justify-between gap-3 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="font-mono text-sm font-semibold text-foreground">
                        {a.registration}
                        {view.fleet?.selectedId === a.id ? (
                          <span className="ml-2 text-[0.625rem] uppercase tracking-[0.16em] text-accent">
                            active
                          </span>
                        ) : null}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {a.typeName} · {a.location} · {a.condition.toFixed(1)} %
                      </p>
                    </div>
                    <span className={`flex items-center gap-2 text-xs ${fleetTone[status]}`}>
                      <span className="status-dot" aria-hidden="true" />
                      {status}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
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
