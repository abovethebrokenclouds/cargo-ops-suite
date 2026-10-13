// Shared copy for panels that have no data because there is no session yet (P6 empty-state
// audit). Returns null when a session exists (live, replay or demo): the panel then shows its
// own "no data yet" state. Never stands in for numbers.

import type { ClientSimState } from "@/lib/sim-state";

export interface ConnectionEmptyCopy {
  title: string;
  description: string;
  /** For tests and styling. */
  kind: "connecting" | "offline";
}

export function connectionEmpty(state: ClientSimState): ConnectionEmptyCopy | null {
  switch (state.connection) {
    case "live":
    case "replay":
    case "demo":
      return null;
    case "idle":
    case "connecting":
      return {
        kind: "connecting",
        title: "Connecting…",
        description: "Reaching the local connector. This only takes a moment.",
      };
    default:
      return {
        kind: "offline",
        title: "Connector offline",
        description:
          "The local connector is not reachable. Start scripts\\start-cargo-ops.cmd (or check its window); this page reconnects on its own.",
      };
  }
}
