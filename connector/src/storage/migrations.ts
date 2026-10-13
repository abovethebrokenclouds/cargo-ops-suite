// Ordered schema migrations. Never edit a released migration; append a new one.
// Version 1 is the first-cut schema from plan §3.3.

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        json TEXT NOT NULL
      );
      CREATE TABLE company (
        id TEXT PRIMARY KEY,
        json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE aircraft (
        id TEXT PRIMARY KEY,
        reg TEXT,
        type_key TEXT,
        json TEXT NOT NULL
      );
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        origin TEXT,
        dest TEXT,
        cargo_kind TEXT,
        weight_kg REAL,
        payout REAL,
        deadline_at INTEGER,
        json TEXT NOT NULL
      );
      CREATE INDEX jobs_status ON jobs (status);
      CREATE TABLE flights (
        id TEXT PRIMARY KEY,
        started_at INTEGER,
        ended_at INTEGER,
        origin TEXT,
        dest TEXT,
        aircraft_id TEXT,
        job_ids TEXT,
        payload_kg REAL,
        distance_nm REAL,
        fuel_used_kg REAL,
        landing_json TEXT,
        score_json TEXT,
        status TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('sim', 'replay', 'demo'))
      );
      CREATE INDEX flights_started_at ON flights (started_at);
      CREATE TABLE telemetry (
        flight_id TEXT NOT NULL REFERENCES flights (id) ON DELETE CASCADE,
        t_ms INTEGER NOT NULL,
        json TEXT NOT NULL,
        PRIMARY KEY (flight_id, t_ms)
      );
      CREATE TABLE metar_cache (
        station TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
    `,
  },
  {
    // P2 flight tracking: block/air time, max altitude, fuel in lb, verification
    // flags and every touchdown of the flight (plan §6.4) as one JSON summary.
    version: 2,
    sql: `
      ALTER TABLE flights ADD COLUMN summary_json TEXT;
    `,
  },
];
