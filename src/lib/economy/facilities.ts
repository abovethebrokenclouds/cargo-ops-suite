// MSFS facilities override in the browser: the live connector's `facilities` domain (airport
// data the connected sim returned, cached by the connector) merged over the bundled
// OurAirports lookup with the SAME pure merge the connector's job generator uses
// (packages/economy facilities.ts). Every merged field keeps its source so the UI can say
// "MSFS" or "OurAirports" next to it. A replay or the demo never has facility data.

import { useMemo } from "react";
import type { MsfsAirport } from "@cargo-ops/protocol";
import {
  facilityLookup,
  fieldSourceLabel,
  type AirportLookup,
  type FacilityLookup,
  type FieldSource,
} from "@cargo-ops/economy";
import type { ClientSimState } from "@/lib/sim-state";

export { fieldSourceLabel, type FieldSource };

const NONE: readonly MsfsAirport[] = [];

/** MSFS records from a live connector's `facilities` domain (empty otherwise). */
export function facilityRecords(state: ClientSimState): readonly MsfsAirport[] {
  if (state.connection !== "live") return NONE;
  const airports = state.sim.facilities?.airports;
  return airports ? Object.values(airports) : NONE;
}

/** Bundled airports with the live sim's facility data merged over them. */
export function withFacilities(
  lookup: AirportLookup | null,
  records: readonly MsfsAirport[],
): FacilityLookup | null {
  return lookup ? facilityLookup(lookup.list, records) : null;
}

export function useFacilityLookup(
  state: ClientSimState,
  lookup: AirportLookup | null,
): FacilityLookup | null {
  const airports = state.connection === "live" ? state.sim.facilities?.airports : undefined;
  return useMemo(
    () => withFacilities(lookup, airports ? Object.values(airports) : NONE),
    [lookup, airports],
  );
}

export function isFacilityLookup(lookup: AirportLookup | null): lookup is FacilityLookup {
  return lookup !== null && "sourcesOf" in lookup;
}

/** " (MSFS)" / " (OurAirports)" suffix for a field, "" when the source is unknown. */
export function sourceSuffix(source: FieldSource | null | undefined): string {
  return source ? ` (${fieldSourceLabel(source)})` : "";
}
