import type { Job } from "@cargo-ops/protocol";
import type { AirportLookup } from "@cargo-ops/economy";

import type { OpsMapPin } from "@/components/map/OpsMap";
import { transitDeadlineText, transitView } from "./format";

/**
 * Map pins for transit cargo (docs/ECONOMY.md "Transit cargo"): one pin per airport holding
 * stored cargo, its hover text listing each job's final destination and deadline.
 */
export function transitPins(
  jobs: readonly Job[],
  nowGameMs: number | null,
  lookup: AirportLookup | null,
): OpsMapPin[] {
  const byAirport = new Map<string, Job[]>();
  for (const j of jobs) {
    if (j.status !== "in_transit" || !j.transit) continue;
    const list = byAirport.get(j.transit.location) ?? [];
    list.push(j);
    byAirport.set(j.transit.location, list);
  }
  const pins: OpsMapPin[] = [];
  for (const [icao, list] of [...byAirport.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const airport = lookup?.get(icao);
    if (!airport) continue;
    const lines = list.map((j) => {
      const v = transitView(j, nowGameMs);
      if (!v) return j.id;
      return `${j.id} → ${v.destination}, ${transitDeadlineText(v)}`;
    });
    pins.push({
      id: `transit-${icao}`,
      kind: "transit",
      lat: airport.lat,
      lon: airport.lon,
      label: `${icao} · ${list.length} in transit`,
      title: `Transit cargo at ${airport.name}: ${lines.join("; ")}`,
    });
  }
  return pins;
}
