// View model for the Ops dashboard's flight operations room: the GO / NO-GO status board,
// the mission elapsed / UTC clocks and the event loop. Pure functions over real state only:
// a lamp is never GO without the data behind it, and anything unknown is NO DATA.

import type { FleetAircraft, FleetState, Source } from "@cargo-ops/protocol";
import type { FlightCategory } from "@cargo-ops/weather";

import { enduranceStatus, isSessionUp, isStale, weightsView } from "@/lib/flight/flight-view";
import { EMPTY, formatInt } from "@/lib/format";
import {
  destinationEteMin,
  fuelEnduranceMin,
  isSimConnected,
  isSimOfflineSession,
  type ClientSimState,
  type ReceivedEvent,
} from "@/lib/sim-state";

export type LampState = "go" | "hold" | "nogo" | "info" | "nodata";

export interface Lamp {
  id: string;
  /** Short board label (upper case). */
  label: string;
  state: LampState;
  /** Short status word shown in the lamp. */
  value: string;
  /** One-line explanation (tooltip / screen readers). */
  detail: string;
  /** Where the data behind the lamp came from; null when there is none. */
  source: Source | null;
  /** Built-in sample data (weather in the demo and in replays), never real. */
  sample?: boolean;
}

export interface WeatherLampInput {
  station: string | null;
  category: FlightCategory | null;
  sample: boolean;
  /** Source of the session the report belongs to. */
  source: Source | null;
}

export interface GoNoGoInput {
  state: ClientSimState;
  /** Client clock, ms; null before mount. */
  now: number | null;
  fleet: FleetState | null;
  fleetSource: Source | null;
  weather: WeatherLampInput;
}

function noData(id: string, label: string, detail: string): Lamp {
  return { id, label, state: "nodata", value: "NO DATA", detail, source: null };
}

function linkLamp(state: ClientSimState): Lamp {
  const id = "link";
  const label = "SIM LINK";
  switch (state.connection) {
    case "live":
      return isSimConnected(state)
        ? {
            id,
            label,
            state: "go",
            value: "GO",
            detail: "Connector welcome received and the simulator is running.",
            source: "sim",
          }
        : {
            id,
            label,
            state: "nogo",
            value: "SIM OFF",
            detail: "Connector online, simulator not running.",
            source: null,
          };
    case "demo":
      return {
        id,
        label,
        state: "hold",
        value: "DEMO",
        detail: "Built-in demo flight: no simulator is connected.",
        source: "demo",
      };
    case "replay":
      return {
        id,
        label,
        state: "hold",
        value: "REPLAY",
        detail: "The connector is replaying a recording: no simulator is connected.",
        source: "replay",
      };
    case "disconnected":
    case "error":
      return {
        id,
        label,
        state: "nogo",
        value: "OFFLINE",
        detail: "The local connector is not reachable.",
        source: null,
      };
    default:
      return noData(id, label, "Waiting for the connector welcome.");
  }
}

function freshLamp(state: ClientSimState, now: number | null): Lamp {
  const id = "fresh";
  const label = "DATA";
  if (isSimOfflineSession(state)) {
    // Frames may still arrive (company clock, jobs) but none of them is telemetry.
    return {
      id,
      label,
      state: "nodata",
      value: "SIM OFF",
      detail: "The simulator is not running: no telemetry.",
      source: null,
    };
  }
  if (state.lastFrameAt === null || now === null) {
    return noData(id, label, "No telemetry frame received yet.");
  }
  if (isStale(state, now)) {
    return {
      id,
      label,
      state: "nogo",
      value: "STALE",
      detail: "No new frame for more than 5 seconds.",
      source: state.source,
    };
  }
  return {
    id,
    label,
    state: "go",
    value: "FRESH",
    detail: "Frames are arriving.",
    source: state.source,
  };
}

function brakeLamp(state: ClientSimState, up: boolean): Lamp {
  const controls = up ? state.sim.controls : null;
  if (!controls) return noData("brake", "PARK BRK", "Parking brake not reported.");
  return controls.parkingBrake
    ? {
        id: "brake",
        label: "PARK BRK",
        state: "go",
        value: "SET",
        detail: "Parking brake set.",
        source: state.source,
      }
    : {
        id: "brake",
        label: "PARK BRK",
        state: "info",
        value: "OFF",
        detail: "Parking brake released.",
        source: state.source,
      };
}

function groundLamp(state: ClientSimState, up: boolean): Lamp {
  const motion = up ? state.sim.motion : null;
  if (!motion) return noData("ground", "ON GND", "On-ground flag not reported.");
  return {
    id: "ground",
    label: "ON GND",
    state: "info",
    value: motion.onGround ? "ON GND" : "AIRBORNE",
    detail: motion.onGround ? "The simulator reports the aircraft on the ground." : "Airborne.",
    source: state.source,
  };
}

function payloadLamp(state: ClientSimState, up: boolean, simUp: boolean): Lamp {
  const id = "payload";
  const label = "PAYLOAD";
  const check = up ? state.sim.mission?.payloadCheck : undefined;
  if (!check) return noData(id, label, "No loaded mission with a payload check.");
  // A preview compares with what the sim reports now; a departure check is frozen and stays.
  if (check.stage === "preview" && !simUp) {
    return noData(id, label, "The simulator is not running: no payload preview.");
  }
  const base = { id, label, detail: check.message, source: check.source };
  switch (check.status) {
    case "ok":
      return { ...base, state: "go", value: "OK" };
    case "underloaded":
      return { ...base, state: "nogo", value: "UNDER" };
    case "overloaded":
      // Over max gross only by the payload you entered: a caution, the start is not blocked.
      return check.overBasis === "entered"
        ? { ...base, state: "hold", value: "OVER (YOURS)" }
        : { ...base, state: "nogo", value: "OVER MTOW" };
    case "unknown":
      return { ...base, state: "nodata", value: "UNKNOWN", source: null };
  }
}

/** The fleet aircraft missions are flown with, or null when none is selected. */
export function selectedAircraft(fleet: FleetState | null): FleetAircraft | null {
  if (!fleet?.selectedId) return null;
  return fleet.aircraft.find((a) => a.id === fleet.selectedId) ?? null;
}

const GATE_VALUE = { grounded: "GROUNDED", ferry_only: "FERRY ONLY", annual_due: "ANNUAL DUE" };

function airworthyLamp(fleet: FleetState | null, source: Source | null): Lamp {
  const id = "airworthy";
  const label = "AIRWORTHY";
  const aircraft = selectedAircraft(fleet);
  if (!aircraft || !source) return noData(id, label, "No active fleet aircraft.");
  const gate = aircraft.airworthiness?.status;
  if (aircraft.airworthy && (!gate || gate === "airworthy")) {
    return {
      id,
      label,
      state: "go",
      value: "GO",
      detail: `${aircraft.registration} is airworthy (${aircraft.condition.toFixed(1)} %).`,
      source,
    };
  }
  const value = gate && gate !== "airworthy" ? GATE_VALUE[gate] : "GROUNDED";
  return {
    id,
    label,
    state: gate === "ferry_only" || gate === "annual_due" ? "hold" : "nogo",
    value,
    detail: `${aircraft.registration}: ${value.toLowerCase()}.`,
    source,
  };
}

const WX_STATE: Record<FlightCategory, LampState> = {
  VFR: "go",
  MVFR: "hold",
  IFR: "nogo",
  LIFR: "nogo",
};

function weatherLamp(wx: WeatherLampInput): Lamp {
  const id = "wx";
  const label = "WX DEST";
  if (!wx.station) return noData(id, label, "No destination.");
  if (!wx.category) return noData(id, label, `No flight category for ${wx.station}.`);
  return {
    id,
    label,
    state: WX_STATE[wx.category],
    value: wx.category,
    detail: `${wx.station} ${wx.category}${wx.sample ? " (SAMPLE report, not real weather)" : ""}.`,
    source: wx.source,
    sample: wx.sample,
  };
}

function fuelLamp(state: ClientSimState, up: boolean): Lamp {
  const id = "fuel";
  const label = "FUEL";
  if (!up) return noData(id, label, "No fuel data.");
  const endurance = fuelEnduranceMin(state.sim.fuel);
  const ete = destinationEteMin(state);
  const status = enduranceStatus(endurance, ete);
  if (status === null) {
    return noData(id, label, "Needs fuel flow and an ETE to the destination.");
  }
  return {
    id,
    label,
    state: status === "ok" ? "go" : "nogo",
    value: status === "ok" ? "GO" : "LOW",
    detail:
      status === "ok"
        ? "Endurance covers the ETE plus a 45 min reserve."
        : "Endurance is below the ETE plus a 45 min reserve.",
    source: state.source,
  };
}

function rateLamp(state: ClientSimState, up: boolean): Lamp {
  const rate = up ? state.sim.sim?.simRate : undefined;
  if (rate === undefined || !Number.isFinite(rate)) {
    return noData("rate", "SIM RATE", "Simulation rate not reported.");
  }
  const text = `×${Number.isInteger(rate) ? rate : Number(rate.toFixed(2))}`;
  return {
    id: "rate",
    label: "SIM RATE",
    state: rate === 1 ? "go" : rate > 4 ? "nogo" : "hold",
    value: text,
    detail:
      rate === 1
        ? "Real time."
        : rate > 4
          ? "Above 4×: the flight does not count for missions."
          : "Above 1×: no bonuses.",
    source: state.source,
  };
}

function weightLamp(state: ClientSimState, up: boolean): Lamp {
  const w = up ? weightsView(state.sim.weights) : null;
  if (!w || w.maxGrossLb <= 0) return noData("weight", "GROSS WT", "Weights not reported.");
  return {
    id: "weight",
    label: "GROSS WT",
    state: w.overweight ? "nogo" : "go",
    value: w.overweight ? "OVER" : "GO",
    detail: `${formatInt(w.totalLb)} of ${formatInt(w.maxGrossLb)} lb max gross.`,
    source: state.source,
  };
}

/** Every lamp of the status board, in board order. */
export function goNoGoLamps(input: GoNoGoInput): Lamp[] {
  const { state, now } = input;
  const up = isSessionUp(state);
  // Telemetry lamps need the simulator itself, not just the connector session.
  const simUp = up && !isSimOfflineSession(state);
  return [
    linkLamp(state),
    freshLamp(state, now),
    brakeLamp(state, simUp),
    groundLamp(state, simUp),
    payloadLamp(state, up, simUp),
    airworthyLamp(input.fleet, input.fleetSource),
    weatherLamp(input.weather),
    fuelLamp(state, simUp),
    rateLamp(state, simUp),
    weightLamp(state, simUp),
  ];
}

export interface BoardSummary {
  go: number;
  hold: number;
  nogo: number;
  info: number;
  nodata: number;
}

export function boardSummary(lamps: readonly Lamp[]): BoardSummary {
  const out: BoardSummary = { go: 0, hold: 0, nogo: 0, info: 0, nodata: 0 };
  for (const l of lamps) out[l.state] += 1;
  return out;
}

/**
 * Seconds on the mission clock (block-out based flight clock of the tracked flight),
 * or null without one. Never derived from the wall clock.
 */
export function missionElapsedSec(state: ClientSimState): number | null {
  if (!isSessionUp(state)) return null;
  const flight = state.sim.flight;
  if (!flight) return null;
  if (typeof flight.elapsedSec === "number" && Number.isFinite(flight.elapsedSec)) {
    return flight.elapsedSec;
  }
  if (typeof flight.blockMin === "number" && Number.isFinite(flight.blockMin)) {
    return flight.blockMin * 60;
  }
  return null;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** "T+01:02:03"; "T+--:--:--" when unknown. */
export function formatMet(seconds: number | null): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds < 0) return "T+--:--:--";
  const s = Math.floor(seconds);
  return `T+${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
}

/** "14:03:22Z" from a client clock in ms; "--:--:--Z" before the clock starts. */
export function formatUtc(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "--:--:--Z";
  const d = new Date(ms);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}Z`;
}

/** UTC day of year "DDD" (control-room date style), or null before the clock starts. */
export function utcDayOfYear(ms: number | null): string | null {
  if (ms === null || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  const day = Math.floor((ms - start) / 86_400_000) + 1;
  return String(day).padStart(3, "0");
}

// ---- event loop ----

export type LoopTone = "go" | "hold" | "nogo" | "info";

export interface LoopLine {
  key: string;
  seq: number;
  /** Client clock when received, ms. */
  at: number;
  source: Source;
  name: string;
  text: string;
  tone: LoopTone;
}

function rec(data: unknown): Record<string, unknown> {
  return typeof data === "object" && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : {};
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

const TONE: Partial<Record<string, LoopTone>> = {
  crash: "nogo",
  "mission.failed": "nogo",
  "loan.missed": "nogo",
  "aircraft.grounded": "nogo",
  "aircraft.repossessed": "nogo",
  "sim.disconnected": "hold",
  "sim.paused": "hold",
  "sim.rate": "hold",
  "defect.found": "hold",
  "demand.event": "hold",
  "insurance.claim": "hold",
  "pilot.route_stopped": "hold",
  "sim.connected": "go",
  touchdown: "go",
  "flight.started": "go",
  "mission.started": "go",
  "mission.delivered": "go",
  "milestone.reached": "go",
  "job.completed": "go",
};

function route(d: Record<string, unknown>): string | null {
  const o = str(d["origin"]);
  const t = str(d["destination"]);
  return o && t ? `${o} → ${t}` : null;
}

/** One loop line per event: a short human description from the fields actually present. */
export function describeEvent(ev: ReceivedEvent): LoopLine {
  const { msg } = ev;
  const d = rec(msg.data);
  let text: string;
  switch (msg.name) {
    case "phase.changed": {
      const from = str(d["from"]);
      const to = str(d["to"]);
      text = to ? `PHASE ${from ?? EMPTY} → ${to}` : "PHASE CHANGED";
      break;
    }
    case "flight.started":
      text = `FLIGHT STARTED${route(d) ? ` ${route(d)}` : ""}`;
      break;
    case "flight.ended": {
      const status = str(d["status"]);
      text = `FLIGHT ENDED${status ? ` (${status})` : ""}`;
      break;
    }
    case "touchdown": {
      const rate = num(d["rateFpm"]);
      const grade = str(d["grade"]);
      text = [
        "TOUCHDOWN",
        rate === null ? null : `${formatInt(rate)} fpm`,
        grade ? `grade ${grade}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      break;
    }
    case "sim.connected":
      text = "SIMULATOR CONNECTED";
      break;
    case "sim.disconnected":
      text = "SIMULATOR DISCONNECTED";
      break;
    case "sim.paused":
      // `event` says what the connector's effective pause came from (docs/SIMVARS.md).
      if (d["event"] === "SimStop" && d["paused"] !== false) text = "SIM STOPPED · MAIN MENU";
      else if (d["event"] === "stuck_pause") text = "SIM RESUMED · STUCK PAUSE IGNORED";
      else text = d["paused"] === false ? "SIM RESUMED" : "SIM PAUSED";
      break;
    case "sim.rate": {
      const rate = num(d["rate"]) ?? num(d["simRate"]);
      text = rate === null ? "SIM RATE CHANGED" : `SIM RATE ×${rate}`;
      break;
    }
    case "crash":
      text = "CRASH REPORTED BY THE SIMULATOR";
      break;
    case "pilot.route_stopped": {
      // A modelled operation, never telemetry: say so on the loop line.
      const reg = str(d["registration"]);
      text = `HIRED PILOT (SIMULATED) ROUTE STOPPED${reg ? ` · ${reg}` : ""}`;
      break;
    }
    default: {
      const label = msg.name.replace(/[._]/g, " ").toUpperCase();
      const r = route(d);
      text = r ? `${label} ${r}` : label;
    }
  }
  return {
    key: `${msg.seq}-${ev.at}`,
    seq: msg.seq,
    at: ev.at,
    source: msg.source,
    name: msg.name,
    text,
    tone: TONE[msg.name] ?? "info",
  };
}

/** Most recent events first, as loop lines. */
export function loopLines(events: readonly ReceivedEvent[], count = 50): LoopLine[] {
  return events.slice(-count).reverse().map(describeEvent);
}
