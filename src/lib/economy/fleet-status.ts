import type { AircraftStatus } from "@cargo-ops/protocol";

/** Short fleet status labels for the dashboard console. "SIM" alone means simulator data
 * elsewhere in the app, so the hired-pilot status spells out SIMULATED. */
export const DASHBOARD_FLEET_STATUS: Record<AircraftStatus, string> = {
  available: "READY",
  in_flight: "FLYING",
  maintenance: "MAINT",
  sold: "SOLD",
  returned: "RETURNED",
  repossessed: "REPOSSESSED",
  written_off: "WRITTEN OFF",
  hired: "HIRED PILOT (SIMULATED)",
};
