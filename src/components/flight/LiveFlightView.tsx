import {
  Activity,
  ClipboardList,
  Gauge,
  Package,
  Plane,
  PlaneLanding,
  Route as RouteIcon,
} from "lucide-react";

import { MetricTile } from "@/components/dashboard/MetricTile";
import { Panel } from "@/components/dashboard/Panel";
import { SourceTag, StaleTag } from "@/components/status/SourceTag";
import { RouteWeatherPanel } from "@/components/weather/RouteWeather";
import {
  arrivalEtaMs,
  displayAglFt,
  enduranceStatus,
  enginesRunning,
  flightSummary,
  latestTouchdown,
  routeView,
  simRateBadge,
  totalFuelFlowPph,
  weightsView,
  isStale,
  FUEL_RESERVE_MIN,
} from "@/lib/flight/flight-view";
import {
  EMPTY,
  formatDegrees,
  formatFpm,
  formatInt,
  formatLat,
  formatLon,
  formatMinutes,
} from "@/lib/format";
import {
  currentPhase,
  fuelEnduranceMin,
  isSimOfflineSession,
  type ClientSimState,
} from "@/lib/sim-state";
import { useTelemetryHistory } from "@/lib/sim-state/history";
import { useNow } from "@/lib/sim-state/hooks";
import { useCommand, useSimConnection } from "@/lib/transport/useSimConnection";
import { useAirportLookup } from "@/lib/economy/board";
import { altitudeFromFt, useUnits, weightFromLb } from "@/lib/settings/units";
import { cn } from "@/lib/utils";
import type { PlanBasis } from "@cargo-ops/protocol";

import { Annunciator, SubReadout, type AnnunciatorProps } from "./Annunciator";
import { DestinationPicker, PlanBasisTag } from "./DestinationPicker";
import { FlightProgressBar } from "./FlightProgressBar";
import { FlightSummary } from "./FlightSummary";
import { LandingCard } from "./LandingCard";
import { PayloadBar } from "./PayloadBar";
import { PhaseTimeline } from "./PhaseTimeline";
import { PHASE_LABELS } from "./phases";
import { TelemetryStrip } from "./TelemetryStrip";

const VS_TREND_FPM = 100;

function num(n: number | null | undefined): string {
  return n === null || n === undefined ? EMPTY : formatInt(n);
}

function annunciators(state: ClientSimState, stale: boolean): AnnunciatorProps[] {
  const { motion, controls, sim } = state.sim;
  const engines = enginesRunning(state.sim.engines);
  const rate = simRateBadge(sim?.simRate);
  const source = state.source;
  return [
    motion
      ? motion.onGround
        ? { label: "On ground", state: "on", tone: "success" }
        : { label: "Airborne", state: "on", tone: "accent" }
      : { label: "Ground", state: "unknown" },
    engines
      ? {
          label: "Engines",
          state: engines.running > 0 ? "on" : "off",
          tone: "success",
          value: `${engines.running}/${engines.total}`,
        }
      : { label: "Engines", state: "unknown" },
    controls
      ? {
          label: "Brake",
          state: controls.parkingBrake ? "on" : "off",
          tone: "warning",
          value: controls.parkingBrake ? "SET" : "OFF",
        }
      : { label: "Brake", state: "unknown" },
    sim
      ? {
          label: "Pause",
          state: sim.paused ? "on" : "off",
          tone: "warning",
          value: sim.paused ? "PAUSED" : "OFF",
          pulse: sim.paused,
        }
      : { label: "Pause", state: "unknown" },
    sim
      ? rate
        ? {
            label: "Sim rate",
            state: "on",
            tone: rate.level === "warning" ? "warning" : "accent",
            value: rate.label,
          }
        : { label: "Sim rate", state: "off", value: "×1" }
      : { label: "Sim rate", state: "unknown" },
    // Live, but the simulator is gone: whatever still arrives is not telemetry.
    isSimOfflineSession(state)
      ? { label: "Data", state: "off", value: "SIM OFF" }
      : stale
        ? { label: "Data", state: "on", tone: "destructive", value: "STALE" }
        : source
          ? {
              label: "Data",
              state: "on",
              tone: source === "sim" ? "success" : source === "demo" ? "warning" : "accent",
              value: source === "sim" ? "SIM" : source === "demo" ? "DEMO" : "REPLAY",
              pulse: true,
            }
          : { label: "Data", state: "unknown" },
  ];
}

/** Connector sessions (live or replay) can set a destination; the demo cannot. */
function connectorSession(state: ClientSimState): boolean {
  return state.connection === "live" || state.connection === "replay";
}

/** Airports load lazily (≈1.1 MB), only when the picker can be used. */
function ConnectorDestinationPicker(props: {
  basis: PlanBasis | null;
  destination: string | null;
  missionDestination: string | null;
  enabled: boolean;
  disabledNote: string | undefined;
}) {
  const lookup = useAirportLookup();
  const command = useCommand();
  return <DestinationPicker {...props} lookup={lookup} command={command} />;
}

function RouteDestination({
  state,
  basis,
  destination,
}: {
  state: ClientSimState;
  basis: PlanBasis | null;
  destination: string | null;
}) {
  const command = useCommand();
  const mission = state.sim.mission;
  const missionDestination =
    mission && (mission.status === "loaded" || mission.status === "in_progress")
      ? mission.destination
      : null;
  if (!connectorSession(state)) {
    return (
      <DestinationPicker
        lookup={null}
        basis={basis}
        destination={destination}
        missionDestination={missionDestination}
        enabled={false}
        disabledNote={
          state.connection === "demo"
            ? "Demo flight: picking a destination needs the local connector."
            : "Not connected to the connector."
        }
        command={command}
      />
    );
  }
  const offline = isSimOfflineSession(state);
  return (
    <ConnectorDestinationPicker
      basis={basis}
      destination={destination}
      missionDestination={missionDestination}
      enabled={!offline}
      disabledNote={offline ? "The simulator is not connected." : undefined}
    />
  );
}

/** The Live Flight display, bound to the sim connection. Works the same for demo and live. */
export function LiveFlightView() {
  const { state } = useSimConnection();
  const now = useNow(1000);
  const { sim } = state;
  const source = state.source;
  const stale = isStale(state, now);

  const position = sim.position ?? null;
  const motion = sim.motion ?? null;
  const fuel = sim.fuel ?? null;
  const agl = displayAglFt(position);
  const airborne = motion ? !motion.onGround : false;
  const route = routeView(state);
  const endurance = fuelEnduranceMin(fuel);
  const reserve = enduranceStatus(endurance, route.eteMin);
  const flow = totalFuelFlowPph(fuel);
  const weights = weightsView(sim.weights);
  const phase = currentPhase(state);
  const touchdown = latestTouchdown(state.events);
  const summary = flightSummary(sim.flight);
  const history = useTelemetryHistory(state);
  const vs = motion?.vsFpm ?? null;
  const vsTrend =
    vs === null ? undefined : vs > VS_TREND_FPM ? "up" : vs < -VS_TREND_FPM ? "down" : "flat";
  const common = { source, stale } as const;
  const [units] = useUnits();
  const alt = (ft: number | null | undefined) =>
    ft === null || ft === undefined ? null : altitudeFromFt(ft, units.altitude);

  return (
    <div className="grid-ops" data-testid="live-flight">
      {/* Aircraft identity and annunciator panel */}
      <section
        className="panel-instrument col-span-12 flex flex-col gap-5 overflow-hidden p-5 md:p-6"
        aria-label="Aircraft and status"
      >
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 items-center gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-2xl border border-primary/30 bg-primary/10 text-accent shadow-glow">
              <Plane className="size-6 -rotate-45" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="label-eyebrow">Aircraft</p>
              <p
                className={cn(
                  "mt-1 truncate font-display text-xl font-semibold tracking-tight md:text-2xl",
                  sim.aircraft ? "text-foreground" : "text-muted-foreground",
                )}
                data-testid="aircraft-title"
              >
                {sim.aircraft?.title ?? "No aircraft loaded"}
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2 font-mono text-xs">
                <span
                  className="rounded-md border border-border bg-secondary/60 px-2 py-0.5 font-semibold tracking-[0.14em] text-foreground"
                  data-testid="atc-id"
                >
                  {sim.aircraft?.atcId ?? EMPTY}
                </span>
                <span className="text-muted-foreground">
                  Phase{" "}
                  <span className="font-semibold text-accent" data-testid="phase-label">
                    {phase ? PHASE_LABELS[phase] : EMPTY}
                  </span>
                </span>
                <span className="text-muted-foreground">· Mission none active</span>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            {stale ? <StaleTag /> : null}
            <SourceTag source={source} />
          </div>
        </div>
        <div
          className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6"
          aria-label="Status lights"
        >
          {annunciators(state, stale).map((a) => (
            <Annunciator key={a.label} {...a} />
          ))}
        </div>
      </section>

      {/* Hero readouts */}
      <MetricTile
        {...common}
        className="col-span-12 md:col-span-6 xl:col-span-4"
        label="Altitude"
        value={alt(position?.altFt)}
        unit={units.altitude}
        size="xl"
        digits={6}
        hint={agl === null ? "Indicated · AGL shown below 2,500 ft" : undefined}
      >
        {agl !== null ? (
          <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
            <SubReadout label="AGL" value={num(alt(agl))} unit={units.altitude} />
            <SubReadout label="Indicated" value={num(alt(position?.altFt))} unit={units.altitude} />
          </div>
        ) : null}
      </MetricTile>

      <MetricTile
        {...common}
        className="col-span-12 md:col-span-6 xl:col-span-4"
        label="Airspeed"
        value={motion?.iasKt ?? null}
        unit="kt IAS"
        size="xl"
        digits={3}
      >
        <div className="grid grid-cols-2 gap-3 border-t border-border pt-3">
          <SubReadout
            label="True airspeed"
            value={airborne ? num(motion?.tasKt) : EMPTY}
            unit="kt"
          />
          <SubReadout
            label="G load"
            value={motion && Number.isFinite(motion.gForce) ? motion.gForce.toFixed(2) : EMPTY}
            unit="G"
          />
        </div>
      </MetricTile>

      <MetricTile
        {...common}
        className="col-span-12 xl:col-span-4"
        label="Fuel on board"
        value={fuel ? weightFromLb(fuel.totalLb, units.weight) : null}
        unit={units.weight}
        size="xl"
        digits={5}
        tone={reserve === "low" ? "warning" : "default"}
      >
        <div className="grid grid-cols-3 gap-3 border-t border-border pt-3">
          <SubReadout label="Quantity" value={num(fuel?.totalGal)} unit="gal" />
          <SubReadout label="Flow" value={num(flow)} unit="pph" />
          <SubReadout
            label="Endurance"
            value={formatMinutes(endurance)}
            tone={reserve === "low" ? "warning" : "default"}
          />
        </div>
        {reserve === "low" ? (
          <p
            className="flex items-center gap-2 rounded-md bg-warning/10 px-3 py-2 text-xs font-medium text-warning"
            role="alert"
          >
            <span className="status-dot size-1.5" data-live="true" aria-hidden="true" />
            Endurance below ETE + {FUEL_RESERVE_MIN} min reserve
          </p>
        ) : null}
      </MetricTile>

      {/* Route progress */}
      <Panel
        className="col-span-12"
        eyebrow="Route"
        title={
          route.origin && route.destination
            ? `${route.origin} → ${route.destination}`
            : route.destination
              ? `To ${route.destination}`
              : "No flight plan"
        }
        icon={RouteIcon}
        action={
          <div className="flex items-center gap-1.5">
            <PlanBasisTag basis={route.basis} />
            <SourceTag source={sim.plan ? source : null} />
          </div>
        }
      >
        <div className="flex flex-col gap-6">
          <div className="@container grid grid-cols-2 gap-4 sm:grid-cols-3">
            <div className="col-span-2 min-w-0 sm:col-span-1">
              <p className="label-eyebrow">Remaining</p>
              <p className="mt-2 flex items-baseline gap-2">
                <span
                  className="metric-lg metric-live metric-glow"
                  data-empty={route.distanceRemainingNm === null ? "" : undefined}
                  data-testid="distance-remaining"
                >
                  {num(route.distanceRemainingNm)}
                </span>
                {route.distanceRemainingNm !== null ? (
                  <span className="font-mono text-base font-medium uppercase tracking-wider text-muted-foreground">
                    nm
                  </span>
                ) : null}
              </p>
            </div>
            <SubReadout className="self-end" label="Flown" value={num(route.flownNm)} unit="nm" />
            <SubReadout
              className="self-end text-right"
              label="Complete"
              value={route.progress === null ? EMPTY : `${Math.round(route.progress * 100)}%`}
            />
          </div>
          <FlightProgressBar
            origin={route.origin}
            destination={route.destination}
            progress={route.progress}
            ete={route.eteMin === null ? null : formatMinutes(route.eteMin)}
          />
          <RouteDestination state={state} basis={route.basis} destination={route.destination} />
        </div>
      </Panel>

      {/* Origin / destination weather */}
      <RouteWeatherPanel
        className="col-span-12"
        eyebrow="Weather en route"
        origin={route.origin ?? sim.mission?.origin}
        destination={route.destination ?? sim.mission?.destination}
        destinationEtaMs={arrivalEtaMs(now, route.eteMin)}
      />

      {/* Secondary instruments */}
      <MetricTile
        {...common}
        className="col-span-6 lg:col-span-3"
        label="Ground speed"
        value={motion?.gsKt ?? null}
        unit="kt"
        digits={3}
      />
      <MetricTile
        {...common}
        className="col-span-6 lg:col-span-3"
        label="Heading"
        value={motion?.hdgMagDeg ?? null}
        format={(n) => formatDegrees(n).replace("°", "")}
        unit="° mag"
        digits={3}
      />
      <MetricTile
        {...common}
        className="col-span-12 sm:col-span-6 lg:col-span-3"
        label="Vertical speed"
        value={vs}
        format={(n) => formatFpm(n).replace(" fpm", "")}
        unit="fpm"
        digits={6}
        {...(vsTrend ? { trend: vsTrend } : {})}
      />
      <MetricTile
        {...common}
        className="col-span-12 sm:col-span-6 lg:col-span-3"
        label="Position"
        value={null}
        text={position ? formatLat(position.lat) : null}
        size="md"
      >
        <p
          className="metric-md -mt-2 pb-[0.06em]"
          data-empty={position ? undefined : ""}
          data-testid="position-lon"
        >
          {position ? formatLon(position.lon) : EMPTY}
        </p>
      </MetricTile>

      {/* Telemetry history and tracked-flight summary */}
      <Panel
        className="col-span-12 lg:col-span-7"
        eyebrow="Last 10 minutes"
        title="Telemetry"
        icon={Activity}
        action={<SourceTag source={history.length >= 2 ? source : null} />}
      >
        <TelemetryStrip points={history} />
      </Panel>
      <Panel
        className="col-span-12 lg:col-span-5"
        eyebrow="Tracked flight"
        title="Flight summary"
        icon={ClipboardList}
        action={<SourceTag source={summary ? source : null} />}
      >
        <FlightSummary summary={summary} />
      </Panel>

      {/* Phase */}
      <Panel
        className="col-span-12"
        eyebrow="Flight phase"
        title={phase ? PHASE_LABELS[phase] : "No phase data"}
        icon={Gauge}
        action={<SourceTag source={phase ? source : null} />}
      >
        <PhaseTimeline current={phase} />
      </Panel>

      {/* Weights and landing */}
      <Panel
        className="col-span-12 lg:col-span-7"
        eyebrow="Weight & balance"
        title="Payload"
        icon={Package}
        action={<SourceTag source={weights ? source : null} />}
      >
        <PayloadBar
          weights={weights}
          stations={sim.payload?.stations ?? null}
          unit={units.weight}
        />
      </Panel>
      <Panel
        className="col-span-12 lg:col-span-5"
        eyebrow="After touchdown"
        title="Landing"
        icon={PlaneLanding}
      >
        <LandingCard touchdown={touchdown} />
      </Panel>
    </div>
  );
}
