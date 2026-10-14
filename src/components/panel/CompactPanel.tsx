import type { FleetState, Mission, Source } from "@cargo-ops/protocol";
import { KIND_LABELS } from "@cargo-ops/economy";
import type { ReactNode } from "react";

import { PayloadCheckPill } from "@/components/cargo/PayloadCheck";
import { PlanBasisTag } from "@/components/flight/DestinationPicker";
import { SimStatusChip } from "@/components/status/SimStatusChip";
import { chipStatusFor } from "@/components/status/sim-status";
import { SourceTag, StaleTag } from "@/components/status/SourceTag";
import { FlightCategoryChip } from "@/components/weather/FlightCategoryChip";
import { missionDeadline } from "@/lib/economy/format";
import {
  enduranceStatus,
  isSessionUp,
  isStale,
  routeView,
  FUEL_RESERVE_MIN,
} from "@/lib/flight/flight-view";
import { EMPTY, formatInt, formatMinutes } from "@/lib/format";
import { boardSummary, goNoGoLamps, type Lamp } from "@/lib/ops/mission-control";
import { formatWeightLb, type UnitPreferences } from "@/lib/settings/units";
import { fuelEnduranceMin, statusLabel, type ClientSimState } from "@/lib/sim-state";
import type { MetarState } from "@/lib/weather/use-metar";

import { panelSourceNote } from "./panel-note";
import { cn } from "@/lib/utils";

// The in-sim toolbar panel (/panel, about 400 x 600 inside the simulator's toolbar window).
// Read-only: no buttons, no links to other pages (only /panel may be framed, see
// src/lib/framing.ts). Same rules as every other page: values only from the connector,
// DEMO / REPLAY tags on everything that is not the live simulator, LIVE only after a real
// welcome with the simulator connected (chipStatusFor / statusLabel).

export interface CompactPanelProps {
  state: ClientSimState;
  /** Client clock, ms; null before mount. */
  now: number | null;
  units: UnitPreferences;
  fleet: FleetState | null;
  fleetSource: Source | null;
  metar: MetarState;
  /** This page runs on an unpaired LAN device (never the case inside the simulator). */
  pairingRequired?: boolean;
}

const MISSION_STATUS: Record<Mission["status"], string> = {
  loaded: "Loaded, awaiting departure",
  in_progress: "In flight",
  delivered: "Delivered",
  failed: "Failed",
  aborted: "Aborted",
};

function Section({
  title,
  source,
  stale = false,
  testId,
  children,
}: {
  title: string;
  source: Source | null;
  stale?: boolean;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      className="console-panel"
      aria-label={title}
      data-testid={testId}
      data-stale={stale ? "" : undefined}
    >
      <header className="console-strip">
        <h2 className="truncate">{title}</h2>
        <span className="flex shrink-0 items-center gap-1.5">
          {stale ? <StaleTag /> : null}
          <SourceTag source={source} />
        </span>
      </header>
      <div className="flex flex-col gap-1.5 p-2.5">{children}</div>
    </section>
  );
}

function Row({
  label,
  value,
  tone = "plain",
  testId,
}: {
  label: string;
  value: ReactNode;
  tone?: "plain" | "green" | "amber" | "red" | "cyan";
  testId?: string;
}) {
  const empty = value === null || value === undefined || value === "";
  return (
    <div className="flex items-baseline justify-between gap-3" data-testid={testId}>
      <dt className="shrink-0 font-mono text-xs uppercase tracking-[0.12em] text-muted-foreground">
        {label}
      </dt>
      <dd
        className={cn(
          "min-w-0 truncate text-right font-mono text-base font-semibold tabular-nums",
          empty && "text-muted-foreground",
          !empty && tone === "plain" && "text-console-foreground",
          !empty && tone === "green" && "text-phosphor-green",
          !empty && tone === "amber" && "text-phosphor-amber",
          !empty && tone === "red" && "text-phosphor-red",
          !empty && tone === "cyan" && "text-phosphor-cyan",
        )}
        data-empty={empty ? "" : undefined}
      >
        {empty ? EMPTY : value}
      </dd>
    </div>
  );
}

function Note({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <p className="text-sm text-muted-foreground" data-testid={testId}>
      {children}
    </p>
  );
}

function MissionSection({ mission, source }: { mission: Mission | null; source: Source | null }) {
  if (!mission) {
    return (
      <Section title="Mission" source={null} testId="panel-mission">
        <Note testId="panel-no-mission">
          No active mission. Load one on the Jobs page in Cargo Ops.
        </Note>
      </Section>
    );
  }
  const deadline = missionDeadline(mission);
  const kinds = [...new Set(mission.jobs.map((j) => KIND_LABELS[j.kind]))].join(", ");
  return (
    <Section title="Mission" source={source} testId="panel-mission">
      <p
        className="font-mono text-2xl font-bold tracking-wide text-console-foreground"
        data-testid="panel-mission-route"
      >
        {mission.origin} → {mission.destination}
      </p>
      <p className="text-sm text-muted-foreground" data-testid="panel-mission-status">
        {mission.id} · {MISSION_STATUS[mission.status]}
      </p>
      <dl className="flex flex-col gap-1.5">
        <Row
          label="Cargo"
          value={`${formatInt(mission.payloadKg)} kg${kinds ? ` · ${kinds}` : ""}`}
          testId="panel-cargo"
        />
        <Row
          label="Deadline"
          value={deadline.text}
          tone={deadline.late ? "red" : "plain"}
          testId="panel-deadline"
        />
        <Row
          label="Payload"
          value={<PayloadCheckPill check={mission.payloadCheck} />}
          testId="panel-payload"
        />
      </dl>
      {mission.payloadCheck?.message ? (
        <p className="text-xs text-muted-foreground">{mission.payloadCheck.message}</p>
      ) : null}
    </Section>
  );
}

function LampList({ lamps }: { lamps: readonly Lamp[] }) {
  const s = boardSummary(lamps);
  return (
    <>
      <p className="font-mono text-sm font-semibold tabular-nums" data-testid="panel-board-summary">
        <span className="text-phosphor-green">{s.go} GO</span>
        {" · "}
        <span className="text-phosphor-amber">{s.hold} HOLD</span>
        {" · "}
        <span className="text-phosphor-red">{s.nogo} NO-GO</span>
        {" · "}
        <span className="text-muted-foreground">{s.nodata} NO DATA</span>
      </p>
      <ul className="grid grid-cols-2 gap-1.5">
        {lamps.map((lamp) => (
          <li
            key={lamp.id}
            className="lamp flex min-w-0 items-center justify-between gap-1.5 px-2 py-1.5"
            data-testid="panel-lamp"
            data-lamp={lamp.id}
            data-state={lamp.state}
            title={lamp.detail}
          >
            <span className="truncate font-mono text-xs font-semibold tracking-[0.1em] text-console-foreground">
              {lamp.label}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              {lamp.sample ? (
                <span
                  className="rounded-sm bg-warning/15 px-1 font-mono text-[0.625rem] font-semibold text-warning"
                  data-metar-origin="sample"
                >
                  SAMPLE
                </span>
              ) : null}
              <span className="font-mono text-sm font-bold">{lamp.value}</span>
            </span>
          </li>
        ))}
      </ul>
    </>
  );
}

function WeatherRows({
  origin,
  destination,
  metar,
}: {
  origin: string | null;
  destination: string | null;
  metar: MetarState;
}) {
  const rows: Array<{ role: string; station: string }> = [];
  if (origin) rows.push({ role: "ORIG", station: origin.toUpperCase() });
  if (destination && destination.toUpperCase() !== origin?.toUpperCase()) {
    rows.push({ role: "DEST", station: destination.toUpperCase() });
  }
  if (rows.length === 0) return <Note>No origin or destination yet.</Note>;
  const data = metar.status === "ready" ? metar.data : null;
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => {
        const report = data?.stations.find((s) => s.station === r.station)?.report ?? null;
        return (
          <li
            key={r.role}
            className="flex items-center justify-between gap-2"
            data-testid="panel-wx-station"
            data-station={r.station}
          >
            <span className="font-mono text-base text-console-foreground">
              <span className="mr-2 text-xs text-muted-foreground">{r.role}</span>
              {r.station}
            </span>
            <span className="flex items-center gap-1.5">
              {report?.origin === "sample" ? (
                <span
                  className="rounded-sm bg-warning/15 px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold text-warning"
                  title="Built-in sample report, not real weather"
                  data-metar-origin="sample"
                >
                  SAMPLE
                </span>
              ) : null}
              <FlightCategoryChip category={report?.category ?? null} className="text-xs" />
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function CompactPanel({
  state,
  now,
  units,
  fleet,
  fleetSource,
  metar,
  pairingRequired = false,
}: CompactPanelProps) {
  const up = isSessionUp(state) && !pairingRequired;
  const stale = isStale(state, now);
  const source = up ? state.source : null;
  const note = panelSourceNote(state, pairingRequired);

  const route = routeView(state);
  const mission = up ? (state.sim.mission ?? null) : null;
  const fuel = up ? (state.sim.fuel ?? null) : null;
  const endurance = fuelEnduranceMin(fuel);
  const enduranceCheck = enduranceStatus(endurance, route.eteMin);
  const origin = route.origin ?? mission?.origin ?? null;
  const destination = route.destination ?? mission?.destination ?? null;
  const destReport =
    metar.status === "ready" && destination
      ? (metar.data.stations.find((s) => s.station === destination.toUpperCase())?.report ?? null)
      : null;
  const lamps = goNoGoLamps({
    state,
    now,
    fleet,
    fleetSource: fleet ? fleetSource : null,
    weather: {
      station: destination,
      category: destReport?.category ?? null,
      sample: destReport?.origin === "sample",
      source: destReport ? (state.connection === "demo" ? "demo" : state.source) : null,
    },
  });

  return (
    <div className="flex flex-col gap-2.5" data-testid="compact-panel">
      <header className="flex items-center justify-between gap-2">
        <p className="font-mono text-sm font-bold uppercase tracking-[0.18em] text-phosphor-amber">
          Cargo Ops
        </p>
        <SimStatusChip
          status={chipStatusFor(state)}
          {...(state.connection === "idle" ? {} : { label: statusLabel(state) })}
          {...(state.error ? { detail: state.error } : {})}
          still
        />
      </header>
      {note ? (
        <p
          className="rounded-sm border border-border bg-secondary/60 px-2.5 py-2 text-sm text-foreground"
          data-testid="panel-source-note"
          data-connection={state.connection}
        >
          {note}
        </p>
      ) : null}

      {up ? (
        <>
          <MissionSection mission={mission} source={source} />

          <Section
            title="Route"
            source={state.sim.plan ? source : null}
            stale={stale}
            testId="panel-route"
          >
            {state.sim.plan ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span
                    className="font-mono text-lg font-bold text-phosphor-cyan"
                    data-testid="panel-route-pair"
                  >
                    {route.origin ?? "????"} → {route.destination ?? "????"}
                  </span>
                  <PlanBasisTag basis={route.basis} />
                </div>
                <dl className="flex flex-col gap-1.5">
                  <Row
                    label="Dist to go"
                    value={
                      route.distanceRemainingNm === null
                        ? null
                        : `${formatInt(route.distanceRemainingNm)} nm`
                    }
                    tone="green"
                    testId="panel-distance"
                  />
                  <Row
                    label="ETE"
                    value={route.eteMin === null ? null : formatMinutes(route.eteMin)}
                    tone="green"
                    testId="panel-ete"
                  />
                </dl>
              </>
            ) : (
              <Note>No route yet: no GPS flight plan, manual destination or mission.</Note>
            )}
          </Section>

          <Section title="Fuel" source={fuel ? source : null} stale={stale} testId="panel-fuel">
            <dl className="flex flex-col gap-1.5">
              <Row
                label="On board"
                value={fuel ? formatWeightLb(fuel.totalLb, units.weight) : null}
                tone="green"
                testId="panel-fuel-total"
              />
              <Row
                label="Endurance"
                value={endurance === null ? null : formatMinutes(endurance)}
                tone={enduranceCheck === "low" ? "red" : "green"}
                testId="panel-endurance"
              />
              <Row
                label={`ETE + ${FUEL_RESERVE_MIN} min`}
                value={enduranceCheck === null ? null : enduranceCheck === "low" ? "LOW" : "OK"}
                tone={enduranceCheck === "low" ? "red" : "green"}
                testId="panel-fuel-check"
              />
            </dl>
          </Section>

          <Section title="Go / No-go" source={source} testId="panel-lamps">
            <LampList lamps={lamps} />
          </Section>

          <Section title="Weather" source={null} testId="panel-wx">
            <WeatherRows origin={origin} destination={destination} metar={metar} />
          </Section>
        </>
      ) : null}
    </div>
  );
}
