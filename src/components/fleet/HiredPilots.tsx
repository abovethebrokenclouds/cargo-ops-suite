import { UserRound } from "lucide-react";
import { useState } from "react";

import {
  PILOT_RATINGS,
  PILOT_RATING_LABELS,
  type HiredPilot,
  type PilotRating,
  type PilotsState,
  type Source,
} from "@cargo-ops/protocol";
import { formatGameTime } from "@cargo-ops/economy";
import { ghostButton, inputClass, secondaryButton } from "@/components/company/styles";
import { SourceTag } from "@/components/status/SourceTag";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatInt, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

type Run = (name: string, args: unknown, success: string) => Promise<boolean>;

/** The label every hired-pilot surface carries: a modelled operation, never telemetry. */
export function SimulatedTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "rounded-sm bg-tertiary/20 px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em] text-foreground",
        className,
      )}
      data-testid="simulated-tag"
    >
      Hired pilot (simulated)
    </span>
  );
}

function statusLine(p: HiredPilot): string {
  if (p.status === "fired") {
    return `Let go${p.firedGameMs !== undefined ? ` ${formatGameTime(p.firedGameMs)}` : ""} · shown for this month's P&L`;
  }
  const as = p.assignment;
  if (!as) return "Unassigned";
  if (as.leg) {
    return `Flying ${as.leg.from} → ${as.leg.to} · arrives ${formatGameTime(as.leg.arriveGameMs)}`;
  }
  return as.nextDepartureGameMs !== undefined
    ? `Next departure ${formatGameTime(as.nextDepartureGameMs)}`
    : "Scheduled";
}

/**
 * Hired pilots (plan §7.4): hire by rating, assign an owned aircraft to a route between
 * served airports, and the monthly P&L per pilot. Simulated economy, clearly labelled; every
 * action needs the connector (disabled in demo mode).
 */
export function HiredPilots({
  pilots,
  source,
  enabled,
  disabledNote,
  busy,
  run,
}: {
  pilots: PilotsState | null;
  source: Source | null;
  enabled: boolean;
  disabledNote: string | undefined;
  busy: boolean;
  run: Run;
}) {
  const [rating, setRating] = useState<PilotRating>("turboprop");
  if (!pilots) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="pilots-empty">
        No hired pilot data yet.
      </p>
    );
  }
  const onPayroll = pilots.pilots.filter((p) => p.status !== "fired").length;
  const full = onPayroll >= pilots.maxPilots;
  return (
    <div className="flex flex-col gap-5" data-testid="hired-pilots">
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
        <SimulatedTag />
        <span>
          A hired pilot flies one of your owned aircraft back and forth on a fixed route in in-game
          time. It is a simulated economy model: no telemetry, no logbook flights, no landing
          grades, and it never counts toward your own hours or landing streak. A leg earns{" "}
          {Math.round(pilots.payoutShare * 100)} % of what the job board would pay you; fuel,
          landing fees and wear are booked as for your own flights. The aircraft is not available to
          you until the pilot is unassigned.
        </span>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="panel-inset px-4 py-3">
          <p className="label-eyebrow">Pilots</p>
          <p className="metric-md" data-testid="pilot-count">
            {onPayroll} / {pilots.maxPilots}
          </p>
        </div>
        <div className="panel-inset px-4 py-3">
          <p className="label-eyebrow">This month · income</p>
          <p className="metric-md text-success" data-testid="pilots-month-income">
            {formatUsd(pilots.monthIncome)}
          </p>
        </div>
        <div className="panel-inset px-4 py-3">
          <p className="label-eyebrow">This month · wages, fuel, fees</p>
          <p className="metric-md text-destructive" data-testid="pilots-month-costs">
            {formatUsd(pilots.monthCosts)}
          </p>
        </div>
      </div>

      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run("pilot.hire", { rating }, `Hired a ${PILOT_RATING_LABELS[rating]} pilot`);
        }}
      >
        <label className="flex min-w-48 flex-col gap-1 text-xs text-muted-foreground">
          Type rating
          <select
            className={inputClass}
            value={rating}
            onChange={(e) => setRating(e.target.value as PilotRating)}
            disabled={!enabled || busy}
            data-testid="pilot-rating"
          >
            {PILOT_RATINGS.map((r) => (
              <option key={r} value={r}>
                {PILOT_RATING_LABELS[r]} · {formatUsd(pilots.wages[r] ?? 0)}/month
              </option>
            ))}
          </select>
        </label>
        <button
          type="submit"
          className={secondaryButton}
          disabled={!enabled || busy || full}
          title={
            disabledNote ??
            (full
              ? `At most ${pilots.maxPilots} pilots`
              : "The first month's wage is paid now; no refund when fired")
          }
          data-testid="hire-pilot"
        >
          <UserRound className="size-4" aria-hidden="true" /> Hire pilot
        </button>
      </form>

      {pilots.pilots.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="no-pilots">
          No pilots on the payroll.
        </p>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {pilots.pilots.map((p) => (
            <PilotCard
              key={p.id}
              pilot={p}
              pilots={pilots}
              source={source}
              enabled={enabled}
              disabledNote={disabledNote}
              busy={busy}
              run={run}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function PilotCard({
  pilot: p,
  pilots,
  source,
  enabled,
  disabledNote,
  busy,
  run,
}: {
  pilot: HiredPilot;
  pilots: PilotsState;
  source: Source | null;
  enabled: boolean;
  disabledNote: string | undefined;
  busy: boolean;
  run: Run;
}) {
  const options = pilots.options.filter((o) => o.rating === p.rating);
  const [aircraftId, setAircraftId] = useState<string>("");
  const [destination, setDestination] = useState<string>("");
  const option = options.find((o) => o.aircraftId === aircraftId) ?? options[0] ?? null;
  const dest =
    option?.destinations.find((d) => d.icao === destination) ?? option?.destinations[0] ?? null;
  const as = p.assignment;
  const fired = p.status === "fired";
  const pnl = [...p.pnl].reverse();
  return (
    <article
      className="panel-elevated flex flex-col gap-4 p-5"
      data-testid="pilot-card"
      data-pilot-id={p.id}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="metric-md" data-testid="pilot-name">
            {p.name}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {PILOT_RATING_LABELS[p.rating]} rating · {formatUsd(p.wageMonthly)}/month ·{" "}
            {formatInt(p.legsFlown)} legs flown
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <SimulatedTag />
          <SourceTag source={source} />
        </div>
      </div>

      <div className="text-sm">
        {as ? (
          <p className="text-foreground" data-testid="pilot-route">
            {as.registration} · {as.typeName} · {as.origin} ⇄ {as.destination} (
            {formatInt(as.distanceNm)} nm)
          </p>
        ) : null}
        <p className="text-muted-foreground" data-testid="pilot-status">
          {statusLine(p)}
        </p>
        {p.stopped && !as ? (
          <p className="text-warning" data-testid="pilot-stopped">
            Route stopped {formatGameTime(p.stopped.gameMs)}: {p.stopped.message}
          </p>
        ) : null}
      </div>

      {as || fired ? null : (
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Aircraft (from where it is parked)
            <select
              className={inputClass}
              value={option?.aircraftId ?? ""}
              onChange={(e) => {
                setAircraftId(e.target.value);
                setDestination("");
              }}
              disabled={!enabled || busy || options.length === 0}
              data-testid="pilot-aircraft"
            >
              {options.length === 0 ? (
                <option value="">No owned, available, airworthy aircraft for this rating</option>
              ) : (
                options.map((o) => (
                  <option key={o.aircraftId} value={o.aircraftId}>
                    {o.registration} · {o.typeName} at {o.origin}
                  </option>
                ))
              )}
            </select>
          </label>
          <label className="flex min-w-40 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Destination (airports you serve)
            <select
              className={inputClass}
              value={dest?.icao ?? ""}
              onChange={(e) => setDestination(e.target.value)}
              disabled={!enabled || busy || !option || option.destinations.length === 0}
              data-testid="pilot-destination"
            >
              {option?.destinations.map((d) => (
                <option key={d.icao} value={d.icao}>
                  {d.icao} · {formatInt(d.distanceNm)} nm · ≈ {formatUsd(d.income)}/leg
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className={secondaryButton}
            disabled={!enabled || busy || !option || !dest}
            title={
              disabledNote ??
              (dest
                ? `≈ ${formatUsd(dest.income)} a leg (board ${formatUsd(dest.boardPayout)}) − ≈ ${formatUsd(dest.costs)} fuel and fees, ${dest.blockMin} min block`
                : undefined)
            }
            onClick={() =>
              option && dest
                ? void run(
                    "pilot.assign",
                    { pilotId: p.id, aircraftId: option.aircraftId, destination: dest.icao },
                    `${p.name} flies ${option.origin} ⇄ ${dest.icao} (simulated)`,
                  )
                : undefined
            }
            data-testid="assign-pilot"
          >
            Assign route
          </button>
        </div>
      )}

      {fired ? null : (
        <div className="flex flex-wrap gap-2">
          {as ? (
            <button
              type="button"
              className={ghostButton}
              disabled={!enabled || busy}
              title={disabledNote ?? "A leg in progress is cancelled; the aircraft is yours again"}
              onClick={() =>
                void run("pilot.unassign", { pilotId: p.id }, `${p.name} is off the route`)
              }
              data-testid="unassign-pilot"
            >
              Unassign
            </button>
          ) : null}
          <button
            type="button"
            className={cn(ghostButton, "ml-auto")}
            disabled={!enabled || busy}
            title={disabledNote ?? "Wages stop; this month's wage is not refunded"}
            onClick={() => void run("pilot.fire", { pilotId: p.id }, `${p.name} let go`)}
            data-testid="fire-pilot"
          >
            Let go
          </button>
        </div>
      )}

      <Table data-testid="pilot-pnl">
        <TableHeader>
          <TableRow className="border-border hover:bg-transparent">
            <TableHead className="label-eyebrow h-8">Month</TableHead>
            <TableHead className="label-eyebrow h-8 text-right">Legs</TableHead>
            <TableHead className="label-eyebrow h-8 text-right">Income</TableHead>
            <TableHead className="label-eyebrow h-8 text-right">Wage, fuel, fees</TableHead>
            <TableHead className="label-eyebrow h-8 text-right">Net</TableHead>
            <TableHead className="label-eyebrow hidden h-8 text-right md:table-cell">
              Wear (repair value)
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {pnl.map((m) => (
            <TableRow key={m.month} className="border-border hover:bg-secondary/40">
              <TableCell className="font-mono text-xs text-muted-foreground">
                Month {m.month + 1}
              </TableCell>
              <TableCell className="text-right font-mono text-sm font-tabular">
                {formatInt(m.legs)}
              </TableCell>
              <TableCell className="text-right font-mono text-sm text-success font-tabular">
                {formatUsd(m.income)}
              </TableCell>
              <TableCell className="text-right font-mono text-sm text-destructive font-tabular">
                {formatUsd(m.wages + m.fuel + m.fees)}
              </TableCell>
              <TableCell
                className={cn(
                  "text-right font-mono text-sm font-tabular",
                  m.net >= 0 ? "text-success" : "text-destructive",
                )}
                data-testid="pilot-pnl-net"
              >
                {formatUsd(m.net)}
              </TableCell>
              <TableCell className="hidden text-right font-mono text-xs text-muted-foreground font-tabular md:table-cell">
                {m.wear.toFixed(2)} pts · {formatUsd(m.wearValue)}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </article>
  );
}
