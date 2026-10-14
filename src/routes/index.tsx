import { createFileRoute, Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useMemo } from "react";

import { KindBadge } from "@/components/cargo/MissionCard";
import { MissionStrip } from "@/components/cargo/MissionStrip";
import { PayloadCheckPill } from "@/components/cargo/PayloadCheck";
import { ConsolePanel, ConsoleRow } from "@/components/ops/Console";
import { EventLoop } from "@/components/ops/EventLoop";
import { FrontWall } from "@/components/ops/FrontWall";
import { GoNoGoBoard } from "@/components/ops/GoNoGoBoard";
import { WeatherConsole } from "@/components/ops/WeatherConsole";
import { ConnectedStatusChip } from "@/components/status/ConnectedStatusChip";
import { DemoTag } from "@/components/dashboard/Panel";
import {
  enginesRunning,
  flightSummary,
  isSessionUp,
  isStale,
  routeView,
  totalFuelFlowPph,
  weightsView,
} from "@/lib/flight/flight-view";
import { EMPTY, formatDegrees, formatInt, formatMinutes, formatUsd } from "@/lib/format";
import { jobs } from "@/lib/mock-data";
import { useAirportLookup } from "@/lib/economy/board";
import { useCompanyView } from "@/lib/economy/company";
import { useLogbook } from "@/lib/economy/logbook";
import { connectionEmpty } from "@/lib/connection-empty";
import { goNoGoLamps } from "@/lib/ops/mission-control";
import { altitudeFromFt, formatWeightLb, useUnits } from "@/lib/settings/units";
import { fuelEnduranceMin, type ClientSimState } from "@/lib/sim-state";
import { useNow } from "@/lib/sim-state/hooks";
import { useSimConnection } from "@/lib/transport/useSimConnection";
import { cn } from "@/lib/utils";
import { useMetar } from "@/lib/weather/use-metar";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Flight Operations — Cargo Ops" },
      {
        name: "description",
        content:
          "Flight operations room for your MSFS 2020/2024 cargo operation: front wall, go / no-go board, consoles and event loop.",
      },
      { property: "og:title", content: "Flight Operations — Cargo Ops" },
      {
        property: "og:description",
        content:
          "Flight operations room for your MSFS 2020/2024 cargo operation: front wall, go / no-go board, consoles and event loop.",
      },
    ],
  }),
  component: Index,
});

const fleetStatus = {
  available: "READY",
  in_flight: "FLYING",
  maintenance: "MAINT",
  sold: "SOLD",
  returned: "RETURNED",
  repossessed: "REPOSSESSED",
  written_off: "WRITTEN OFF",
  hired: "HIRED PILOT (SIM.)",
} as const;

const fleetTone: Record<string, string> = {
  READY: "text-phosphor-green",
  FLYING: "text-phosphor-cyan",
  MAINT: "text-phosphor-amber",
  GROUNDED: "text-phosphor-red",
  "FERRY ONLY": "text-phosphor-amber",
  "ANNUAL DUE": "text-phosphor-amber",
};

const gateLabel = { grounded: "GROUNDED", ferry_only: "FERRY ONLY", annual_due: "ANNUAL DUE" };

function linkCopy(state: ClientSimState): string {
  switch (state.connection) {
    case "demo":
      return "Replaying the built-in demo flight; values are tagged DEMO. Run the local connector to bridge SimConnect to this app. The chip switches to live only after a real handshake.";
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

function loopEmpty(state: ClientSimState): string {
  switch (state.connection) {
    case "live":
    case "demo":
    case "replay":
      return "No events yet. Simulator, flight and phase events appear here as they arrive.";
    case "disconnected":
    case "error":
      return "NO DATA: the connector is offline.";
    default:
      return "NO DATA: waiting for the connector welcome.";
  }
}

const pct = (n: number | null) => (n === null ? null : `${Math.round(n * 100)} %`);

function Index() {
  const { state, transportKind } = useSimConnection();
  const now = useNow(1000);
  const [units] = useUnits();
  const lookup = useAirportLookup();
  const view = useCompanyView(state, lookup);
  const up = isSessionUp(state);
  const stale = isStale(state, now);
  const source = up ? state.source : null;

  // ---- dispatch (next best job) ----
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
    : !liveJobs && state.connection === "demo"
      ? jobs[0]
      : null;
  const offline = connectionEmpty(state);
  const logbook = useLogbook(state);
  const recent = logbook.entries?.slice(0, 5) ?? null;

  // ---- telemetry ----
  const route = routeView(state);
  const motion = up ? (state.sim.motion ?? null) : null;
  const position = up ? (state.sim.position ?? null) : null;
  const fuel = up ? (state.sim.fuel ?? null) : null;
  const plan = up ? (state.sim.plan ?? null) : null;
  const endurance = fuelEnduranceMin(fuel);
  const flow = totalFuelFlowPph(fuel);
  const engines = enginesRunning(up ? state.sim.engines : null);
  const summary = flightSummary(up ? state.sim.flight : null);
  const weights = weightsView(up ? state.sim.weights : null);
  const mission = state.sim.mission ?? null;
  const simName = state.sim.sim?.name ?? state.welcome?.sim.name ?? null;
  const protocol = state.welcome?.sim.protocol ?? null;
  const aircraft = up ? (state.sim.aircraft ?? null) : null;

  // ---- weather (one request feeds the WX console and the WX lamp) ----
  const origin = route.origin ?? mission?.origin ?? null;
  const destination = route.destination ?? mission?.destination ?? null;
  const metar = useMetar([origin, destination]);
  const destReport =
    metar.status === "ready" && destination
      ? (metar.data.stations.find((s) => s.station === destination.toUpperCase())?.report ?? null)
      : null;

  const lamps = useMemo(
    () =>
      goNoGoLamps({
        state,
        now,
        fleet: view.fleet,
        fleetSource: view.fleet ? view.source : null,
        weather: {
          station: destination,
          category: destReport?.category ?? null,
          sample: destReport?.origin === "sample",
          source: destReport ? (state.connection === "demo" ? "demo" : state.source) : null,
        },
      }),
    [state, now, view.fleet, view.source, destination, destReport],
  );

  return (
    <div className="console-room mb-8 mt-6 p-3 sm:p-4 md:mt-8 md:p-5" data-testid="ops-room">
      {/* Room header */}
      <header className="relative z-10 flex flex-col gap-3 pb-4 md:flex-row md:items-end md:justify-between">
        <div className="min-w-0">
          <p className="readout-label flex items-center gap-2 text-phosphor-amber">
            <span className="status-dot size-1.5 text-phosphor-amber" aria-hidden="true" />
            Cargo Ops · {liveCompany ? `Hub ${liveCompany.base}` : "Ops centre"}
          </p>
          <h1 className="mt-2 font-mono text-2xl font-bold uppercase tracking-[0.14em] text-console-foreground sm:text-3xl md:text-4xl">
            Flight Operations
          </h1>
          <p className="mt-1 max-w-2xl text-sm text-muted-foreground">
            Your cargo operation for Microsoft Flight Simulator 2020 and 2024. Every lamp and
            readout comes from the connector; nothing is filled in.
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-3">
          <ConnectedStatusChip />
          <Link
            to="/flight"
            className="inline-flex items-center gap-2 rounded-sm border border-phosphor-green/50 bg-phosphor-green/10 px-4 py-2 font-mono text-xs font-semibold uppercase tracking-[0.18em] text-phosphor-green transition-colors hover:bg-phosphor-green/20"
          >
            Live Flight <ArrowRight className="size-4" aria-hidden="true" />
          </Link>
        </div>
      </header>

      <div className="relative z-10 flex flex-col gap-4">
        <FrontWall state={state} transportKind={transportKind} now={now} />

        <MissionStrip mission={mission} source={state.source} />

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
          <GoNoGoBoard lamps={lamps} className="xl:col-span-2" />
          <EventLoop events={state.events} source={state.source} emptyText={loopEmpty(state)} />
        </div>

        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {/* LINK */}
          <ConsolePanel
            callsign="LINK"
            title="Simulator link"
            source={state.welcome ? state.source : null}
            testId="console-link"
          >
            <div className="flex flex-col gap-3">
              <p className="text-xs text-muted-foreground">{linkCopy(state)}</p>
              <dl>
                <ConsoleRow label="Simulator" value={simName} />
                <ConsoleRow label="Protocol" value={protocol} />
                <ConsoleRow label="Aircraft" value={aircraft?.title ?? null} />
                <ConsoleRow label="Tail" value={aircraft?.atcId ?? null} tone="cyan" />
              </dl>
            </div>
          </ConsolePanel>

          {/* NAV */}
          <ConsolePanel
            callsign="NAV"
            title="Route and progress"
            source={plan ? source : null}
            stale={stale}
            testId="console-nav"
          >
            <dl>
              <ConsoleRow
                label="Route"
                value={
                  route.origin && route.destination
                    ? `${route.origin} → ${route.destination}`
                    : null
                }
                tone="cyan"
              />
              <ConsoleRow
                label="Dist to go"
                value={
                  route.distanceRemainingNm === null
                    ? null
                    : `${formatInt(route.distanceRemainingNm)} nm`
                }
                tone="green"
              />
              <ConsoleRow
                label="ETE"
                value={route.eteMin === null ? null : formatMinutes(route.eteMin)}
                tone="green"
              />
              <ConsoleRow label="Progress" value={pct(route.progress)} tone="green" />
              <ConsoleRow
                label="Next WPT"
                value={
                  plan?.nextWpId
                    ? `${plan.nextWpId}${plan.nextWpDistanceNm !== undefined ? ` · ${formatInt(plan.nextWpDistanceNm)} nm` : ""}`
                    : null
                }
              />
              <ConsoleRow
                label="Flown"
                value={route.flownNm === null ? null : `${formatInt(route.flownNm)} nm`}
              />
            </dl>
          </ConsolePanel>

          {/* PERF */}
          <ConsolePanel
            callsign="PERF"
            title="Aircraft performance"
            source={motion ? source : null}
            stale={stale}
            testId="console-perf"
          >
            <dl>
              <ConsoleRow
                label="IAS"
                value={motion ? `${formatInt(motion.iasKt)} kt` : null}
                tone="green"
              />
              <ConsoleRow
                label="TAS"
                value={motion ? `${formatInt(motion.tasKt)} kt` : null}
                tone="green"
              />
              <ConsoleRow
                label="G load"
                value={motion ? motion.gForce.toFixed(2) : null}
                tone="green"
              />
              <ConsoleRow
                label="AGL"
                value={
                  position
                    ? `${formatInt(altitudeFromFt(position.aglFt, units.altitude))} ${units.altitude}`
                    : null
                }
              />
              <ConsoleRow
                label="TRK true"
                value={motion ? formatDegrees(motion.hdgTrueDeg) : null}
              />
              <ConsoleRow
                label="Max ALT"
                value={
                  summary?.maxAltFt == null
                    ? null
                    : `${formatInt(altitudeFromFt(summary.maxAltFt, units.altitude))} ${units.altitude}`
                }
              />
            </dl>
          </ConsolePanel>

          {/* SYSTEMS / FUEL */}
          <ConsolePanel
            callsign="SYSTEMS"
            title="Fuel and engines"
            source={fuel || engines ? source : null}
            stale={stale}
            testId="console-systems"
          >
            <dl>
              <ConsoleRow
                label="Fuel"
                value={fuel ? formatWeightLb(fuel.totalLb, units.weight) : null}
                tone="green"
              />
              <ConsoleRow
                label="Fuel gal"
                value={fuel ? `${formatInt(fuel.totalGal)} gal` : null}
              />
              <ConsoleRow label="Flow" value={flow === null ? null : `${formatInt(flow)} pph`} />
              <ConsoleRow
                label="Endurance"
                value={endurance === null ? null : formatMinutes(endurance)}
                tone="green"
              />
              <ConsoleRow
                label="Engines"
                value={engines ? `${engines.running} / ${engines.total} running` : null}
                tone={engines && engines.running > 0 ? "green" : "amber"}
              />
              <ConsoleRow
                label="Fuel used"
                value={
                  summary?.fuelUsedLb == null
                    ? null
                    : formatWeightLb(summary.fuelUsedLb, units.weight)
                }
              />
            </dl>
          </ConsolePanel>

          {/* CARGO / LOAD */}
          <ConsolePanel
            callsign="CARGO"
            title={mission ? "Loaded mission" : "Next best job"}
            source={mission ? state.source : liveJobs ? state.source : null}
            action={!mission && !liveJobs && state.connection === "demo" ? <DemoTag /> : null}
            testId="console-cargo"
          >
            <dl>
              {mission ? (
                <>
                  <ConsoleRow
                    label="Mission"
                    value={`${mission.id} · ${mission.status.replace("_", " ")}`}
                    tone="cyan"
                  />
                  <ConsoleRow label="Route" value={`${mission.origin} → ${mission.destination}`} />
                  <ConsoleRow
                    label="Cargo"
                    value={`${formatInt(mission.payloadKg)} kg`}
                    tone="green"
                  />
                  <ConsoleRow
                    label="Payout est"
                    value={formatUsd(mission.expectedPayout)}
                    tone="green"
                  />
                  <ConsoleRow
                    label="Payload chk"
                    value={<PayloadCheckPill check={mission.payloadCheck} />}
                  />
                </>
              ) : next ? (
                <>
                  <ConsoleRow
                    label="Job"
                    value={
                      <span className="inline-flex items-center gap-2">
                        {next.id}
                        {liveNext ? <KindBadge kind={liveNext.kind} /> : null}
                      </span>
                    }
                    tone="cyan"
                  />
                  <ConsoleRow label="Route" value={`${next.from} → ${next.to}`} />
                  <ConsoleRow
                    label="Cargo"
                    value={`${next.cargo} · ${formatInt(next.weightKg)} kg`}
                    tone="green"
                  />
                  <ConsoleRow label="Payout" value={formatUsd(next.payout)} tone="green" />
                  <ConsoleRow label={liveNext ? "Limit" : "Due in"} value={next.deadline} />
                </>
              ) : (
                <p className="font-mono text-xs text-muted-foreground">
                  {offline?.title ?? "No jobs available"}.{" "}
                  {offline?.description ??
                    "Refresh a board on the job board to generate contracts."}
                </p>
              )}
              <ConsoleRow
                label="Gross / max"
                value={
                  weights
                    ? `${formatWeightLb(weights.totalLb, units.weight)} / ${formatWeightLb(weights.maxGrossLb, units.weight)}`
                    : null
                }
                tone={weights?.overweight ? "red" : "plain"}
              />
            </dl>
            <Link
              to="/jobs"
              className="mt-3 inline-flex items-center gap-2 font-mono text-xs uppercase tracking-[0.16em] text-phosphor-cyan hover:text-console-foreground"
            >
              Job board <ArrowRight className="size-3.5" aria-hidden="true" />
            </Link>
          </ConsolePanel>

          {/* WX */}
          <WeatherConsole origin={origin} destination={destination} metar={metar} />

          {/* FINANCE */}
          <ConsolePanel
            callsign="FINANCE"
            title="Company"
            source={liveCompany ? view.source : null}
            testId="console-finance"
          >
            {liveCompany ? (
              <dl>
                <ConsoleRow
                  label="Cash"
                  value={formatUsd(liveCompany.cash)}
                  tone="green"
                  testId="ops-cash"
                />
                <ConsoleRow
                  label="Reputation"
                  value={
                    <span data-testid="dashboard-reputation">
                      {liveCompany.reputation} / 100 · tier {liveCompany.reputationTier}
                      {liveCompany.tierName ? ` ${liveCompany.tierName}` : ""}
                    </span>
                  }
                />
                <ConsoleRow
                  label="Credit"
                  value={
                    liveCompany.creditScore === undefined ? null : String(liveCompany.creditScore)
                  }
                />
                <ConsoleRow
                  label="Net worth"
                  value={
                    liveCompany.netWorth === undefined ? null : formatUsd(liveCompany.netWorth)
                  }
                />
                <ConsoleRow
                  label="Debt"
                  value={liveCompany.debt === undefined ? null : formatUsd(liveCompany.debt)}
                  tone={liveCompany.debt ? "amber" : "plain"}
                />
              </dl>
            ) : (
              <p className="font-mono text-xs text-muted-foreground" data-testid="ops-cash-empty">
                {view.demo
                  ? "Building the demo company…"
                  : "NO DATA: start the local connector to run your company."}
              </p>
            )}
          </ConsolePanel>

          {/* FLEET */}
          <ConsolePanel
            callsign="FLEET"
            title="Hangar"
            source={view.fleet ? view.source : null}
            testId="console-fleet"
          >
            {fleetList.length === 0 ? (
              <p className="font-mono text-xs text-muted-foreground">
                {view.demo
                  ? "Building the demo fleet…"
                  : `${offline?.title ?? "No aircraft yet"}. ${offline?.description ?? "Buy or lease an aircraft on the Fleet page."}`}
              </p>
            ) : (
              <ul className="flex flex-col" data-testid="dashboard-fleet">
                {fleetList.map((a) => {
                  const gate = a.airworthiness?.status;
                  const status =
                    a.status === "maintenance" || a.status === "in_flight" || a.status === "hired"
                      ? fleetStatus[a.status]
                      : !a.airworthy
                        ? gate && gate !== "airworthy"
                          ? gateLabel[gate]
                          : "GROUNDED"
                        : fleetStatus[a.status];
                  return (
                    <li
                      key={a.id}
                      className="console-rule flex items-center justify-between gap-3 border-b py-1.5 font-mono text-xs last:border-b-0"
                    >
                      <span className="min-w-0 truncate text-console-foreground">
                        {a.registration}
                        {view.fleet?.selectedId === a.id ? (
                          <span className="ml-2 text-[0.625rem] tracking-[0.16em] text-phosphor-cyan">
                            ACTIVE
                          </span>
                        ) : null}
                        <span className="ml-2 text-muted-foreground">
                          {a.location} · {a.condition.toFixed(1)} %
                        </span>
                      </span>
                      <span
                        className={cn(
                          "flex shrink-0 items-center gap-1.5",
                          fleetTone[status] ?? "text-console-foreground",
                        )}
                      >
                        <span className="status-dot size-1.5" aria-hidden="true" />
                        {status}
                      </span>
                    </li>
                  );
                })}
              </ul>
            )}
          </ConsolePanel>

          {/* LOG */}
          <ConsolePanel
            callsign="LOG"
            title="Recent flights"
            source={recent && recent.length > 0 ? state.source : null}
            testId="console-log"
          >
            {recent && recent.length > 0 ? (
              <ul className="flex flex-col" data-testid="dashboard-recent">
                {recent.map((e) => (
                  <li
                    key={e.id}
                    className="console-rule flex items-center justify-between gap-3 border-b py-1.5 font-mono text-xs last:border-b-0"
                  >
                    <span className="min-w-0 truncate text-console-foreground">
                      {e.origin ?? "????"} → {e.destination ?? "????"}
                      <span className="ml-2 text-muted-foreground">
                        {e.startedAt ? e.startedAt.slice(0, 16).replace("T", " ") : EMPTY}
                        {e.distanceNm === null ? "" : ` · ${formatInt(e.distanceNm)} nm`}
                      </span>
                    </span>
                    <span className="shrink-0 tabular-nums">
                      <span className="text-phosphor-green">{e.landing?.grade ?? EMPTY}</span>
                      <span className="ml-2 text-muted-foreground">
                        {e.mission?.payout != null ? formatUsd(e.mission.payout) : EMPTY}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="font-mono text-xs text-muted-foreground">
                {offline?.title ??
                  (state.connection === "demo"
                    ? "No logbook in demo mode"
                    : logbook.error
                      ? "Logbook unavailable"
                      : recent === null
                        ? "Loading flights…"
                        : "No flights logged yet")}
                .{" "}
                {offline?.description ??
                  (state.connection === "demo"
                    ? "Run the local connector: tracked flights land here with grade, distance and payout."
                    : (logbook.error ??
                      "Flights are recorded automatically from block-out to arrival."))}
              </p>
            )}
          </ConsolePanel>
        </div>
      </div>
    </div>
  );
}
