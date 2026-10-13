import { AlertOctagon, CalendarClock, CheckCircle2, Plane, ShieldAlert } from "lucide-react";

import type {
  AirworthinessStatus,
  Defect,
  DefectSeverity,
  FleetAircraft,
  SystemState,
} from "@cargo-ops/protocol";
import { MIN_SYSTEM_CONDITION, formatGameTime } from "@cargo-ops/economy";
import { ghostButton } from "@/components/company/styles";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

import type { RunCommand } from "./AircraftMarket";

const badgeStyle: Record<AirworthinessStatus, { label: string; tone: string; Icon: typeof Plane }> =
  {
    airworthy: { label: "Airworthy", tone: "bg-success/15 text-success", Icon: CheckCircle2 },
    grounded: { label: "Grounded", tone: "bg-destructive/15 text-destructive", Icon: AlertOctagon },
    ferry_only: { label: "Ferry only", tone: "bg-warning/15 text-warning", Icon: Plane },
    annual_due: { label: "Annual due", tone: "bg-warning/15 text-warning", Icon: CalendarClock },
  };

/** Airworthy / Grounded / Ferry only / Annual due. */
export function AirworthinessBadge({
  status,
  className,
}: {
  status: AirworthinessStatus;
  className?: string;
}) {
  const s = badgeStyle[status];
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.16em]",
        s.tone,
        className,
      )}
      data-testid="airworthiness-badge"
      data-status={status}
    >
      <s.Icon className="size-3" aria-hidden="true" />
      {s.label}
    </span>
  );
}

const severityTone: Record<DefectSeverity, string> = {
  cosmetic: "bg-secondary text-muted-foreground",
  minor: "bg-accent/15 text-accent",
  major: "bg-warning/15 text-warning",
  grounding: "bg-destructive/15 text-destructive",
};

export function SeverityBadge({ severity }: { severity: DefectSeverity }) {
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center rounded-sm px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em]",
        severityTone[severity],
      )}
      data-testid="severity-badge"
      data-severity={severity}
    >
      {severity}
    </span>
  );
}

/** One defect row: severity, title, effects, cost/time and (optionally) actions. */
export function DefectRow({ defect: d, actions }: { defect: Defect; actions?: React.ReactNode }) {
  const effects = [
    d.fuelBurnPct ? `+${d.fuelBurnPct} % fuel` : null,
    d.payloadPct ? `−${d.payloadPct} % payload` : null,
    d.deferralHoursLeft !== undefined
      ? d.deferralHoursLeft >= 0
        ? `deferred · ${d.deferralHoursLeft.toFixed(1)} h left`
        : "deferral expired"
      : null,
  ].filter(Boolean);
  return (
    <li className="flex flex-wrap items-center gap-2 py-1.5 text-sm" data-testid="defect-row">
      <SeverityBadge severity={d.severity} />
      <span className="min-w-0 flex-1 truncate text-foreground" title={d.title}>
        {d.title}
      </span>
      {effects.length ? (
        <span className="font-mono text-[0.6875rem] text-muted-foreground">
          {effects.join(" · ")}
        </span>
      ) : null}
      <span className="font-mono text-xs text-muted-foreground font-tabular">
        {formatUsd(d.repairCost)} · {d.downtimeHours.toFixed(0)} h
      </span>
      {actions}
    </li>
  );
}

function SystemBar({ system }: { system: SystemState }) {
  const tone =
    system.condition < MIN_SYSTEM_CONDITION
      ? "text-destructive"
      : system.condition < 50
        ? "text-warning"
        : "text-success";
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate text-xs text-foreground">{system.label}</span>
        <span className={cn("font-mono text-xs font-semibold font-tabular", tone)}>
          {system.condition.toFixed(1)} %
        </span>
      </div>
      <div
        className="relative h-1.5 overflow-hidden rounded-full bg-secondary"
        role="meter"
        aria-label={system.label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(system.condition)}
      >
        <span
          className={cn("absolute inset-y-0 left-0 rounded-full bg-current", tone)}
          style={{ width: `${Math.max(0, Math.min(100, system.condition))}%` }}
        />
        <span
          className="absolute inset-y-0 w-px bg-destructive/70"
          style={{ left: `${MIN_SYSTEM_CONDITION}%` }}
          aria-hidden="true"
        />
      </div>
    </div>
  );
}

/**
 * Aircraft detail: per-system condition bars, known defects with severity badges and
 * repair/defer actions, the gate's reasons, the annual and the ferry permit.
 */
export function SystemsPanel({
  aircraft: a,
  enabled,
  disabledNote,
  busy,
  run,
}: {
  aircraft: FleetAircraft;
  enabled: boolean;
  disabledNote?: string | undefined;
  busy: boolean;
  run: RunCommand;
}) {
  const systems = a.systems ?? [];
  const defects = systems.flatMap((s) => s.defects);
  const queued = new Set((a.maintenance ?? []).flatMap((o) => o.defectIds));
  const gate = a.airworthiness;
  const canWork = enabled && !busy && a.status !== "in_flight";
  return (
    <div
      className="grid gap-6 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)]"
      data-testid="systems-panel"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          {gate ? <AirworthinessBadge status={gate.status} /> : null}
          {a.ageYears !== undefined ? (
            <span className="font-mono text-xs text-muted-foreground">
              {a.ageYears.toFixed(1)} years · {a.hours.toFixed(1)} h · {a.cycles} cycles
            </span>
          ) : null}
        </div>
        <div className="grid grid-cols-2 gap-x-5 gap-y-3">
          {systems.map((s) => (
            <SystemBar key={s.key} system={s} />
          ))}
        </div>
      </div>

      <div className="flex flex-col gap-4">
        {gate && gate.reasons.length > 0 ? (
          <ul
            className="panel-inset flex flex-col gap-1.5 p-3 text-sm"
            data-testid="gate-reasons"
            aria-label="Why the aircraft cannot be dispatched"
          >
            {gate.reasons.map((r) => (
              <li key={`${r.code}-${r.defectId ?? r.system ?? ""}`} className="flex gap-2">
                <ShieldAlert
                  className="mt-0.5 size-4 shrink-0 text-destructive"
                  aria-hidden="true"
                />
                <span className="text-foreground">{r.message}</span>
              </li>
            ))}
          </ul>
        ) : null}

        <div>
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="label-eyebrow">Known defects ({defects.length})</span>
            <button
              type="button"
              className={ghostButton}
              disabled={!canWork || (a.repairAllCost ?? 0) <= 0}
              title={
                disabledNote ??
                `${formatUsd(a.repairAllCost ?? 0)}, ${(a.repairAllHours ?? 0).toFixed(0)} in-game hours`
              }
              onClick={() =>
                void run(
                  "fleet.repairAll",
                  { aircraftId: a.id },
                  `${a.registration}: repairs queued`,
                )
              }
              data-testid="repair-all"
            >
              Repair all {(a.repairAllCost ?? 0) > 0 ? formatUsd(a.repairAllCost ?? 0) : ""}
            </button>
          </div>
          {defects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No known defects. Hidden ones surface on dispatch or at the annual inspection.
            </p>
          ) : (
            <ul className="divide-y divide-border" data-testid="defect-list">
              {defects.map((d) => (
                <DefectRow
                  key={d.id}
                  defect={d}
                  actions={
                    queued.has(d.id) ? (
                      <span className="font-mono text-[0.625rem] uppercase tracking-[0.14em] text-warning">
                        queued
                      </span>
                    ) : (
                      <span className="flex gap-1">
                        {d.severity === "minor" && d.deferredAtHours === undefined ? (
                          <button
                            type="button"
                            className={ghostButton}
                            disabled={!enabled || busy}
                            title={disabledNote ?? "Defer (MEL): fly it for up to 30 flight hours"}
                            onClick={() =>
                              void run(
                                "fleet.defer",
                                { aircraftId: a.id, defectId: d.id },
                                `${d.title} deferred`,
                              )
                            }
                            data-testid="defer-defect"
                          >
                            Defer
                          </button>
                        ) : null}
                        <button
                          type="button"
                          className={ghostButton}
                          disabled={!canWork}
                          title={disabledNote}
                          onClick={() =>
                            void run(
                              "fleet.repairDefect",
                              { aircraftId: a.id, defectId: d.id },
                              `${d.title}: repair queued`,
                            )
                          }
                          data-testid="repair-defect"
                        >
                          Repair
                        </button>
                      </span>
                    )
                  }
                />
              ))}
            </ul>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-3 text-sm">
          {a.annual ? (
            <div className="panel-inset flex flex-col gap-1 p-3">
              <dt className="label-eyebrow">Annual inspection</dt>
              <dd
                className={cn(
                  "font-mono text-xs",
                  a.annual.due
                    ? "text-destructive"
                    : a.annual.soon
                      ? "text-warning"
                      : "text-foreground",
                )}
              >
                {a.annual.due
                  ? "Due now"
                  : `Due at ${a.annual.dueHours.toFixed(0)} h or ${formatGameTime(a.annual.dueGameMs)}`}
              </dd>
              <dd>
                <button
                  type="button"
                  className={ghostButton}
                  disabled={!canWork}
                  title={
                    disabledNote ?? `${formatUsd(a.annual.cost)}, ${a.annual.hours} in-game hours`
                  }
                  onClick={() =>
                    void run(
                      "fleet.annual",
                      { aircraftId: a.id },
                      `${a.registration}: annual booked`,
                    )
                  }
                  data-testid="book-annual"
                >
                  Book annual {formatUsd(a.annual.cost)}
                </button>
              </dd>
            </div>
          ) : null}
          <div className="panel-inset flex flex-col gap-1 p-3">
            <dt className="label-eyebrow">Ferry permit</dt>
            <dd className="font-mono text-xs text-foreground">
              {a.ferryPermit
                ? `${a.ferryPermit.origin} → ${a.ferryPermit.destination} · ${a.ferryPermit.distanceNm} nm · ≤ ${a.ferryPermit.payloadCapKg} kg`
                : gate?.ferryEligible
                  ? "Available: one flight to the nearest maintenance airport"
                  : "Not needed"}
            </dd>
            {!a.ferryPermit && gate?.ferryEligible ? (
              <dd>
                <button
                  type="button"
                  className={ghostButton}
                  disabled={!enabled || busy || a.status !== "available"}
                  title={disabledNote ?? "No job revenue; payload capped"}
                  onClick={() =>
                    void run(
                      "fleet.ferryPermit",
                      { aircraftId: a.id },
                      `${a.registration}: ferry permit issued`,
                    )
                  }
                  data-testid="ferry-permit"
                >
                  Request permit
                </button>
              </dd>
            ) : null}
          </div>
        </dl>
      </div>
    </div>
  );
}
