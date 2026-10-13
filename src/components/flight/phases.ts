// Flight phases in FSM order — docs/CARGO_OPS_PLAN.md §6.2.
export const FLIGHT_PHASES = [
  "Boarding",
  "Taxi Out",
  "Takeoff",
  "Climb",
  "Cruise",
  "Descent",
  "Approach",
  "Landing",
  "Taxi In",
  "Arrived",
] as const;

export type FlightPhase = (typeof FLIGHT_PHASES)[number];
