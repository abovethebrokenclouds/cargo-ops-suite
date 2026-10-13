// Real simulator AI traffic near the player's FBO airports (plan §7.3, income source 3).
//
// - `AiArrivalDetector` (pure, unit-tested with hand-made samples): an AI aircraft counts as
//   an arrival at an FBO airport when it is within 10 km of the airport, on the ground and
//   slower than 30 kt, after the detector saw the same object id moving (airborne, or faster
//   than 40 kt) within that radius, and that object id was not credited at that airport in
//   the last 6 hours. Objects first seen already parked (gate spawns) never count.
// - `SimConnectAiSampler`: every ~30 s, while an owned FBO airport is within reach of the
//   user aircraft, asks SimConnect for every AIRCRAFT object around the user aircraft with
//   `requestDataOnSimObjectType` (the radius is centred on the USER aircraft, max 200 km:
//   it is set to the distance to the farthest FBO in reach + 10 km), collects the
//   `simObjectDataByType` replies (entryNumber/outOf) and hands one batch to the listener.
// - `FakeAiTraffic`: a replay-friendly scripted batch source for tests.
//
// UNVERIFIED: the SimConnect part has only been type-checked against node-simconnect
// 4.2.1's type definitions; it has never talked to a running simulator (docs/VERIFICATION.md).
// The economy works fully offline: these arrivals are only a labelled bonus (source sim_ai).

import {
  SimConnectDataType,
  SimObjectType,
  type RecvSimObjectData,
  type SimConnectConnection,
} from "node-simconnect";
import { AI_ARRIVAL } from "../economy";
import type { LogFn } from "./source";

export interface AiObjectSample {
  /** SimConnect object id (reused by the sim over time). */
  objectId: number;
  lat: number;
  lon: number;
  onGround: boolean;
  gsKt: number;
  atcId?: string;
}

export interface AiTarget {
  fboId: string;
  icao: string;
  lat: number;
  lon: number;
}

export interface AiArrival {
  objectId: number;
  fboId: string;
  icao: string;
  /** Batch time, ms. */
  at: number;
  atcId?: string;
}

const EARTH_RADIUS_M = 6_371_008.8;

export function distanceM(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

export interface DetectorOptions {
  radiusM?: number;
  maxGsKt?: number;
  movingKt?: number;
  memoryMs?: number;
}

/** Pure arrival detection over successive batches of AI object samples. */
export class AiArrivalDetector {
  private readonly radiusM: number;
  private readonly maxGsKt: number;
  private readonly movingKt: number;
  private readonly memoryMs: number;
  /** `${icao}|${objectId}` → last time it was seen moving within the radius. */
  private readonly moving = new Map<string, number>();
  /** `${icao}|${objectId}` → when it was credited. */
  private readonly credited = new Map<string, number>();

  constructor(options: DetectorOptions = {}) {
    this.radiusM = options.radiusM ?? AI_ARRIVAL.radiusM;
    this.maxGsKt = options.maxGsKt ?? AI_ARRIVAL.maxGsKt;
    this.movingKt = options.movingKt ?? AI_ARRIVAL.movingKt;
    this.memoryMs = options.memoryMs ?? AI_ARRIVAL.memoryMs;
  }

  /** Feed one batch (every AI aircraft the sim returned at time `at`); returns new arrivals. */
  update(
    samples: readonly AiObjectSample[],
    targets: readonly AiTarget[],
    at: number,
  ): AiArrival[] {
    for (const [key, t] of this.credited) if (at - t > this.memoryMs) this.credited.delete(key);
    for (const [key, t] of this.moving) if (at - t > this.memoryMs) this.moving.delete(key);
    const out: AiArrival[] = [];
    for (const s of samples) {
      if (!Number.isFinite(s.lat) || !Number.isFinite(s.lon) || !Number.isFinite(s.gsKt)) continue;
      for (const target of targets) {
        if (distanceM(s, target) > this.radiusM) continue;
        const key = `${target.icao}|${s.objectId}`;
        if (!s.onGround || s.gsKt > this.movingKt) {
          this.moving.set(key, at);
          continue;
        }
        if (s.gsKt >= this.maxGsKt || !this.moving.has(key) || this.credited.has(key)) continue;
        this.credited.set(key, at);
        this.moving.delete(key);
        out.push({
          objectId: s.objectId,
          fboId: target.fboId,
          icao: target.icao,
          at,
          ...(s.atcId ? { atcId: s.atcId } : {}),
        });
      }
    }
    return out;
  }

  reset(): void {
    this.moving.clear();
    this.credited.clear();
  }
}

export type AiBatchListener = (samples: AiObjectSample[], at: number) => void;

/** Largest radius SimConnect accepts for requestDataOnSimObjectType, metres. */
export const SIMCONNECT_MAX_RADIUS_M = 200_000;
export const AI_SAMPLE_INTERVAL_MS = 30_000;

/**
 * Radius for the request around the user aircraft: the farthest FBO airport whose 10 km
 * circle lies inside SimConnect's 200 km limit, + 10 km. Null when no FBO is in reach.
 */
export function requestRadiusM(
  user: { lat: number; lon: number },
  targets: readonly AiTarget[],
  radiusM: number = AI_ARRIVAL.radiusM,
): number | null {
  let far = -1;
  for (const t of targets) {
    const d = distanceM(user, t);
    if (d + radiusM <= SIMCONNECT_MAX_RADIUS_M) far = Math.max(far, d);
  }
  return far < 0 ? null : Math.ceil(far + radiusM);
}

/**
 * Samples AI aircraft through SimConnect. The owner (SimConnectSource) creates it after the
 * connection opened, forwards `simObjectDataByType` packets to `onData`, and calls `sample`
 * every 30 s with the user position and the FBO airports.
 */
export class SimConnectAiSampler {
  private batch: AiObjectSample[] = [];
  private inFlight = false;
  private requestedAt = 0;

  constructor(
    private readonly handle: SimConnectConnection,
    private readonly ids: { defineId: number; requestId: number },
    private readonly log: LogFn,
    private readonly onBatch: AiBatchListener,
  ) {
    const def = ids.defineId;
    // Order matters: onData reads the buffer in the same order.
    handle.addToDataDefinition(def, "PLANE LATITUDE", "degrees", SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(def, "PLANE LONGITUDE", "degrees", SimConnectDataType.FLOAT64);
    // SIM ON GROUND is the long-standing variable for AI objects (IS ON GROUND is unverified there).
    handle.addToDataDefinition(def, "SIM ON GROUND", "bool", SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(def, "GROUND VELOCITY", "knots", SimConnectDataType.FLOAT64);
    handle.addToDataDefinition(def, "ATC ID", null, SimConnectDataType.STRING64);
  }

  /** Request one batch if an FBO airport is in reach of the user aircraft. */
  sample(
    user: { lat: number; lon: number } | null,
    targets: readonly AiTarget[],
    now: number,
  ): void {
    if (!user || targets.length === 0) return;
    // A request that never completed (no reply) is abandoned after two intervals.
    if (this.inFlight && now - this.requestedAt < 2 * AI_SAMPLE_INTERVAL_MS) return;
    const radius = requestRadiusM(user, targets);
    if (radius === null) return;
    this.batch = [];
    this.inFlight = true;
    this.requestedAt = now;
    try {
      this.handle.requestDataOnSimObjectType(
        this.ids.requestId,
        this.ids.defineId,
        Math.min(SIMCONNECT_MAX_RADIUS_M, radius),
        SimObjectType.AIRCRAFT,
      );
    } catch (err) {
      this.inFlight = false;
      this.log("warn", `AI traffic request failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  /** A `simObjectDataByType` packet. Returns true when it belonged to this sampler. */
  onData(recv: RecvSimObjectData, now: number): boolean {
    if (recv.requestID !== this.ids.requestId) return false;
    if (recv.outOf === 0) {
      // No aircraft in the radius.
      this.flush(now);
      return true;
    }
    try {
      const lat = recv.data.readFloat64();
      const lon = recv.data.readFloat64();
      const onGround = recv.data.readFloat64() >= 0.5;
      const gsKt = recv.data.readFloat64();
      const atcId = recv.data.readString64().trim();
      this.batch.push({
        objectId: recv.objectID,
        lat,
        lon,
        onGround,
        gsKt,
        ...(atcId ? { atcId } : {}),
      });
    } catch (err) {
      this.log("debug", `Dropped an AI traffic entry: ${err instanceof Error ? err.message : err}`);
    }
    // entryNumber and outOf are 1-based (1/2, 2/2); counting entries also covers a 0-based
    // numbering should a simulator build use one.
    if (recv.entryNumber >= recv.outOf || this.batch.length >= recv.outOf) this.flush(now);
    return true;
  }

  private flush(now: number): void {
    const samples = this.batch;
    this.batch = [];
    this.inFlight = false;
    this.onBatch(samples, now);
  }
}

/** Scripted AI batches for tests and replays (no simulator). */
export class FakeAiTraffic {
  private index = 0;

  constructor(
    private readonly batches: ReadonlyArray<{ at: number; samples: AiObjectSample[] }>,
    private readonly onBatch: AiBatchListener,
  ) {}

  /** Emit the next batch; false when the script is exhausted. */
  next(): boolean {
    const b = this.batches[this.index];
    if (!b) return false;
    this.index++;
    this.onBatch(b.samples, b.at);
    return true;
  }

  /** Emit every remaining batch in order. */
  playAll(): void {
    while (this.next()) {
      // keep going
    }
  }
}
