import { isSimConnected, type ClientSimState } from "@/lib/sim-state";

/** One-line explanation under the chip: where the numbers come from, or why there are none. */
export function panelSourceNote(state: ClientSimState, pairingRequired = false): string | null {
  if (pairingRequired) return "Open this panel on the PC that runs Cargo Ops.";
  switch (state.connection) {
    case "demo":
      return "DEMO DATA: the built-in demo flight, not your simulator.";
    case "replay":
      return "REPLAY: a recorded flight, not live data.";
    case "live":
      return isSimConnected(state)
        ? null
        : "Cargo Ops is running. Start a flight in the simulator to see live data.";
    case "disconnected":
    case "error":
      return "Cargo Ops is not reachable. Start scripts\\start-cargo-ops.cmd on this PC.";
    default:
      return "Connecting to Cargo Ops…";
  }
}
