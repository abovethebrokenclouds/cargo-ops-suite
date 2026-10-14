import { MapPin, Search, X } from "lucide-react";
import { useMemo, useState } from "react";

import type { PlanBasis, Result } from "@cargo-ops/protocol";
import type { AirportLookup } from "@cargo-ops/economy";
import { ghostButton, inputClass } from "@/components/company/styles";
import { searchAirports } from "@/lib/economy/airport-search";
import { PLAN_BASIS_LABELS } from "@/lib/flight/flight-view";
import type { CommandFn } from "@/lib/transport/useSimConnection";
import { cn } from "@/lib/utils";

/** Which source the route uses, as a small chip (token colours only). */
export function PlanBasisTag({
  basis,
  className,
}: {
  basis: PlanBasis | null;
  className?: string;
}) {
  if (!basis) return null;
  return (
    <span
      className={cn(
        "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold uppercase leading-none tracking-[0.16em]",
        basis === "gps"
          ? "bg-primary/15 text-accent"
          : basis === "manual"
            ? "bg-secondary text-foreground"
            : "bg-tertiary/20 text-foreground",
        className,
      )}
      data-testid="plan-basis"
      data-basis={basis}
      title={
        basis === "gps"
          ? "Distance and ETE from the simulator's GPS flight plan"
          : "Distance and ETE computed by the connector from your position and ground speed (not GPS)"
      }
    >
      {PLAN_BASIS_LABELS[basis]}
    </span>
  );
}

function resultText(r: Result, icao: string | null): { ok: boolean; text: string } {
  if (!r.ok) return { ok: false, text: `${r.error.message} (${r.error.code})` };
  const data = (r.data ?? {}) as { basis?: PlanBasis | null };
  if (icao === null) {
    return {
      ok: true,
      text:
        data.basis === "mission"
          ? "Manual destination cleared; back to the mission's destination."
          : "Manual destination cleared.",
    };
  }
  return {
    ok: true,
    text:
      data.basis === "gps"
        ? `${icao} saved for this flight. The simulator's GPS flight plan is active and takes precedence.`
        : `${icao} set as the destination for this flight.`,
  };
}

/**
 * Pick a destination airport for the current flight when the simulator has no GPS flight plan.
 * The connector keeps the choice until the flight ends and computes distance and ETE itself;
 * precedence is GPS plan, then this choice, then the loaded mission's destination.
 */
export function DestinationPicker({
  lookup,
  basis,
  destination,
  missionDestination,
  enabled,
  disabledNote,
  command,
}: {
  lookup: AirportLookup | null;
  basis: PlanBasis | null;
  destination: string | null;
  missionDestination: string | null;
  enabled: boolean;
  disabledNote?: string | undefined;
  command: CommandFn;
}) {
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const results = useMemo(() => (lookup ? searchAirports(lookup, query) : []), [lookup, query]);

  const pick = async (icao: string | null) => {
    setBusy(true);
    const r = await command("plan.destination", { icao });
    setBusy(false);
    setMessage(resultText(r, icao));
    if (r.ok) setQuery("");
  };

  const status =
    basis === "gps"
      ? "The simulator's GPS flight plan is in use. A destination picked here applies when no GPS plan is active."
      : basis === "manual"
        ? `Manual destination ${destination ?? ""} for this flight; distance and ETE are computed from your position, not GPS.`
        : basis === "mission"
          ? `Mission destination ${destination ?? missionDestination ?? ""} (default). Pick another airport to override it for this flight.`
          : "No GPS flight plan. Pick a destination airport to see distance and ETE.";

  return (
    <div className="flex flex-col gap-3" data-testid="destination-picker">
      <p className="text-xs text-muted-foreground" data-testid="destination-status">
        {status}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <label className="relative block min-w-0 flex-1">
          <span className="sr-only">Destination airport</span>
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <input
            type="search"
            className={cn(inputClass, "pl-9")}
            placeholder={
              missionDestination
                ? `Destination (mission: ${missionDestination})`
                : "Destination: ICAO, IATA or name"
            }
            value={query}
            disabled={!enabled || busy || !lookup}
            title={disabledNote}
            onChange={(e) => {
              setQuery(e.target.value);
              setMessage(null);
            }}
            data-testid="destination-search"
          />
        </label>
        {basis === "manual" ? (
          <button
            type="button"
            className={ghostButton}
            disabled={!enabled || busy}
            onClick={() => void pick(null)}
            data-testid="destination-clear"
          >
            <X className="size-3.5" aria-hidden="true" />
            Clear
          </button>
        ) : null}
      </div>
      {disabledNote && !enabled ? (
        <p className="text-xs text-muted-foreground" data-testid="destination-disabled">
          {disabledNote}
        </p>
      ) : null}
      {results.length > 0 ? (
        <ul className="flex flex-col gap-1" data-testid="destination-results">
          {results.map((a) => (
            <li key={a.ident}>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors hover:bg-secondary disabled:opacity-50"
                disabled={!enabled || busy}
                onClick={() => void pick(a.ident)}
                data-testid="destination-result"
                data-ident={a.ident}
              >
                <span className="flex min-w-0 items-center gap-2 truncate">
                  <MapPin className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span className="font-mono font-semibold text-foreground">{a.ident}</span>
                  <span className="truncate text-muted-foreground">{a.name}</span>
                </span>
                <span className="label-eyebrow shrink-0">{a.type}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? (
        <p
          className={cn("text-xs", message.ok ? "text-muted-foreground" : "text-destructive")}
          role={message.ok ? "status" : "alert"}
          data-testid="destination-message"
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
