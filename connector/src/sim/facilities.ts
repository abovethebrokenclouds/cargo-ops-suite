// MSFS facilities (plan §6.1 "Facilities", §14.3): per-ICAO airport data through
// SimConnect's facility API, used unmodified through node-simconnect's public methods
// (addToFacilityDefinition, requestFacilityData and the facilityData / facilityDataEnd
// events). Never a bulk list: the 2024 list callbacks are known to be unreliable, so the
// connector asks for the airports it needs, one ICAO at a time, and caches the answers.
//
// UNVERIFIED on a real simulator: field names, data types and units come from secondary
// copies of the SDK pages (docs/SIMVARS.md "Facility definition"); the tests run against
// the test-only protocol emulator. PC-57 in docs/VERIFICATION.md checks it on MSFS.
//
// Wire behaviour relied on (SDK "SimConnect_RequestFacilityData"):
// - every requested member arrives packed in definition order, without padding;
// - the airport arrives as one SIMCONNECT_RECV_FACILITY_DATA of type AIRPORT, then one per
//   runway (type RUNWAY, isListItem, itemIndex/listSize), then FACILITY_DATA_END;
// - a rejected member name raises an exception against that addToFacilityDefinition call.
// ASSUMPTION (not documented): an ICAO the sim does not know answers with FACILITY_DATA_END
// and no AIRPORT record, or with an exception against the request. Both count as a miss.

import {
  FacilityDataType,
  type RawBuffer,
  type RecvException,
  type RecvFacilityData,
  type RecvFacilityDataEnd,
  type SimConnectConnection,
} from "node-simconnect";
import { metresToFeet, msfsSurfaceName } from "../economy";
import type { MsfsAirport, MsfsRunway } from "../protocol";
import type { LogFn } from "./source";

export type FacilityValueType = "f64" | "f32" | "i32" | "string64";

/** One addToFacilityDefinition call: a block marker or a member with its documented type. */
export interface FacilityField {
  /** Exact name passed to addToFacilityDefinition. */
  name: string;
  /** Block the member belongs to (markers: the block they open or close). */
  scope: "airport" | "runway";
  /** Absent for the OPEN/CLOSE markers. */
  type?: FacilityValueType;
  /** Raw key in the parsed record. */
  key?: string;
  /** Unit the SDK documents for the member (informational; nothing is requested in a unit). */
  unit?: string;
}

/**
 * The airport definition the connector registers (order = wire order). Every member is
 * one docs/SIMVARS.md "Facility definition" lists with its SDK type and unit.
 */
export const AIRPORT_FACILITY_DEFINITION: readonly FacilityField[] = [
  { name: "OPEN AIRPORT", scope: "airport" },
  { name: "LATITUDE", scope: "airport", type: "f64", key: "lat", unit: "degrees" },
  { name: "LONGITUDE", scope: "airport", type: "f64", key: "lon", unit: "degrees" },
  { name: "ALTITUDE", scope: "airport", type: "f64", key: "altM", unit: "meters" },
  { name: "NAME64", scope: "airport", type: "string64", key: "name" },
  { name: "N_RUNWAYS", scope: "airport", type: "i32", key: "nRunways", unit: "count" },
  { name: "OPEN RUNWAY", scope: "runway" },
  { name: "HEADING", scope: "runway", type: "f32", key: "heading", unit: "degrees true" },
  { name: "LENGTH", scope: "runway", type: "f32", key: "lengthM", unit: "meters" },
  { name: "WIDTH", scope: "runway", type: "f32", key: "widthM", unit: "meters" },
  { name: "SURFACE", scope: "runway", type: "i32", key: "surface", unit: "enum" },
  { name: "PRIMARY_NUMBER", scope: "runway", type: "i32", key: "pNum", unit: "enum" },
  { name: "PRIMARY_DESIGNATOR", scope: "runway", type: "i32", key: "pDes", unit: "enum" },
  { name: "SECONDARY_NUMBER", scope: "runway", type: "i32", key: "sNum", unit: "enum" },
  { name: "SECONDARY_DESIGNATOR", scope: "runway", type: "i32", key: "sDes", unit: "enum" },
  { name: "CLOSE RUNWAY", scope: "runway" },
  { name: "CLOSE AIRPORT", scope: "airport" },
];

export type RawFacility = Record<string, number | string>;

const membersOf = (scope: FacilityField["scope"]) =>
  AIRPORT_FACILITY_DEFINITION.filter((f) => f.scope === scope && f.type && f.key);

/** Read one facility record (members of `scope` in definition order); throws when short. */
export function readFacilityRecord(data: RawBuffer, scope: FacilityField["scope"]): RawFacility {
  const out: RawFacility = {};
  for (const f of membersOf(scope)) {
    const key = f.key as string;
    switch (f.type) {
      case "f64":
        out[key] = data.readFloat64();
        break;
      case "f32":
        out[key] = data.readFloat32();
        break;
      case "i32":
        out[key] = data.readInt32();
        break;
      case "string64":
        out[key] = data.readString64();
        break;
    }
  }
  return out;
}

const COMPASS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const DESIGNATORS = ["", "L", "R", "C", "W", "A", "B"];

/** Runway end label from the SDK NUMBER / DESIGNATOR enums ("" when none or unknown). */
export function runwayEnd(num: number, designator: number): string {
  let n = "";
  if (num >= 1 && num <= 36) n = String(num).padStart(2, "0");
  else if (num >= 37 && num <= 44) n = COMPASS[num - 37] ?? "";
  if (!n) return "";
  return n + (DESIGNATORS[designator] ?? "");
}

const num = (raw: RawFacility, key: string): number => {
  const v = raw[key];
  return typeof v === "number" ? v : Number.NaN;
};

/** Convert a parsed airport + runways to the protocol record; null when it is not usable. */
export function toMsfsAirport(
  icao: string,
  airport: RawFacility,
  runways: RawFacility[],
  fetchedAt: string,
  sim: string | undefined,
): MsfsAirport | null {
  const lat = num(airport, "lat");
  const lon = num(airport, "lon");
  const altM = num(airport, "altM");
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(altM)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  const out: MsfsRunway[] = [];
  for (const r of runways) {
    const lengthM = num(r, "lengthM");
    const widthM = num(r, "widthM");
    const heading = num(r, "heading");
    const surfaceCode = num(r, "surface");
    if (![lengthM, widthM, heading, surfaceCode].every(Number.isFinite)) continue;
    if (lengthM < 0 || widthM < 0) continue;
    const ends = [
      runwayEnd(num(r, "pNum"), num(r, "pDes")),
      runwayEnd(num(r, "sNum"), num(r, "sDes")),
    ].filter(Boolean);
    out.push({
      ident: ends.join("/"),
      headingTrueDeg: Math.round((((heading % 360) + 360) % 360) * 10) / 10,
      lengthFt: metresToFeet(lengthM),
      widthFt: metresToFeet(widthM),
      surfaceCode: Math.trunc(surfaceCode),
      surface: msfsSurfaceName(Math.trunc(surfaceCode)),
    });
  }
  const name = typeof airport["name"] === "string" ? airport["name"].trim() : "";
  return {
    icao: icao.toUpperCase(),
    ...(name ? { name } : {}),
    lat,
    lon,
    elevFt: metresToFeet(altM),
    runways: out,
    fetchedAt,
    ...(sim ? { sim } : {}),
  };
}

export type FacilityResult =
  | { status: "found"; airport: MsfsAirport }
  /** The sim has no airport with that ICAO. */
  | { status: "missing" }
  /** The sim refused the facility definition (this connection uses OurAirports only). */
  | { status: "rejected"; reason: string }
  /** No simulator connection. */
  | { status: "offline" }
  | { status: "timeout" }
  /** The answer could not be decoded. */
  | { status: "error"; reason: string };

/** Ask the connected sim for one airport (SimConnectSource implements it). */
export interface FacilityRequester {
  requestAirportFacility(icao: string): Promise<FacilityResult>;
}

interface Pending {
  icao: string;
  requestId: number;
  sendId: number;
  airport: RawFacility | null;
  runways: RawFacility[];
  error: string | null;
  timer: NodeJS.Timeout;
  resolve: (r: FacilityResult) => void;
}

export const FACILITY_TIMEOUT_MS = 10_000;

/** One connection's facility definition and its in-flight requests. */
export class SimConnectFacilities {
  private defineId: number | null = null;
  /** sendId of each addToFacilityDefinition → member name. */
  private readonly defSends = new Map<number, string>();
  private rejected: string | null = null;
  private readonly pending = new Map<number, Pending>();
  private disposed = false;

  constructor(
    private readonly handle: SimConnectConnection,
    private readonly allocId: () => number,
    private readonly log: LogFn,
    private readonly sim: () => string | undefined,
    private readonly timeoutMs = FACILITY_TIMEOUT_MS,
  ) {}

  /** Define the airport facility once per connection (lazily: only when first needed). */
  private ensureDefinition(): number {
    if (this.defineId !== null) return this.defineId;
    const id = this.allocId();
    this.defineId = id;
    for (const field of AIRPORT_FACILITY_DEFINITION) {
      const sendId = this.handle.addToFacilityDefinition(id, field.name);
      this.defSends.set(sendId, field.name);
    }
    return id;
  }

  request(icao: string): Promise<FacilityResult> {
    if (this.disposed) return Promise.resolve({ status: "offline" });
    if (this.rejected) return Promise.resolve({ status: "rejected", reason: this.rejected });
    return new Promise((resolve) => {
      let defineId: number;
      let sendId: number;
      const requestId = this.allocId();
      try {
        defineId = this.ensureDefinition();
        sendId = this.handle.requestFacilityData(defineId, requestId, icao);
      } catch (err) {
        resolve({ status: "error", reason: err instanceof Error ? err.message : String(err) });
        return;
      }
      const timer = setTimeout(() => this.finish(requestId, { status: "timeout" }), this.timeoutMs);
      timer.unref();
      this.pending.set(requestId, {
        icao,
        requestId,
        sendId,
        airport: null,
        runways: [],
        error: null,
        timer,
        resolve,
      });
    });
  }

  onData(recv: RecvFacilityData): void {
    const p = this.pending.get(recv.userRequestId);
    if (!p || p.error) return;
    try {
      if (recv.type === FacilityDataType.AIRPORT) {
        p.airport = readFacilityRecord(recv.data, "airport");
      } else if (recv.type === FacilityDataType.RUNWAY) {
        p.runways.push(readFacilityRecord(recv.data, "runway"));
      }
    } catch (err) {
      p.error = err instanceof Error ? err.message : String(err);
    }
  }

  onEnd(recv: RecvFacilityDataEnd): void {
    const p = this.pending.get(recv.userRequestId);
    if (!p) return;
    if (p.error) return this.finish(p.requestId, { status: "error", reason: p.error });
    if (!p.airport) return this.finish(p.requestId, { status: "missing" });
    const nRunways = p.airport["nRunways"];
    if (typeof nRunways === "number" && nRunways !== p.runways.length) {
      this.log(
        "debug",
        `MSFS facility ${p.icao}: N_RUNWAYS ${nRunways}, ${p.runways.length} runway records`,
      );
    }
    const airport = toMsfsAirport(
      p.icao,
      p.airport,
      p.runways,
      new Date().toISOString(),
      this.sim(),
    );
    this.finish(
      p.requestId,
      airport ? { status: "found", airport } : { status: "error", reason: "unusable position" },
    );
  }

  /** True when the exception belongs to a facility call (handled here). */
  onException(ex: RecvException): boolean {
    const member = this.defSends.get(ex.sendId);
    if (member !== undefined) {
      if (!this.rejected) {
        this.rejected = `"${member}" ${ex.exceptionName}`;
        for (const p of [...this.pending.values()]) {
          this.finish(p.requestId, { status: "rejected", reason: this.rejected });
        }
      }
      return true;
    }
    for (const p of this.pending.values()) {
      if (p.sendId === ex.sendId) {
        this.log("debug", `MSFS facility ${p.icao}: ${ex.exceptionName}`);
        this.finish(p.requestId, { status: "missing" });
        return true;
      }
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    for (const p of [...this.pending.values()]) this.finish(p.requestId, { status: "offline" });
  }

  private finish(requestId: number, result: FacilityResult): void {
    const p = this.pending.get(requestId);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(requestId);
    p.resolve(result);
  }
}
