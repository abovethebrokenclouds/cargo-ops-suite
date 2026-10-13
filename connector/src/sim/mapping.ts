// Pure functions: raw SimConnect values (keyed by simvars.ts raw keys) → protocol
// domain objects. A domain is returned only when every required field has a real
// value and the result passes the shared zod schema. Missing data stays missing.

import {
  simDomainSchemas,
  type AircraftState,
  type ControlsState,
  type EnginesState,
  type FuelState,
  type MotionState,
  type PayloadState,
  type PositionState,
  type WeightsState,
} from "../protocol";
import type { IndexCounts, RawValues } from "./simvars";

function num(raw: RawValues, key: string): number | undefined {
  const value = raw[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function str(raw: RawValues, key: string): string | undefined {
  const value = raw[key];
  if (typeof value !== "string") return undefined;
  // Fixed-length SimConnect strings are NUL padded.
  const nul = value.indexOf("\u0000");
  return (nul >= 0 ? value.slice(0, nul) : value).trim();
}

function bool(raw: RawValues, key: string): boolean | undefined {
  const value = num(raw, key);
  return value === undefined ? undefined : value !== 0;
}

function valid<T>(domain: keyof typeof simDomainSchemas, value: unknown): T | undefined {
  return simDomainSchemas[domain].safeParse(value).success ? (value as T) : undefined;
}

export function mapPosition(raw: RawValues): PositionState | undefined {
  const lat = num(raw, "lat");
  const lon = num(raw, "lon");
  const altFt = num(raw, "altFt");
  const aglFt = num(raw, "aglFt");
  if (lat === undefined || lon === undefined || altFt === undefined || aglFt === undefined) {
    return undefined;
  }
  // 0/0 is what SimConnect reports before an aircraft is loaded; not a position.
  if (lat === 0 && lon === 0) return undefined;
  return valid<PositionState>("position", { lat, lon, altFt, aglFt });
}

export function mapMotion(raw: RawValues): MotionState | undefined {
  const onGround = bool(raw, "isOnGround") ?? bool(raw, "simOnGround");
  const fields = {
    iasKt: num(raw, "iasKt"),
    tasKt: num(raw, "tasKt"),
    gsKt: num(raw, "gsKt"),
    hdgMagDeg: num(raw, "hdgMagDeg"),
    hdgTrueDeg: num(raw, "hdgTrueDeg"),
    vsFpm: num(raw, "vsFpm"),
    gForce: num(raw, "gForce"),
    onGround,
  };
  if (Object.values(fields).some((v) => v === undefined)) return undefined;
  // Latched touchdown values: optional, each only when the sim reports it.
  const tdFps = num(raw, "touchdownNormalFps");
  const tdBank = num(raw, "touchdownBankDeg");
  const tdPitch = num(raw, "touchdownPitchDeg");
  const motion: Record<string, unknown> = { ...fields };
  if (tdFps !== undefined) motion["touchdownVelocityFpm"] = tdFps * 60;
  if (tdBank !== undefined) motion["touchdownBankDeg"] = tdBank;
  if (tdPitch !== undefined) motion["touchdownPitchDeg"] = tdPitch;
  return valid<MotionState>("motion", motion);
}

export interface FastMapping {
  position?: PositionState;
  motion?: MotionState;
}

export function mapFast(raw: RawValues): FastMapping {
  const out: FastMapping = {};
  const position = mapPosition(raw);
  const motion = mapMotion(raw);
  if (position) out.position = position;
  if (motion) out.motion = motion;
  return out;
}

export function mapAircraft(raw: RawValues): AircraftState | undefined {
  const title = str(raw, "title");
  if (!title) return undefined;
  const atcId = str(raw, "atcId");
  return valid<AircraftState>("aircraft", atcId ? { title, atcId } : { title });
}

function indexed<T>(n: number, read: (i: number) => T | undefined): T[] | undefined {
  const out: T[] = [];
  for (let i = 1; i <= n; i++) {
    const value = read(i);
    if (value === undefined) return undefined;
    out.push(value);
  }
  return out;
}

export function mapFuel(raw: RawValues, counts: IndexCounts): FuelState | undefined {
  const totalGal = num(raw, "fuelGal");
  const totalLb = num(raw, "fuelLb");
  if (totalGal === undefined || totalLb === undefined) return undefined;
  // An empty list means "no per-engine flow available" (SimVar rejected), never zero flow.
  const flowPph = indexed(counts.engines, (i) => num(raw, `fuelFlowPph:${i}`)) ?? [];
  return valid<FuelState>("fuel", { totalGal, totalLb, flowPph });
}

export function mapPayload(raw: RawValues, counts: IndexCounts): PayloadState | undefined {
  const stations = indexed(counts.stations, (i) => {
    const weightLb = num(raw, `stationWeightLb:${i}`);
    if (weightLb === undefined) return undefined;
    return { name: str(raw, `stationName:${i}`) || `Station ${i}`, weightLb };
  });
  if (!stations) return undefined;
  return valid<PayloadState>("payload", { stations });
}

export function mapWeights(
  raw: RawValues,
  payload: PayloadState | undefined,
): WeightsState | undefined {
  const totalLb = num(raw, "totalWeightLb");
  const emptyLb = num(raw, "emptyWeightLb");
  const maxGrossLb = num(raw, "maxGrossWeightLb");
  if (totalLb === undefined || emptyLb === undefined || maxGrossLb === undefined) return undefined;
  // Payload = sum of payload stations (pilot and passengers included, as the sim defines them).
  if (!payload) return undefined;
  const payloadLb = payload.stations.reduce((sum, s) => sum + s.weightLb, 0);
  return valid<WeightsState>("weights", { totalLb, emptyLb, maxGrossLb, payloadLb });
}

export function mapEngines(raw: RawValues, counts: IndexCounts): EnginesState | undefined {
  const running = indexed(counts.engines, (i) => bool(raw, `engineCombustion:${i}`));
  if (!running) return undefined;
  return valid<EnginesState>("engines", { running });
}

export function mapControls(raw: RawValues): ControlsState | undefined {
  const parkingBrake = bool(raw, "parkingBrake");
  if (parkingBrake === undefined) return undefined;
  return valid<ControlsState>("controls", { parkingBrake });
}

/** SIMULATION RATE, when the sim reports a usable positive number. */
export function mapSimRate(raw: RawValues): number | undefined {
  const rate = num(raw, "simRate");
  return rate !== undefined && rate > 0 ? rate : undefined;
}

/** ZULU TIME/DAY/MONTH/YEAR → ISO 8601, or undefined if any part is missing or invalid. */
export function mapZulu(raw: RawValues): string | undefined {
  const sec = num(raw, "zuluTimeSec");
  const day = num(raw, "zuluDay");
  const month = num(raw, "zuluMonth");
  const year = num(raw, "zuluYear");
  if (sec === undefined || day === undefined || month === undefined || year === undefined) {
    return undefined;
  }
  if (sec < 0 || sec >= 86400 || day < 1 || day > 31 || month < 1 || month > 12) return undefined;
  const ms = Date.UTC(year, month - 1, day) + Math.round(sec * 1000);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

export interface SlowMapping {
  aircraft?: AircraftState;
  fuel?: FuelState;
  weights?: WeightsState;
  payload?: PayloadState;
  engines?: EnginesState;
  controls?: ControlsState;
  simRate?: number;
  zulu?: string;
}

export function mapSlow(raw: RawValues, counts: IndexCounts): SlowMapping {
  const out: SlowMapping = {};
  const aircraft = mapAircraft(raw);
  const fuel = mapFuel(raw, counts);
  const payload = mapPayload(raw, counts);
  const weights = mapWeights(raw, payload);
  const engines = mapEngines(raw, counts);
  const controls = mapControls(raw);
  const simRate = mapSimRate(raw);
  const zulu = mapZulu(raw);
  if (aircraft) out.aircraft = aircraft;
  if (fuel) out.fuel = fuel;
  if (payload) out.payload = payload;
  if (weights) out.weights = weights;
  if (engines) out.engines = engines;
  if (controls) out.controls = controls;
  if (simRate !== undefined) out.simRate = simRate;
  if (zulu) out.zulu = zulu;
  return out;
}

/** Fast-data cadence: 10 Hz below 1,000 ft AGL, 5 Hz otherwise (plan §3.2). */
export function fastIntervalMs(aglFt: number | undefined): number {
  return aglFt !== undefined && aglFt < 1000 ? 100 : 200;
}

/** Display name of the simulator from the open response and the negotiated protocol. */
export function simNameFor(applicationName: string, protocol: "SunRise" | "KittyHawk"): string {
  if (/sunrise/i.test(applicationName)) return "MSFS 2024";
  if (/kittyhawk/i.test(applicationName)) return "MSFS 2020";
  // Unverified fallback: the protocol we managed to open with.
  return protocol === "SunRise" ? "MSFS 2024" : "MSFS";
}

/** Pause_EX1 flags: 0 = running; any of FULL(1)/ACTIVE(2)/SIM(4) = paused. */
export function pausedFromEx1(flags: number): boolean {
  return (flags & 0b111) !== 0;
}
