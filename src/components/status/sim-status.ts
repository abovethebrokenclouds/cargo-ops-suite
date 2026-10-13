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
