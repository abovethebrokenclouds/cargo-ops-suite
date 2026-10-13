import { isSimConnected, type ClientSimState } from "@/lib/sim-state";

export type SimStatus = "connecting" | "live" | "demo" | "replay" | "disconnected" | "error";

/** Human label shown on the status chip. Live always names the simulator and protocol. */
export function simStatusLabel(status: SimStatus, simName?: string, protocol?: string): string {
  switch (status) {
    case "live":
      return ["LIVE", simName, protocol].filter(Boolean).join(" · ");
    case "demo":
      return "DEMO DATA";
    case "replay":
      return "REPLAY";
    case "disconnected":
      return "SIM OFFLINE";
    case "connecting":
      return "CONNECTING…";
    case "error":
      return "CONNECTOR ERROR";
  }
}

/** Maps connection state to a chip status. Live only after a real welcome reports a running sim. */
export function chipStatusFor(state: ClientSimState): SimStatus {
  switch (state.connection) {
    case "live":
      return isSimConnected(state) ? "live" : "disconnected";
    case "demo":
      return "demo";
    case "replay":
      return "replay";
    case "idle":
    case "connecting":
      return "connecting";
    case "disconnected":
    case "error":
      return "error";
  }
}
