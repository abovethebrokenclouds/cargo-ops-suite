import { ClipboardList } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { EMPTY, formatInt, formatMinutes } from "@/lib/format";
import type { FlightSummaryView } from "@/lib/flight/flight-view";

import {
  Annunciator,
  SubReadout,
  type AnnunciatorProps,
  type AnnunciatorTone,
} from "./Annunciator";

const STATUS_LABELS: Record<NonNullable<FlightSummaryView["status"]>, string> = {
  active: "In progress",
  completed: "Completed",
  aborted: "Aborted",
  failed: "Failed",
};

function flagLights(flags: FlightSummaryView["flags"]): AnnunciatorProps[] {
  const light = (
    label: string,
    on: boolean | undefined,
    tone: AnnunciatorTone,
  ): AnnunciatorProps =>
    on === undefined ? { label, state: "unknown" } : { label, state: on ? "on" : "off", tone };
  return [
    light("Teleport", flags?.teleport, "destructive"),
    light("No bonus", flags?.noBonus, "warning"),
    light("Invalidated", flags?.invalidated, "destructive"),
    light("Crashed", flags?.crashed, "destructive"),
  ];
}

function one(n: number | null): string {
  return n === null ? EMPTY : (Math.round(n * 10) / 10).toFixed(1);
}

/** Distance, block/air time and verification flags of the tracked flight (plan §6.4). */
export function FlightSummary({ summary }: { summary: FlightSummaryView | null }) {
  if (!summary) {
    return (
      <EmptyState
        icon={ClipboardList}
        title="No tracked flight"
        description="Tracking starts at takeoff, or when a flight is started on the ground with the parking brake set."
      />
    );
  }
  const status = summary.status
    ? STATUS_LABELS[summary.status]
    : summary.active
      ? "In progress"
      : EMPTY;
  return (
    <div className="flex flex-col gap-4" data-testid="flight-summary">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <SubReadout label="Status" value={status} />
        <SubReadout label="Distance flown" value={one(summary.distanceNm)} unit="nm" />
        <SubReadout label="Block time" value={formatMinutes(summary.blockMin)} />
        <SubReadout label="Air time" value={formatMinutes(summary.airborneMin)} />
        <SubReadout
          label="Fuel used"
          value={summary.fuelUsedLb === null ? EMPTY : formatInt(summary.fuelUsedLb)}
          unit="lb"
        />
        <SubReadout
          label="Max altitude"
          value={summary.maxAltFt === null ? EMPTY : formatInt(summary.maxAltFt)}
          unit="ft"
        />
      </div>
      <div className="grid grid-cols-2 gap-2" aria-label="Verification flags">
        {flagLights(summary.flags).map((a) => (
          <Annunciator key={a.label} {...a} />
        ))}
      </div>
    </div>
  );
}
