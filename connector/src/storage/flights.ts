// Flights and telemetry in SQLite (plan §3.3). The database is the one the
// connector opened for its mode: cargo-ops.db for live sessions, demo.db for
// replays (openStorage picks it), so replayed flights never reach the career data.

import type { FlightStatus, Source, Touchdown } from "../protocol";
import type { FlightRecord } from "../core/flight-tracker";
import type { Storage } from "./db";

const KG_PER_LB = 0.45359237;

export interface TelemetryRow {
  /** Sim-time ms since block-out. */
  tMs: number;
  data: Record<string, unknown>;
}

export interface FlightListItem {
  id: string;
  status: FlightStatus | string;
  source: Source | string;
  startedAt: string | null;
  endedAt: string | null;
  origin: string | null;
  destination: string | null;
  distanceNm: number | null;
  fuelUsedKg: number | null;
  landing: Touchdown | null;
  summary: Record<string, unknown> | null;
}

export interface FlightTrack {
  id: string;
  points: Array<Record<string, unknown> & { t: number }>;
}

interface FlightRow {
  id: string;
  started_at: number | null;
  ended_at: number | null;
  origin: string | null;
  dest: string | null;
  distance_nm: number | null;
  fuel_used_kg: number | null;
  landing_json: string | null;
  summary_json: string | null;
  status: string;
  source: string;
}

function parseJson<T>(text: string | null): T | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export class FlightRepo {
  constructor(
    private readonly storage: Storage,
    private readonly source: Source,
  ) {}

  /** Insert or update a flight from a tracker record. */
  save(record: FlightRecord): void {
    const landing = record.landings.at(-1) ?? null;
    const summary = {
      blockMin: record.blockMin,
      airborneMin: record.airborneMin,
      maxAltFt: record.maxAltFt,
      fuelUsedLb: record.fuelUsedLb,
      flags: record.flags,
      landings: record.landings,
      aircraftTitle: record.aircraftTitle ?? null,
      plannedDistanceNm: record.plannedDistanceNm ?? null,
    };
    this.storage.db
      .prepare(
        `INSERT INTO flights (id, started_at, ended_at, origin, dest, distance_nm, fuel_used_kg,
           landing_json, summary_json, status, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           ended_at = excluded.ended_at, origin = excluded.origin, dest = excluded.dest,
           distance_nm = excluded.distance_nm, fuel_used_kg = excluded.fuel_used_kg,
           landing_json = excluded.landing_json, summary_json = excluded.summary_json,
           status = excluded.status`,
      )
      .run(
        record.id,
        Date.parse(record.startedAt),
        record.endedAt ? Date.parse(record.endedAt) : null,
        record.origin ?? null,
        record.destination ?? null,
        record.distanceNm,
        Math.round(record.fuelUsedLb * KG_PER_LB * 10) / 10,
        landing ? JSON.stringify(landing) : null,
        JSON.stringify(summary),
        record.status,
        this.source,
      );
  }

  /** Append telemetry rows; a row at an existing (flight, t) is ignored. */
  addTelemetry(flightId: string, rows: readonly TelemetryRow[]): void {
    if (rows.length === 0) return;
    const db = this.storage.db;
    const insert = db.prepare(
      "INSERT OR IGNORE INTO telemetry (flight_id, t_ms, json) VALUES (?, ?, ?)",
    );
    db.exec("BEGIN");
    try {
      for (const row of rows) insert.run(flightId, Math.round(row.tMs), JSON.stringify(row.data));
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  list(limit = 50): FlightListItem[] {
    const rows = this.storage.db
      .prepare(
        `SELECT id, started_at, ended_at, origin, dest, distance_nm, fuel_used_kg, landing_json,
           summary_json, status, source
         FROM flights ORDER BY started_at DESC, id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(500, Math.floor(limit)))) as unknown as FlightRow[];
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      source: r.source,
      startedAt: isoOrNull(r.started_at),
      endedAt: isoOrNull(r.ended_at),
      origin: r.origin,
      destination: r.dest,
      distanceNm: r.distance_nm,
      fuelUsedKg: r.fuel_used_kg,
      landing: parseJson<Touchdown>(r.landing_json),
      summary: parseJson<Record<string, unknown>>(r.summary_json),
    }));
  }

  track(id: string): FlightTrack | null {
    const exists = this.storage.db.prepare("SELECT 1 AS ok FROM flights WHERE id = ?").get(id);
    if (!exists) return null;
    const rows = this.storage.db
      .prepare("SELECT t_ms, json FROM telemetry WHERE flight_id = ? ORDER BY t_ms")
      .all(id) as unknown as Array<{ t_ms: number; json: string }>;
    return {
      id,
      points: rows.map((r) => ({
        ...(parseJson<Record<string, unknown>>(r.json) ?? {}),
        t: r.t_ms,
      })),
    };
  }
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

/**
 * Authenticated /api routes for flights (the server checks the bearer token first):
 *   GET /api/flights            → { flights: FlightListItem[] } (newest first, ≤ 50)
 *   GET /api/flights/:id/track  → { id, points: [{ t, lat, lon, altFt, ... }] }
 */
export function flightsApi(repo: FlightRepo) {
  return ({ method, pathname }: { method: string; pathname: string }): ApiResponse | null => {
    if (pathname === "/api/flights") {
      if (method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
      return { status: 200, body: { flights: repo.list() } };
    }
    const match = /^\/api\/flights\/([A-Za-z0-9_-]{1,64})\/track$/.exec(pathname);
    if (!match) return null;
    if (method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
    const track = repo.track(match[1] ?? "");
    return track ? { status: 200, body: track } : { status: 404, body: { error: "not_found" } };
  };
}
