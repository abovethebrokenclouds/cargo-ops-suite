// TEST-ONLY SimConnect protocol emulator.
//
// A small TCP server that speaks enough of the SimConnect binary wire protocol for the
// connector's client (node-simconnect 4.2.1 over IPv4) to open a session, define data,
// request it, subscribe to system events, receive scripted frames and answer per-ICAO
// airport facility requests (members of the airport and runway blocks). It exists so the
// SimConnect code path can be exercised in CI without Microsoft Flight Simulator.
//
// It is NOT MSFS. It never computes physics, never converts units (scenario values are
// returned as-is, in whatever unit the client asked for) and only knows the packet types
// listed below. Behaviour that the public SDK documentation leaves open is marked
// ASSUMPTION and is configurable; passing tests here prove the connector's handling of the
// wire format, not what a real simulator sends. Evidence from it is labelled "Emulated" in
// docs/VERIFICATION.md and never counts as a PC check.
//
// Written from the public MSFS SDK SimConnect documentation (packet structures
// SIMCONNECT_RECV_*, data types, exceptions) and by reading how node-simconnect lays out
// the bytes, for interoperability. No node-simconnect source is copied here.
//
// Wire format (little endian):
//   client → server: u32 size | u32 protocol | u32 0xF0000000 | function id | u32 sendId | body
//   server → client: u32 size | u32 protocol | u32 RECV id | body

import { EventEmitter } from "node:events";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";

// ---- protocol constants (MSFS SDK) ----

/** Client function ids (low bits of the packet type). */
export const FN = {
  OPEN: 0x01,
  ADD_TO_DATA_DEFINITION: 0x0c,
  CLEAR_DATA_DEFINITION: 0x0d,
  REQUEST_DATA_ON_SIM_OBJECT: 0x0e,
  REQUEST_DATA_ON_SIM_OBJECT_TYPE: 0x0f,
  SUBSCRIBE_TO_SYSTEM_EVENT: 0x17,
  UNSUBSCRIBE_FROM_SYSTEM_EVENT: 0x18,
  REQUEST_SYSTEM_STATE: 0x35,
  ADD_TO_FACILITY_DEFINITION: 0x45,
  REQUEST_FACILITY_DATA: 0x46,
  REQUEST_FACILITY_DATA_EX1: 0x4a,
} as const;

/** Server RECV ids. */
export const RECV = {
  EXCEPTION: 1,
  OPEN: 2,
  QUIT: 3,
  EVENT: 4,
  EVENT_FILENAME: 6,
  SIMOBJECT_DATA: 8,
  SIMOBJECT_DATA_BYTYPE: 9,
  SYSTEM_STATE: 15,
  EVENT_EX1: 27,
  FACILITY_DATA: 28,
  FACILITY_DATA_END: 29,
} as const;

/** SIMCONNECT_EXCEPTION values used here. */
export const EXCEPTION = {
  ERROR: 1,
  UNRECOGNIZED_ID: 3,
  VERSION_MISMATCH: 5,
  NAME_UNRECOGNIZED: 7,
  INVALID_DATA_TYPE: 18,
  OUT_OF_BOUNDS: 31,
} as const;

/** SIMCONNECT_DATATYPE. */
export const DATATYPE = {
  INT32: 1,
  INT64: 2,
  FLOAT32: 3,
  FLOAT64: 4,
  STRING8: 5,
  STRING32: 6,
  STRING64: 7,
  STRING128: 8,
  STRING256: 9,
  STRING260: 10,
  STRINGV: 11,
} as const;

const FIXED_STRING_WIDTH: Record<number, number> = {
  [DATATYPE.STRING8]: 8,
  [DATATYPE.STRING32]: 32,
  [DATATYPE.STRING64]: 64,
  [DATATYPE.STRING128]: 128,
  [DATATYPE.STRING256]: 256,
  [DATATYPE.STRING260]: 260,
};

/** SIMCONNECT_PERIOD. */
const PERIOD = { NEVER: 0, ONCE: 1, VISUAL_FRAME: 2, SIM_FRAME: 3, SECOND: 4 } as const;
/** SIMCONNECT_DATA_REQUEST_FLAG_CHANGED. */
const FLAG_CHANGED = 1;
/** SIMCONNECT_SIMOBJECT_TYPE. */
const OBJECT_TYPE = { USER: 0, ALL: 1, AIRCRAFT: 2 } as const;
const OBJECT_ID_USER = 0;
const UNKNOWN_GROUP = 0xffffffff;
const MAX_PATH = 260;
const MAX_TYPE_RADIUS_M = 200_000;
const CLIENT_HEADER = 16;
const SERVER_HEADER = 12;

/** System events this emulator accepts a subscription for (SDK list, case-insensitive). */
const KNOWN_SYSTEM_EVENTS = [
  "1sec",
  "4sec",
  "6Hz",
  "AircraftLoaded",
  "Crashed",
  "CrashReset",
  "FlightLoaded",
  "FlightSaved",
  "FlightPlanActivated",
  "FlightPlanDeactivated",
  "Frame",
  "Pause",
  "Pause_EX1",
  "Paused",
  "PauseFrame",
  "PositionChanged",
  "Sim",
  "SimStart",
  "SimStop",
  "Sound",
  "Unpaused",
  "View",
];
/** Events delivered as SIMCONNECT_RECV_EVENT_FILENAME. */
const FILENAME_EVENTS = new Set([
  "aircraftloaded",
  "flightloaded",
  "flightsaved",
  "flightplanactivated",
]);

// ---- facilities ----

/** SIMCONNECT_FACILITY_DATA_TYPE values the emulator sends. */
export const FACILITY_DATA_TYPE = { AIRPORT: 0, RUNWAY: 1 } as const;

type FacilityScope = "airport" | "runway";

/**
 * Members the emulator knows, per block, with the data type the SDK documents for each
 * (SimConnect_AddToFacilityDefinition, airport and runway pages; units: degrees, metres,
 * enums). Values are sent in the order the client added them, packed without padding.
 * Only a subset of the SDK lists; any other name is refused like an unknown one.
 */
const FACILITY_MEMBERS: Record<FacilityScope, Record<string, number>> = {
  airport: {
    LATITUDE: DATATYPE.FLOAT64,
    LONGITUDE: DATATYPE.FLOAT64,
    ALTITUDE: DATATYPE.FLOAT64,
    MAGVAR: DATATYPE.FLOAT32,
    NAME: DATATYPE.STRING32,
    NAME64: DATATYPE.STRING64,
    ICAO: DATATYPE.STRING8,
    REGION: DATATYPE.STRING8,
    N_RUNWAYS: DATATYPE.INT32,
  },
  runway: {
    LATITUDE: DATATYPE.FLOAT64,
    LONGITUDE: DATATYPE.FLOAT64,
    ALTITUDE: DATATYPE.FLOAT64,
    HEADING: DATATYPE.FLOAT32,
    LENGTH: DATATYPE.FLOAT32,
    WIDTH: DATATYPE.FLOAT32,
    PATTERN_ALTITUDE: DATATYPE.FLOAT32,
    SLOPE: DATATYPE.FLOAT32,
    TRUE_SLOPE: DATATYPE.FLOAT32,
    SURFACE: DATATYPE.INT32,
    PRIMARY_NUMBER: DATATYPE.INT32,
    PRIMARY_DESIGNATOR: DATATYPE.INT32,
    SECONDARY_NUMBER: DATATYPE.INT32,
    SECONDARY_DESIGNATOR: DATATYPE.INT32,
  },
};

/** One airport in the emulated facility database (member values in SDK units). */
export interface EmulatedAirport {
  /** Airport members, e.g. { LATITUDE: 35.04, ALTITUDE: 104 (metres), NAME64: "..." }. */
  values: Record<string, SimValue>;
  /** Runway members per runway, e.g. { LENGTH: 3389 (metres), SURFACE: 4 }. */
  runways?: Array<Record<string, SimValue>>;
}

interface FacilityMember {
  scope: FacilityScope;
  name: string;
  type: number;
}

// ---- profiles ----

export type SimProfile = "msfs2024" | "msfs2020";

interface ProfileInfo {
  applicationName: string;
  /** Highest client protocol the simulator accepts (SunRise = 6, KittyHawk = 5). */
  maxProtocol: number;
  appVersion: [number, number, number, number];
  simConnectVersion: [number, number, number, number];
}

/**
 * applicationName values are the ones the connector keys on ("SunRise" = MSFS 2024,
 * "KittyHawk" = MSFS 2020). The version numbers are REPRESENTATIVE, not captured from a
 * real simulator.
 */
export const PROFILES: Record<SimProfile, ProfileInfo> = {
  msfs2024: {
    applicationName: "SunRise",
    maxProtocol: 6,
    appVersion: [12, 1, 282174, 999],
    simConnectVersion: [12, 1, 0, 0],
  },
  msfs2020: {
    applicationName: "KittyHawk",
    maxProtocol: 5,
    appVersion: [11, 0, 282174, 999],
    simConnectVersion: [11, 0, 62651, 3],
  },
};

// ---- public types ----

export type SimValue = number | string;

export interface RejectRule {
  /** SimVar name; without an index it matches every index ("NAME" matches "NAME:2"). */
  name: string;
  /** Exception sent for it (default NAME_UNRECOGNIZED). */
  exception?: number;
}

export interface AiObject {
  objectId: number;
  /** SimVar values for this object (same lookup rules as the user aircraft). */
  values: Record<string, SimValue>;
  /** SIMCONNECT_SIMOBJECT_TYPE (default AIRCRAFT). */
  type?: number;
}

export interface EmulatorOptions {
  profile?: SimProfile;
  /** Override the profile's applicationName (e.g. an unknown build name). */
  applicationName?: string;
  /**
   * ASSUMPTION (the SDK does not document it): what a simulator does when a client opens
   * with a newer protocol than it supports. Default: send VERSION_MISMATCH, then close.
   */
  unsupportedProtocol?: "exception-close" | "close";
  /** SimVars the "simulator" does not know. */
  reject?: Array<string | RejectRule>;
  /** User aircraft SimVar values, keyed by name ("NAME" or "NAME:i"). Missing → 0 / "". */
  values?: Record<string, SimValue>;
  /** Interval of SIM_FRAME / VISUAL_FRAME requests, ms (default 50). */
  simFrameMs?: number;
  /** Interval of SECOND requests, ms (default 1000; tests shorten it). */
  secondMs?: number;
  /** Object id of the user aircraft in frames (default 1). */
  userObjectId?: number;
  aiObjects?: AiObject[];
  /** ASSUMPTION: AIRCRAFT/ALL by-type requests include the user aircraft (default true). */
  includeUserInTypeRequests?: boolean;
  /** entryNumber of the first by-type entry (SDK: 1; 0 tests the other numbering). */
  byTypeFirstEntry?: 0 | 1;
  /** ASSUMPTION: an empty by-type result is one packet with entryNumber 0 / outOf 0 (default true). */
  emptyByTypeReply?: boolean;
  /** Initial "Sim" system state (default 1 = running). */
  simRunning?: boolean;
  aircraftPath?: string;
  flightPath?: string;
  /** Airport facility database keyed by ICAO (upper case). */
  facilities?: Record<string, EmulatedAirport>;
  /** Facility member names the "simulator" refuses (exception against that call). */
  facilityReject?: string[];
  /**
   * ASSUMPTION (not documented): how an unknown ICAO is answered. "end" (default): only
   * FACILITY_DATA_END; "exception": an exception against the request and nothing else.
   */
  facilityMiss?: "end" | "exception";
  /** ICAOs that are never answered (the client's timeout path). */
  facilitySilent?: string[];
}

/** One decoded client packet (recorded for assertions). */
export interface ClientPacket {
  connection: number;
  fn: number;
  protocol: number;
  sendId: number;
  fields: Record<string, number | string>;
}

interface Datum {
  name: string;
  unit: string;
  type: number;
}

interface ActiveRequest {
  requestId: number;
  defineId: number;
  objectId: number;
  period: number;
  flags: number;
  timer: NodeJS.Timeout | null;
  last: Buffer | null;
}

// ---- encoding helpers ----

function fixedString(value: string, width: number): Buffer {
  const out = Buffer.alloc(width);
  // Leave room for the terminating NUL, as the C structures do.
  Buffer.from(value, "latin1").copy(out, 0, 0, width - 1);
  return out;
}

function readFixedString(buf: Buffer, offset: number, width: number): string {
  const slice = buf.subarray(offset, offset + width);
  const nul = slice.indexOf(0);
  return (nul >= 0 ? slice.subarray(0, nul) : slice).toString("latin1");
}

function u32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(value >>> 0, 0);
  return b;
}

/** Encode one datum value the way SimConnect lays it out in SIMCONNECT_RECV_SIMOBJECT_DATA. */
export function encodeDatum(type: number, value: SimValue | undefined): Buffer {
  const num = typeof value === "number" ? value : Number(value ?? 0) || 0;
  const str = value === undefined ? "" : String(value);
  switch (type) {
    case DATATYPE.INT32: {
      const b = Buffer.alloc(4);
      b.writeInt32LE(Math.trunc(num) | 0, 0);
      return b;
    }
    case DATATYPE.INT64: {
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(Math.trunc(num)), 0);
      return b;
    }
    case DATATYPE.FLOAT32: {
      const b = Buffer.alloc(4);
      b.writeFloatLE(num, 0);
      return b;
    }
    case DATATYPE.FLOAT64: {
      const b = Buffer.alloc(8);
      b.writeDoubleLE(num, 0);
      return b;
    }
    case DATATYPE.STRINGV:
      return Buffer.concat([Buffer.from(str, "latin1"), Buffer.alloc(1)]);
    default: {
      const width = FIXED_STRING_WIDTH[type];
      if (!width) throw new Error(`unsupported data type ${type}`);
      return fixedString(str, width);
    }
  }
}

function lookup(values: Record<string, SimValue>, name: string): SimValue | undefined {
  const upper = name.toUpperCase();
  if (upper in values) return values[upper];
  const colon = upper.lastIndexOf(":");
  if (colon > 0) {
    const base = upper.slice(0, colon);
    if (base in values) return values[base];
  }
  return undefined;
}

function upperKeys(values: Record<string, SimValue>): Record<string, SimValue> {
  const out: Record<string, SimValue> = {};
  for (const [k, v] of Object.entries(values)) out[k.toUpperCase()] = v;
  return out;
}

function distanceM(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6_371_008.8 * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ---- one client connection ----

class EmulatedConnection {
  protocol = 0;
  opened = false;
  appName = "";
  private buffer = Buffer.alloc(0);
  readonly defs = new Map<number, Datum[]>();
  readonly requests = new Map<number, ActiveRequest>();
  /** Lower-case system event name → client event id. */
  readonly subscriptions = new Map<string, number>();
  /** Facility definitions: accepted members in order, plus the open-block stack. */
  readonly facilityDefs = new Map<number, { members: FacilityMember[]; open: FacilityScope[] }>();
  private nextUniqueRequest = 1;
  closed = false;

  constructor(
    readonly id: number,
    readonly socket: Socket,
    private readonly emu: SimConnectEmulator,
  ) {
    socket.on("data", (chunk) => this.onChunk(chunk));
    socket.on("close", () => this.dispose());
    socket.on("error", () => this.dispose());
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.requests.values()) if (r.timer) clearInterval(r.timer);
    this.requests.clear();
    this.emu.forget(this);
  }

  send(recvId: number, body: Buffer): void {
    if (this.closed || this.socket.destroyed) return;
    const header = Buffer.alloc(SERVER_HEADER);
    header.writeUInt32LE(SERVER_HEADER + body.length, 0);
    header.writeUInt32LE(this.protocol || this.emu.profile.maxProtocol, 4);
    header.writeUInt32LE(recvId, 8);
    this.socket.write(Buffer.concat([header, body]));
  }

  sendException(exception: number, sendId: number, index: number): void {
    this.send(RECV.EXCEPTION, Buffer.concat([u32(exception), u32(sendId), u32(index)]));
  }

  private onChunk(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 4) {
      const size = this.buffer.readUInt32LE(0);
      if (size < CLIENT_HEADER || size > 1 << 20) {
        this.emu.protocolErrors.push(`connection ${this.id}: bad packet size ${size}`);
        this.socket.destroy();
        return;
      }
      if (this.buffer.length < size) return;
      const packet = this.buffer.subarray(0, size);
      this.buffer = this.buffer.subarray(size);
      this.onPacket(packet);
    }
  }

  private onPacket(p: Buffer): void {
    const protocol = p.readUInt32LE(4);
    const rawType = p.readUInt32LE(8);
    const sendId = p.readUInt32LE(12);
    if ((rawType & 0xf0000000) >>> 0 !== 0xf0000000) {
      this.emu.protocolErrors.push(`connection ${this.id}: packet type 0x${rawType.toString(16)}`);
      this.socket.destroy();
      return;
    }
    const fn = rawType & 0x0fffffff;
    const body = p.subarray(CLIENT_HEADER);
    const record = (fields: Record<string, number | string>) =>
      this.emu.recordPacket({ connection: this.id, fn, protocol, sendId, fields });

    if (fn === FN.OPEN) {
      // char[256] app name, u32 0, u8 0, char[3] alias, u32 version ×4
      const appName = readFixedString(body, 0, 256);
      const alias = readFixedString(body, 261, 3);
      record({
        appName,
        alias,
        major: body.readUInt32LE(264),
        minor: body.readUInt32LE(268),
        buildMajor: body.readUInt32LE(272),
        buildMinor: body.readUInt32LE(276),
      });
      this.onOpen(protocol, appName, sendId);
      return;
    }
    if (!this.opened) {
      record({});
      return; // Nothing is served before a successful open.
    }
    switch (fn) {
      case FN.ADD_TO_DATA_DEFINITION: {
        const defineId = body.readUInt32LE(0);
        const name = readFixedString(body, 4, 256);
        const unit = readFixedString(body, 260, 256);
        const type = body.readUInt32LE(516);
        record({ defineId, name, unit, type });
        const rule = this.emu.rejectRule(name);
        if (rule) {
          // SDK dwIndex: 1-based index of the offending parameter (DatumName is 3rd,
          // counting hSimConnect). The datum is not added to the definition.
          this.sendException(rule.exception ?? EXCEPTION.NAME_UNRECOGNIZED, sendId, 3);
          return;
        }
        if (
          type !== DATATYPE.FLOAT32 &&
          type !== DATATYPE.FLOAT64 &&
          type !== DATATYPE.INT32 &&
          type !== DATATYPE.INT64 &&
          type !== DATATYPE.STRINGV &&
          !FIXED_STRING_WIDTH[type]
        ) {
          this.sendException(EXCEPTION.INVALID_DATA_TYPE, sendId, 5);
          return;
        }
        const list = this.defs.get(defineId) ?? [];
        list.push({ name, unit, type });
        this.defs.set(defineId, list);
        return;
      }
      case FN.CLEAR_DATA_DEFINITION: {
        const defineId = body.readUInt32LE(0);
        record({ defineId });
        this.defs.delete(defineId);
        for (const r of [...this.requests.values()]) {
          if (r.defineId === defineId) this.stopRequest(r.requestId);
        }
        return;
      }
      case FN.REQUEST_DATA_ON_SIM_OBJECT: {
        const requestId = body.readUInt32LE(0);
        const defineId = body.readUInt32LE(4);
        const objectId = body.readUInt32LE(8);
        const period = body.readUInt32LE(12);
        const flags = body.readUInt32LE(16);
        record({ requestId, defineId, objectId, period, flags });
        this.stopRequest(requestId);
        if (period === PERIOD.NEVER) return;
        if (!this.defs.has(defineId)) {
          this.sendException(EXCEPTION.UNRECOGNIZED_ID, sendId, 3);
          return;
        }
        this.startRequest({
          requestId,
          defineId,
          objectId,
          period,
          flags,
          timer: null,
          last: null,
        });
        return;
      }
      case FN.REQUEST_DATA_ON_SIM_OBJECT_TYPE: {
        const requestId = body.readUInt32LE(0);
        const defineId = body.readUInt32LE(4);
        const radius = body.readUInt32LE(8);
        const type = body.readUInt32LE(12);
        record({ requestId, defineId, radius, type });
        if (!this.defs.has(defineId)) {
          this.sendException(EXCEPTION.UNRECOGNIZED_ID, sendId, 3);
          return;
        }
        if (radius > MAX_TYPE_RADIUS_M) {
          this.sendException(EXCEPTION.OUT_OF_BOUNDS, sendId, 4);
          return;
        }
        setImmediate(() => this.replyByType(requestId, defineId, radius, type));
        return;
      }
      case FN.SUBSCRIBE_TO_SYSTEM_EVENT: {
        const clientEventId = body.readUInt32LE(0);
        const name = readFixedString(body, 4, 256);
        record({ clientEventId, name });
        if (!KNOWN_SYSTEM_EVENTS.some((e) => e.toLowerCase() === name.toLowerCase())) {
          this.sendException(EXCEPTION.NAME_UNRECOGNIZED, sendId, 3);
          return;
        }
        this.subscriptions.set(name.toLowerCase(), clientEventId);
        return;
      }
      case FN.UNSUBSCRIBE_FROM_SYSTEM_EVENT: {
        const clientEventId = body.readUInt32LE(0);
        record({ clientEventId });
        for (const [name, id] of this.subscriptions) {
          if (id === clientEventId) this.subscriptions.delete(name);
        }
        return;
      }
      case FN.REQUEST_SYSTEM_STATE: {
        const requestId = body.readUInt32LE(0);
        const state = readFixedString(body, 4, 256);
        record({ requestId, state });
        this.replySystemState(requestId, state, sendId);
        return;
      }
      case FN.ADD_TO_FACILITY_DEFINITION: {
        const defineId = body.readUInt32LE(0);
        const name = readFixedString(body, 4, 256);
        record({ defineId, name });
        this.addFacilityMember(defineId, name, sendId);
        return;
      }
      case FN.REQUEST_FACILITY_DATA:
      case FN.REQUEST_FACILITY_DATA_EX1: {
        const defineId = body.readUInt32LE(0);
        const requestId = body.readUInt32LE(4);
        const icao = readFixedString(body, 8, 16);
        const region = readFixedString(body, 24, 4);
        record({ defineId, requestId, icao, region });
        if (!this.facilityDefs.has(defineId)) {
          this.sendException(EXCEPTION.UNRECOGNIZED_ID, sendId, 2);
          return;
        }
        setImmediate(() => this.replyFacility(defineId, requestId, icao, sendId));
        return;
      }
      default:
        record({});
        this.emu.unhandled.push(fn);
    }
  }

  private addFacilityMember(defineId: number, raw: string, sendId: number): void {
    const def = this.facilityDefs.get(defineId) ?? { members: [], open: [] };
    this.facilityDefs.set(defineId, def);
    const name = raw.trim().toUpperCase();
    const refuse = () => this.sendException(EXCEPTION.ERROR, sendId, 3);
    if (this.emu.options.facilityReject?.some((r) => r.toUpperCase() === name)) return refuse();
    const marker = /^(OPEN|CLOSE) (AIRPORT|RUNWAY)$/.exec(name);
    if (marker) {
      const scope = marker[2] === "AIRPORT" ? "airport" : "runway";
      const top = def.open[def.open.length - 1];
      if (marker[1] === "OPEN") {
        // A runway block only inside an airport block; an airport block only at the top.
        if (scope === "runway" ? top !== "airport" : top !== undefined) return refuse();
        def.open.push(scope);
      } else {
        if (top !== scope) return refuse();
        def.open.pop();
      }
      return;
    }
    const scope = def.open[def.open.length - 1];
    const type = scope ? FACILITY_MEMBERS[scope][name] : undefined;
    if (!scope || type === undefined) return refuse();
    def.members.push({ scope, name, type });
  }

  private facilityRecord(
    scope: FacilityScope,
    members: FacilityMember[],
    values: Record<string, SimValue>,
  ): Buffer {
    const upper = upperKeys(values);
    return Buffer.concat(
      members.filter((m) => m.scope === scope).map((m) => encodeDatum(m.type, upper[m.name])),
    );
  }

  private replyFacility(defineId: number, requestId: number, rawIcao: string, sendId: number) {
    const def = this.facilityDefs.get(defineId);
    if (!def || this.closed) return;
    const icao = rawIcao.trim().toUpperCase();
    const emu = this.emu;
    if (emu.options.facilitySilent?.some((s) => s.toUpperCase() === icao)) return;
    const airport = emu.facilities[icao];
    if (!airport) {
      if (emu.options.facilityMiss === "exception") {
        this.sendException(EXCEPTION.ERROR, sendId, 3);
      } else {
        this.send(RECV.FACILITY_DATA_END, u32(requestId));
      }
      return;
    }
    const header = (
      unique: number,
      parent: number,
      type: number,
      listItem: boolean,
      index: number,
      size: number,
    ) =>
      Buffer.concat([
        u32(requestId),
        u32(unique),
        u32(parent),
        u32(type),
        u32(listItem ? 1 : 0),
        u32(index),
        u32(size),
      ]);
    const airportUnique = this.nextUniqueRequest++;
    if (def.members.some((m) => m.scope === "airport") || def.members.length === 0) {
      this.send(
        RECV.FACILITY_DATA,
        Buffer.concat([
          header(airportUnique, 0, FACILITY_DATA_TYPE.AIRPORT, false, 0, 1),
          this.facilityRecord("airport", def.members, airport.values),
        ]),
      );
    }
    if (def.members.some((m) => m.scope === "runway")) {
      const runways = airport.runways ?? [];
      runways.forEach((r, i) => {
        this.send(
          RECV.FACILITY_DATA,
          Buffer.concat([
            header(
              this.nextUniqueRequest++,
              airportUnique,
              FACILITY_DATA_TYPE.RUNWAY,
              true,
              i,
              runways.length,
            ),
            this.facilityRecord("runway", def.members, r),
          ]),
        );
      });
    }
    this.send(RECV.FACILITY_DATA_END, u32(requestId));
    emu.facilityRepliesSent++;
  }

  private onOpen(protocol: number, appName: string, sendId: number): void {
    const profile = this.emu.profile;
    if (protocol > profile.maxProtocol) {
      if (this.emu.options.unsupportedProtocol !== "close") {
        this.protocol = protocol;
        this.sendException(EXCEPTION.VERSION_MISMATCH, sendId, 0);
      }
      this.socket.end();
      setTimeout(() => this.socket.destroy(), 20).unref();
      return;
    }
    this.protocol = protocol;
    this.appName = appName;
    this.opened = true;
    const body = Buffer.concat([
      fixedString(this.emu.applicationName, 256),
      ...profile.appVersion.map(u32),
      ...profile.simConnectVersion.map(u32),
      u32(0),
      u32(0),
    ]);
    this.send(RECV.OPEN, body);
    this.emu.emit("open", this);
  }

  private startRequest(r: ActiveRequest): void {
    this.requests.set(r.requestId, r);
    setImmediate(() => this.sendFrame(r));
    if (r.period === PERIOD.ONCE) return;
    const every = r.period === PERIOD.SECOND ? this.emu.secondMs : this.emu.simFrameMs;
    r.timer = setInterval(() => this.sendFrame(r), every);
    r.timer.unref();
  }

  stopRequest(requestId: number): void {
    const r = this.requests.get(requestId);
    if (!r) return;
    if (r.timer) clearInterval(r.timer);
    this.requests.delete(requestId);
  }

  /** Send the current frame of a request (ONCE requests end after their first frame). */
  sendFrame(r: ActiveRequest): void {
    if (this.closed || this.requests.get(r.requestId) !== r) return;
    // ASSUMPTION (not documented): back in the main menu the user aircraft is gone, so
    // periodic requests deliver nothing until the next SimStart (see simStop()).
    if (this.emu.framesHalted && r.period !== PERIOD.ONCE) return;
    const datums = this.defs.get(r.defineId);
    if (!datums) return;
    const objectId = r.objectId === OBJECT_ID_USER ? this.emu.userObjectId : r.objectId;
    const values =
      objectId === this.emu.userObjectId
        ? this.emu.values
        : (this.emu.aiObjects.find((o) => o.objectId === objectId)?.values ?? {});
    const data = Buffer.concat(datums.map((d) => encodeDatum(d.type, lookup(values, d.name))));
    if (r.flags & FLAG_CHANGED && r.last && r.last.equals(data)) return;
    r.last = data;
    if (r.period === PERIOD.ONCE) this.requests.delete(r.requestId);
    this.send(
      RECV.SIMOBJECT_DATA,
      Buffer.concat([
        u32(r.requestId),
        u32(objectId),
        u32(r.defineId),
        u32(r.flags),
        u32(1),
        u32(1),
        u32(datums.length),
        data,
      ]),
    );
    this.emu.framesSent++;
  }

  private replyByType(requestId: number, defineId: number, radius: number, type: number): void {
    const datums = this.defs.get(defineId);
    if (!datums || this.closed) return;
    const emu = this.emu;
    const userPos = {
      lat: Number(lookup(emu.values, "PLANE LATITUDE") ?? 0),
      lon: Number(lookup(emu.values, "PLANE LONGITUDE") ?? 0),
    };
    const objects: Array<{ objectId: number; values: Record<string, SimValue> }> = [];
    const wantsAircraft = type === OBJECT_TYPE.AIRCRAFT || type === OBJECT_TYPE.ALL;
    if (
      type === OBJECT_TYPE.USER ||
      (wantsAircraft && emu.options.includeUserInTypeRequests !== false)
    ) {
      objects.push({ objectId: emu.userObjectId, values: emu.values });
    }
    if (type !== OBJECT_TYPE.USER) {
      for (const o of emu.aiObjects) {
        const oType = o.type ?? OBJECT_TYPE.AIRCRAFT;
        if (type !== OBJECT_TYPE.ALL && oType !== type) continue;
        const pos = {
          lat: Number(lookup(o.values, "PLANE LATITUDE") ?? 0),
          lon: Number(lookup(o.values, "PLANE LONGITUDE") ?? 0),
        };
        if (distanceM(userPos, pos) <= radius) objects.push(o);
      }
    }
    const header = (entry: number, outOf: number, objectId: number) =>
      Buffer.concat([
        u32(requestId),
        u32(objectId),
        u32(defineId),
        u32(0),
        u32(entry),
        u32(outOf),
        u32(datums.length),
      ]);
    if (objects.length === 0) {
      if (emu.options.emptyByTypeReply !== false) {
        this.send(RECV.SIMOBJECT_DATA_BYTYPE, header(0, 0, 0));
      }
      return;
    }
    const first = emu.options.byTypeFirstEntry ?? 1;
    objects.forEach((o, i) => {
      const data = Buffer.concat(datums.map((d) => encodeDatum(d.type, lookup(o.values, d.name))));
      this.send(
        RECV.SIMOBJECT_DATA_BYTYPE,
        Buffer.concat([header(i + first, objects.length, o.objectId), data]),
      );
    });
  }

  private replySystemState(requestId: number, state: string, sendId: number): void {
    const emu = this.emu;
    let integer = 0;
    let text = "";
    switch (state.toLowerCase()) {
      case "sim":
        integer = emu.simRunning ? 1 : 0;
        break;
      case "aircraftloaded":
        text = emu.aircraftPath;
        break;
      case "flightloaded":
        text = emu.flightPath;
        break;
      case "dialogmode":
        integer = 0;
        break;
      default:
        this.sendException(EXCEPTION.NAME_UNRECOGNIZED, sendId, 3);
        return;
    }
    const f = Buffer.alloc(4);
    f.writeFloatLE(0, 0);
    this.send(
      RECV.SYSTEM_STATE,
      Buffer.concat([u32(requestId), u32(integer), f, fixedString(text, MAX_PATH)]),
    );
  }

  /** Deliver a subscribed system event (no-op when the client did not subscribe). */
  systemEvent(name: string, data: number, fileName: string | undefined): boolean {
    const clientEventId = this.subscriptions.get(name.toLowerCase());
    if (clientEventId === undefined) return false;
    const event = Buffer.concat([u32(UNKNOWN_GROUP), u32(clientEventId), u32(data)]);
    if (FILENAME_EVENTS.has(name.toLowerCase())) {
      this.send(
        RECV.EVENT_FILENAME,
        Buffer.concat([event, fixedString(fileName ?? "", MAX_PATH), u32(0)]),
      );
    } else {
      this.send(RECV.EVENT, event);
    }
    return true;
  }

  /** SIMCONNECT_RECV_EVENT_EX1 (five data words), for clients that handle that shape too. */
  systemEventEx1(name: string, data: number[]): boolean {
    const clientEventId = this.subscriptions.get(name.toLowerCase());
    if (clientEventId === undefined) return false;
    const words = [0, 1, 2, 3, 4].map((i) => u32(data[i] ?? 0));
    this.send(RECV.EVENT_EX1, Buffer.concat([u32(UNKNOWN_GROUP), u32(clientEventId), ...words]));
    return true;
  }
}

// ---- the server ----

export class SimConnectEmulator extends EventEmitter {
  readonly options: EmulatorOptions;
  readonly profile: ProfileInfo;
  readonly applicationName: string;
  readonly simFrameMs: number;
  readonly secondMs: number;
  readonly userObjectId: number;
  values: Record<string, SimValue>;
  aiObjects: AiObject[];
  simRunning: boolean;
  /** While true, periodic data requests send no frames (main menu after SimStop). */
  framesHalted = false;
  aircraftPath: string;
  flightPath: string;
  /** Every decoded client packet, in arrival order. */
  readonly packets: ClientPacket[] = [];
  /** Function ids the emulator received but does not implement. */
  readonly unhandled: number[] = [];
  /** Framing errors (should stay empty). */
  readonly protocolErrors: string[] = [];
  framesSent = 0;
  facilityRepliesSent = 0;
  /** Airport facility database (see EmulatorOptions.facilities). */
  facilities: Record<string, EmulatedAirport>;
  connectionsAccepted = 0;
  private readonly server: Server;
  private readonly connections = new Set<EmulatedConnection>();
  private accepting = true;
  private nextConnection = 1;
  private rejects: RejectRule[];

  private constructor(options: EmulatorOptions) {
    super();
    this.options = options;
    this.profile = PROFILES[options.profile ?? "msfs2024"];
    this.applicationName = options.applicationName ?? this.profile.applicationName;
    this.simFrameMs = options.simFrameMs ?? 50;
    this.secondMs = options.secondMs ?? 1000;
    this.userObjectId = options.userObjectId ?? 1;
    this.values = upperKeys(options.values ?? {});
    this.aiObjects = (options.aiObjects ?? []).map((o) => ({ ...o, values: upperKeys(o.values) }));
    this.simRunning = options.simRunning ?? true;
    this.aircraftPath = options.aircraftPath ?? "SimObjects\\Airplanes\\Emulated\\aircraft.cfg";
    this.flightPath = options.flightPath ?? "flights\\other\\emulated.FLT";
    this.rejects = (options.reject ?? []).map((r) => (typeof r === "string" ? { name: r } : r));
    this.facilities = Object.fromEntries(
      Object.entries(options.facilities ?? {}).map(([k, v]) => [k.toUpperCase(), v]),
    );
    this.server = createServer((socket) => this.onSocket(socket));
  }

  /** Start listening on 127.0.0.1 (port 0 = any free port). */
  static async start(options: EmulatorOptions = {}, port = 0): Promise<SimConnectEmulator> {
    const emu = new SimConnectEmulator(options);
    await new Promise<void>((resolve, reject) => {
      emu.server.once("error", reject);
      emu.server.listen(port, "127.0.0.1", () => resolve());
    });
    return emu;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  /** Connections that completed OPEN and are still up. */
  get openConnections(): number {
    return [...this.connections].filter((c) => c.opened && !c.closed).length;
  }

  private onSocket(socket: Socket): void {
    socket.setNoDelay(true);
    if (!this.accepting) {
      // "Simulator not running": the port answers but nothing is served.
      socket.destroy();
      return;
    }
    this.connectionsAccepted++;
    const conn = new EmulatedConnection(this.nextConnection++, socket, this);
    this.connections.add(conn);
  }

  forget(conn: EmulatedConnection): void {
    this.connections.delete(conn);
  }

  recordPacket(packet: ClientPacket): void {
    this.packets.push(packet);
    this.emit("packet", packet);
  }

  rejectRule(name: string): RejectRule | undefined {
    const upper = name.toUpperCase();
    const colon = upper.lastIndexOf(":");
    const base = colon > 0 ? upper.slice(0, colon) : upper;
    return this.rejects.find((r) => {
      const n = r.name.toUpperCase();
      return n === upper || n === base;
    });
  }

  setReject(rules: Array<string | RejectRule>): void {
    this.rejects = rules.map((r) => (typeof r === "string" ? { name: r } : r));
  }

  /** AddToDataDefinition names received (optionally for one connection). */
  definedNames(connection?: number): string[] {
    return this.packets
      .filter(
        (p) =>
          p.fn === FN.ADD_TO_DATA_DEFINITION &&
          (connection === undefined || p.connection === connection),
      )
      .map((p) => String(p.fields["name"]));
  }

  /** ICAOs of every facility request received (optionally for one connection). */
  facilityRequests(connection?: number): string[] {
    return this.packets
      .filter(
        (p) =>
          (p.fn === FN.REQUEST_FACILITY_DATA || p.fn === FN.REQUEST_FACILITY_DATA_EX1) &&
          (connection === undefined || p.connection === connection),
      )
      .map((p) => String(p.fields["icao"]));
  }

  /** Merge new user-aircraft values; periodic requests pick them up on their next frame. */
  set(values: Record<string, SimValue>): void {
    Object.assign(this.values, upperKeys(values));
  }

  setAiObjects(objects: AiObject[]): void {
    this.aiObjects = objects.map((o) => ({ ...o, values: upperKeys(o.values) }));
  }

  /** Send a system event to every subscribed client. Returns how many received it. */
  systemEvent(name: string, data = 0, fileName?: string): number {
    let n = 0;
    for (const c of this.connections) if (c.opened && c.systemEvent(name, data, fileName)) n++;
    return n;
  }

  systemEventEx1(name: string, data: number[]): number {
    let n = 0;
    for (const c of this.connections) if (c.opened && c.systemEventEx1(name, data)) n++;
    return n;
  }

  /**
   * Pause_EX1 flags (0 running; PAUSE 1 | PAUSE_WITH_SOUND 2 | ACTIVE_PAUSE 4 | SIM_PAUSE 8,
   * docs/SIMVARS.md) plus the legacy Pause event.
   */
  pause(flags: number): void {
    this.systemEvent("Pause_EX1", flags);
    this.systemEvent("Pause", flags !== 0 ? 1 : 0);
  }

  /**
   * Back to the main menu: the "Sim" system state reads 0, then SimStop. With `haltFrames`
   * (default true) periodic requests stop sending frames until simStart().
   */
  simStop(options: { haltFrames?: boolean } = {}): void {
    this.simRunning = false;
    this.framesHalted = options.haltFrames ?? true;
    this.systemEvent("SimStop");
  }

  /** A flight is loaded and the user is in control again: "Sim" = 1, frames resume, SimStart. */
  simStart(): void {
    this.simRunning = true;
    this.framesHalted = false;
    this.systemEvent("SimStart");
  }

  /** Load another aircraft: new values, then AircraftLoaded with its .cfg path. */
  loadAircraft(values: Record<string, SimValue>, path: string): void {
    this.set(values);
    this.aircraftPath = path;
    this.systemEvent("AircraftLoaded", 0, path);
  }

  /** SIMCONNECT_RECV_QUIT to every client, then close the connections. */
  quit(): void {
    for (const c of [...this.connections]) {
      c.send(RECV.QUIT, Buffer.alloc(0));
      c.socket.end();
    }
  }

  /** Drop every connection without a QUIT (simulator crash / pipe broken). */
  drop(): void {
    for (const c of [...this.connections]) c.socket.destroy();
  }

  /** While false, new connections are closed immediately ("simulator not running"). */
  setAccepting(accepting: boolean): void {
    this.accepting = accepting;
  }

  async close(): Promise<void> {
    this.drop();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
