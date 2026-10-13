import type { FlightPhase, FuelState } from "@cargo-ops/protocol";
import type { ClientSimState, ReceivedEvent } from "./reducer";

/** Below this total flow (pounds per hour) endurance is treated as unknown, not infinite. */
const MIN_FLOW_PPH = 1;
/** Below this ground speed (knots) ETE is unknown. */
const MIN_GS_KT = 1;

/** Connected to the local connector in live mode (the sim itself may still be offline). */
export function isLive(state: ClientSimState): boolean {
  return state.connection === "live";
}

export function isDemo(state: ClientSimState): boolean {
  return state.connection === "demo";
}

/** The connector reports a running simulator. Never true outside a live session. */
export function isSimConnected(state: ClientSimState): boolean {
  if (!isLive(state) || !state.welcome) return false;
  return state.sim.sim?.connected ?? state.welcome.sim.connected;
}

/** Text for the persistent status chip. */
export function statusLabel(state: ClientSimState): string {
  switch (state.connection) {
    case "live": {
      if (!isSimConnected(state)) return "SIM OFFLINE";
      const name = state.sim.sim?.name ?? state.welcome?.sim.name;
      const protocol = state.welcome?.sim.protocol;
      return ["LIVE", name, protocol].filter(Boolean).join(" · ");
    }
    case "demo":
      return "DEMO DATA";
    case "replay":
      return "REPLAY";
    case "connecting":
      return "CONNECTING";
    case "disconnected":
      return "CONNECTOR OFFLINE";
    case "error":
      return "CONNECTION ERROR";
    case "idle":
      return "IDLE";
  }
}

export function currentPhase(state: ClientSimState): FlightPhase | null {
  return state.sim.phase?.current ?? null;
}

export function recentEvents(state: ClientSimState, count = 20): ReceivedEvent[] {
  return state.events.slice(-count).reverse();
}

/** Fuel endurance in minutes at the current total flow, or null when unknown. */
export function fuelEnduranceMin(fuel: FuelState | null | undefined): number | null {
  if (!fuel || !Number.isFinite(fuel.totalLb)) return null;
  const flow = fuel.flowPph.reduce((sum, f) => sum + (Number.isFinite(f) ? f : 0), 0);
  if (flow < MIN_FLOW_PPH) return null;
  return (fuel.totalLb / flow) * 60;
}

/** Time en route in minutes for a distance (nautical miles) at a ground speed (knots). */
export function eteMin(distanceNm: number | null | undefined, gsKt: number | null | undefined) {
  if (distanceNm == null || gsKt == null) return null;
  if (!Number.isFinite(distanceNm) || !Number.isFinite(gsKt)) return null;
  if (distanceNm < 0 || gsKt < MIN_GS_KT) return null;
  return (distanceNm / gsKt) * 60;
}

/** ETE to the destination from the plan domain and current ground speed. */
export function destinationEteMin(state: ClientSimState): number | null {
  return eteMin(state.sim.plan?.destDistanceNm, state.sim.motion?.gsKt);
}

/** Milliseconds since the last applied frame, or null before the first one. */
export function frameAgeMs(state: ClientSimState, now: number): number | null {
  return state.lastFrameAt === null ? null : Math.max(0, now - state.lastFrameAt);
}
