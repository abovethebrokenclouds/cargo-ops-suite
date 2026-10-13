// Flight phases in FSM order — docs/CARGO_OPS_PLAN.md §6.2. The keys come from the
// protocol so the timeline binds directly to `phase.current`; labels are display-only.
import { FLIGHT_PHASES, type FlightPhase } from "@cargo-ops/protocol";

export { FLIGHT_PHASES, type FlightPhase };

export const PHASE_LABELS: Record<FlightPhase, string> = {
  Boarding: "Boarding",
  TaxiOut: "Taxi Out",
  Takeoff: "Takeoff",
  Climb: "Climb",
  Cruise: "Cruise",
  Descent: "Descent",
  Approach: "Approach",
  Landing: "Landing",
  TaxiIn: "Taxi In",
  Arrived: "Arrived",
};
