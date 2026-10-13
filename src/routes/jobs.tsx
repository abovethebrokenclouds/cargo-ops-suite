import { createFileRoute } from "@tanstack/react-router";
import { Filter, Package, PackageCheck, RefreshCw, Truck } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { CARGO_KINDS, type CargoKind, type Job } from "@cargo-ops/protocol";
import { KIND_LABELS } from "@cargo-ops/economy";
import { PageHero } from "@/components/AppNav";
import { EmptyState } from "@/components/EmptyState";
import { DemandEvents } from "@/components/cargo/DemandEvents";
import { KindBadge, MissionCard } from "@/components/cargo/MissionCard";
import { MissionStrip } from "@/components/cargo/MissionStrip";
import { PayoutBreakdown } from "@/components/cargo/PayoutBreakdown";
import { RouteFinder } from "@/components/cargo/RouteFinder";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { DemoTag, Panel } from "@/components/dashboard/Panel";
import { SourceTag } from "@/components/status/SourceTag";
import {
  AIRCRAFT_TYPES,
  activeType,
  jobSuitability,
  useAirportLookup,
  useJobBoard,
} from "@/lib/economy/board";
import { useCompanyView } from "@/lib/economy/company";
import { formatInt, formatUsd } from "@/lib/format";
import { useCommand, useSimConnection } from "@/lib/transport/useSimConnection";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/jobs")({
  head: () => ({
    meta: [
      { title: "Job Board — Cargo Ops" },
      {
        name: "description",
        content:
          "Generated cargo contracts for your aircraft, a route finder and mission dispatch.",
      },
      { property: "og:title", content: "Job Board — Cargo Ops" },
      {
        property: "og:description",
        content:
          "Generated cargo contracts for your aircraft, a route finder and mission dispatch.",
      },
    ],
  }),
  component: Jobs,
});

const inputClass =
  "w-full rounded-lg border border-input bg-secondary px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";
const buttonClass =
  "inline-flex items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50";
const primaryButton = `${buttonClass} bg-gradient-brand text-primary-foreground shadow-glow`;
const secondaryButton = `${buttonClass} border border-border bg-secondary text-foreground hover:bg-secondary/70`;

const PAGE = 8;

interface Filters {
  origin: string;
  kind: CargoKind | "all";
  maxNm: string;
  minKg: string;
  maxKg: string;
  suitableOnly: boolean;
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="label-eyebrow">
        {label}
      </label>
      {children}
    </div>
  );
}

function Jobs() {
  const { state } = useSimConnection();
  const command = useCommand();
  const lookup = useAirportLookup();
  const [demoType, setDemoType] = useState<string | null>(null);
  const board = useJobBoard(state, { demoTypeKey: demoType, lookup });
  const { jobs, company, mission, source, connector } = board;
  // P5 part 2: active local demand events (the demo company's in demo mode).
  const { demand, source: demandSource } = useCompanyView(state, lookup);
  const type = activeType(jobs);
  const [filters, setFilters] = useState<Filters>({
    origin: "current",
    kind: "all",
    maxNm: "",
    minKg: "",
    maxKg: "",
    suitableOnly: false,
  });
  const [refreshAirport, setRefreshAirport] = useState("");
  const [focus, setFocus] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const demo = state.connection === "demo";

  const run = async (name: string, args: unknown, success: string) => {
    setBusy(true);
    const r = await command(name, args);
    setBusy(false);
    if (r.ok) setMessage({ ok: true, text: success });
    else setMessage({ ok: false, text: `${r.error.message} (${r.error.code})` });
    return r.ok;
  };

  const available = useMemo(() => jobs?.available ?? [], [jobs]);
  const currentBoard = jobs?.boards[0]?.origin ?? null;
  const accepted = useMemo(() => jobs?.accepted ?? [], [jobs]);
  const visible = useMemo(() => {
    const maxNm = Number(filters.maxNm) || Infinity;
    const minKg = Number(filters.minKg) || 0;
    const maxKg = Number(filters.maxKg) || Infinity;
    return available.filter(
      (j) =>
        (filters.origin === "all" ||
          j.origin === (filters.origin === "current" ? currentBoard : filters.origin)) &&
        (filters.kind === "all" || j.kind === filters.kind) &&
        j.distanceNm <= maxNm &&
        j.weightKg >= minKg &&
        j.weightKg <= maxKg &&
        (!filters.suitableOnly || jobSuitability(j, type, lookup).every((b) => b.ok !== false)),
    );
  }, [available, filters, type, lookup, currentBoard]);
  const openPayout = visible.reduce((s, j) => s + j.payoutEstimate, 0);
  const boards = jobs?.boards ?? [];
  const startAirport =
    mission && mission.status !== "delivered" ? null : (boards[0]?.origin ?? null);
  const lastPayout = mission?.status === "delivered" ? mission.payout : null;
  const missionOpen = mission?.status === "loaded" || mission?.status === "in_progress";
  const selectedJobs = accepted.filter((j) => selected.includes(j.id) && j.status === "accepted");

  const disabledNote = demo
    ? "Demo board: accepting and loading need the local connector"
    : !connector
      ? "Not connected to the connector"
      : undefined;

  const acceptButton = (job: Job) => (
    <button
      type="button"
      className={primaryButton}
      disabled={!connector || busy}
      title={disabledNote}
      data-testid="accept-job"
      onClick={() => void run("job.accept", { jobId: job.id }, `Accepted ${job.id}`)}
    >
      Accept
    </button>
  );

  return (
    <>
      <PageHero
        eyebrow="Job board"
        title="Cargo Jobs"
        sub={
          demo
            ? "A demo board generated in your browser with the same seeded generator the connector uses. Run the connector to accept, load and fly real missions."
            : "Contracts generated for your aircraft from the board airport: runway, range and payload checked, payout fully itemised."
        }
      />

      <div className="grid-ops">
        {demo ? (
          <div
            className="panel-inset col-span-12 flex flex-wrap items-center gap-3 px-5 py-4 text-sm text-muted-foreground"
            data-testid="demo-board-note"
          >
            <DemoTag />
            Generated locally from seed data for the demo aircraft. Accept and load are disabled:
            they need the local connector (see Settings).
          </div>
        ) : null}

        <MetricTile
          className="col-span-12 md:col-span-6 xl:col-span-4"
          label="Open payout"
          value={jobs ? openPayout : null}
          format={formatUsd}
          size="xl"
          source={jobs ? source : null}
          hint="Estimates: landing 1.00, on time, current reputation."
        />
        <MetricTile
          className="col-span-6 xl:col-span-2"
          label="Contracts"
          value={jobs ? visible.length : null}
          source={jobs ? source : null}
        />
        <MetricTile
          className="col-span-6 xl:col-span-3"
          label="Company cash"
          value={company?.cash ?? null}
          format={formatUsd}
          source={company ? source : null}
        />
        <MetricTile
          className="col-span-12 xl:col-span-3"
          label="Reputation"
          value={company?.reputation ?? null}
          {...(company ? { unit: `/ 100 · tier ${company.reputationTier}` } : {})}
          source={company ? source : null}
        />

        {mission && !demo ? (
          <MissionStrip mission={mission} source={source} className="col-span-12" />
        ) : null}

        <DemandEvents
          className="col-span-12"
          demand={demand}
          source={demandSource}
          lookup={lookup}
        />

        <Panel
          className="col-span-12"
          eyebrow="Filters"
          title="Board"
          icon={Filter}
          action={<SourceTag source={source} />}
        >
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
            <Field label="Base" htmlFor="f-origin">
              <select
                id="f-origin"
                className={inputClass}
                value={filters.origin}
                onChange={(e) => setFilters({ ...filters, origin: e.target.value })}
              >
                <option value="current">Current ({currentBoard ?? "—"})</option>
                <option value="all">All boards</option>
                {boards.map((b) => (
                  <option key={b.origin} value={b.origin}>
                    {b.origin}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Aircraft" htmlFor="f-aircraft">
              <select
                id="f-aircraft"
                className={inputClass}
                value={jobs?.aircraft.source === "override" ? type.key : ""}
                disabled={busy || (!connector && !demo)}
                onChange={(e) => {
                  const key = e.target.value || null;
                  if (demo) setDemoType(key);
                  else void run("settings.update", { aircraftType: key }, "Aircraft type updated");
                }}
              >
                <option value="">
                  Auto ({jobs?.aircraft.source === "override" ? "off" : type.name})
                </option>
                {AIRCRAFT_TYPES.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Kind" htmlFor="f-kind">
              <select
                id="f-kind"
                className={inputClass}
                value={filters.kind}
                onChange={(e) =>
                  setFilters({ ...filters, kind: e.target.value as Filters["kind"] })
                }
              >
                <option value="all">All kinds</option>
                {CARGO_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABELS[k]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Max distance (nm)" htmlFor="f-nm">
              <input
                id="f-nm"
                inputMode="numeric"
                className={inputClass}
                placeholder="any"
                value={filters.maxNm}
                onChange={(e) => setFilters({ ...filters, maxNm: e.target.value })}
              />
            </Field>
            <Field label="Min payload (kg)" htmlFor="f-minkg">
              <input
                id="f-minkg"
                inputMode="numeric"
                className={inputClass}
                placeholder="0"
                value={filters.minKg}
                onChange={(e) => setFilters({ ...filters, minKg: e.target.value })}
              />
            </Field>
            <Field label="Max payload (kg)" htmlFor="f-maxkg">
              <input
                id="f-maxkg"
                inputMode="numeric"
                className={inputClass}
                placeholder="any"
                value={filters.maxKg}
                onChange={(e) => setFilters({ ...filters, maxKg: e.target.value })}
              />
            </Field>
            <label className="col-span-2 flex items-center gap-2 self-end pb-2 text-sm text-muted-foreground md:col-span-1">
              <input
                type="checkbox"
                checked={filters.suitableOnly}
                onChange={(e) => setFilters({ ...filters, suitableOnly: e.target.checked })}
                className="size-4 accent-primary"
              />
              Suitable only
            </label>
          </div>
          <form
            className="mt-5 flex flex-wrap items-end gap-3 border-t border-border pt-5"
            onSubmit={(e) => {
              e.preventDefault();
              const args: Record<string, string> = {};
              if (refreshAirport.trim()) args["airport"] = refreshAirport.trim().toUpperCase();
              if (focus.trim()) args["destination"] = focus.trim().toUpperCase();
              void run("jobs.refresh", args, "Board refreshed");
            }}
          >
            <div className="w-32">
              <Field label="Board airport" htmlFor="r-airport">
                <input
                  id="r-airport"
                  className={cn(inputClass, "font-mono uppercase")}
                  placeholder={boards[0]?.origin ?? "KMEM"}
                  value={refreshAirport}
                  maxLength={8}
                  onChange={(e) => setRefreshAirport(e.target.value)}
                />
              </Field>
            </div>
            <div className="w-36">
              <Field label="Jobs to (optional)" htmlFor="r-dest">
                <input
                  id="r-dest"
                  className={cn(inputClass, "font-mono uppercase")}
                  placeholder="KATL"
                  value={focus}
                  maxLength={8}
                  onChange={(e) => setFocus(e.target.value)}
                />
              </Field>
            </div>
            <button
              type="submit"
              className={secondaryButton}
              disabled={!connector || busy}
              title={disabledNote}
              data-testid="refresh-board"
            >
              <RefreshCw className="size-4" aria-hidden="true" /> Refresh board
            </button>
            <p className="ml-auto text-xs text-muted-foreground">
              Aircraft: <span className="text-foreground">{type.name}</span>
              {jobs
                ? ` (${jobs.aircraft.source === "title" ? "matched from the aircraft title" : jobs.aircraft.source})`
                : ""}{" "}
              · approximate figures, for gameplay
            </p>
          </form>
          <p
            role="status"
            aria-live="polite"
            className={cn(
              "mt-3 min-h-5 text-sm",
              message?.ok === false ? "text-destructive" : "text-success",
            )}
            data-testid="command-message"
          >
            {message?.text ?? ""}
          </p>
        </Panel>

        <div className="col-span-12 flex flex-col gap-3 xl:col-span-8">
          {jobs === null ? (
            <EmptyState
              icon={Package}
              title={state.connection === "connecting" ? "Connecting…" : "No job board yet"}
              description={
                connector
                  ? "The connector has not published a job board."
                  : demo
                    ? "Loading the bundled airport list to generate the demo board…"
                    : "Start the local connector to receive generated contracts."
              }
            />
          ) : visible.length === 0 ? (
            <EmptyState icon={Package} title="No contracts match the filters" />
          ) : (
            <ul className="flex flex-col gap-3" aria-label="Contracts" data-testid="job-list">
              {visible.slice(0, shown).map((job) => (
                <MissionCard
                  key={job.id}
                  job={job}
                  type={type}
                  lookup={lookup}
                  source={source}
                  action={acceptButton(job)}
                />
              ))}
            </ul>
          )}
          {visible.length > shown ? (
            <button
              type="button"
              className={secondaryButton}
              onClick={() => setShown((n) => n + PAGE)}
            >
              Show more ({visible.length - shown} left)
            </button>
          ) : null}
          {demo ? (
            <p className="text-xs text-muted-foreground" data-testid="accept-disabled-note">
              Accept is disabled in demo mode: it needs the connector.
            </p>
          ) : null}
        </div>

        <div className="col-span-12 flex flex-col gap-3 xl:col-span-4">
          <Panel
            eyebrow="Dispatch"
            title="Accepted jobs"
            icon={Truck}
            action={<SourceTag source={source} />}
          >
            {accepted.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                {demo
                  ? "Accepted jobs appear here when the connector runs."
                  : "Accept jobs, select the ones sharing a route and load them as one mission."}
              </p>
            ) : (
              <ul className="flex flex-col gap-2" data-testid="accepted-jobs">
                {accepted.map((j) => (
                  <li
                    key={j.id}
                    className="panel-inset flex items-center gap-3 px-3 py-2.5"
                    data-job-id={j.id}
                  >
                    <input
                      type="checkbox"
                      aria-label={`Select ${j.id}`}
                      className="size-4 accent-primary"
                      disabled={j.status !== "accepted" || missionOpen}
                      checked={selected.includes(j.id) || j.status === "loaded"}
                      onChange={(e) =>
                        setSelected((s) =>
                          e.target.checked ? [...s, j.id] : s.filter((x) => x !== j.id),
                        )
                      }
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-mono text-sm text-foreground">
                        {j.origin} → {j.destination}
                      </p>
                      <p className="flex items-center gap-2 text-xs text-muted-foreground">
                        <KindBadge kind={j.kind} className="px-1.5 py-0" />
                        <span className="font-tabular">{formatInt(j.weightKg)} kg</span>
                        <span className="font-tabular">{formatUsd(j.payoutEstimate)}</span>
                      </p>
                    </div>
                    {j.status === "accepted" ? (
                      <button
                        type="button"
                        className="text-xs text-muted-foreground hover:text-foreground disabled:opacity-50"
                        disabled={busy}
                        onClick={() => void run("job.release", { jobId: j.id }, `Released ${j.id}`)}
                      >
                        Release
                      </button>
                    ) : (
                      <span className="font-mono text-[0.625rem] uppercase tracking-[0.16em] text-accent">
                        loaded
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-4 flex flex-wrap gap-2">
              <button
                type="button"
                className={primaryButton}
                disabled={!connector || busy || missionOpen || selectedJobs.length === 0}
                title={disabledNote}
                data-testid="load-mission"
                onClick={() =>
                  void run(
                    "mission.load",
                    { jobIds: selectedJobs.map((j) => j.id) },
                    "Mission loaded: start at the origin with the parking brake set",
                  ).then((ok) => ok && setSelected([]))
                }
              >
                Load mission ({selectedJobs.length})
              </button>
              {mission?.status === "loaded" ? (
                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy}
                  onClick={() => void run("mission.unload", {}, "Mission unloaded")}
                >
                  Unload
                </button>
              ) : null}
              {missionOpen ? (
                <button
                  type="button"
                  className={cn(secondaryButton, "text-destructive")}
                  disabled={busy}
                  onClick={() => void run("mission.abort", {}, "Mission aborted")}
                >
                  Abort
                </button>
              ) : null}
            </div>
          </Panel>

          {lastPayout ? (
            <Panel
              eyebrow="Payout"
              title={`Mission ${mission?.id ?? ""} delivered`}
              icon={PackageCheck}
              action={<SourceTag source={source} />}
            >
              <p className="metric-lg" data-testid="mission-paid">
                {formatUsd(lastPayout.total)}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                Landing {mission?.landingGrade ?? "—"} · reputation{" "}
                {(mission?.reputationDelta ?? 0) >= 0 ? "+" : ""}
                {mission?.reputationDelta ?? 0}
              </p>
              <div className="mt-4 flex flex-col gap-3">
                {lastPayout.jobs.map((b) => (
                  <div key={b.jobId}>
                    <p className="mb-1 font-mono text-xs text-muted-foreground">{b.jobId}</p>
                    <PayoutBreakdown breakdown={b} />
                  </div>
                ))}
              </div>
            </Panel>
          ) : null}

          <RouteFinder
            start={startAirport}
            jobs={[...available, ...accepted]}
            type={type}
            source={source}
          />
        </div>
      </div>
    </>
  );
}
