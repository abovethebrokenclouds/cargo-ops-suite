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
  {
    // P3 cargo operations: missions (one flown leg carrying one or more jobs), the
    // job ↔ mission link, and a simple ledger whose `category` values P4 extends
    // (job_payout today; fuel, lease, loan_* … later). Company rows use the v1
    // `company` table (id 'company'); jobs use the v1 `jobs` table plus two columns.
    version: 3,
    sql: `
      ALTER TABLE jobs ADD COLUMN created_at INTEGER;
      ALTER TABLE jobs ADD COLUMN mission_id TEXT;
      CREATE INDEX jobs_origin ON jobs (origin, status);
      CREATE TABLE missions (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        origin TEXT NOT NULL,
        dest TEXT NOT NULL,
        aircraft_type TEXT NOT NULL,
        flight_id TEXT,
        payload_kg REAL NOT NULL,
        payout REAL,
        created_at INTEGER NOT NULL,
        started_at INTEGER,
        ended_at INTEGER,
        json TEXT NOT NULL
      );
      CREATE INDEX missions_created_at ON missions (created_at);
      CREATE INDEX missions_flight ON missions (flight_id);
      CREATE TABLE mission_jobs (
        mission_id TEXT NOT NULL REFERENCES missions (id) ON DELETE CASCADE,
        job_id TEXT NOT NULL,
        PRIMARY KEY (mission_id, job_id)
      );
      CREATE TABLE ledger (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at INTEGER NOT NULL,
        category TEXT NOT NULL,
        amount REAL NOT NULL,
        ref_type TEXT,
        ref_id TEXT,
        memo TEXT,
        json TEXT
      );
      CREATE INDEX ledger_at ON ledger (at);
    `,
  },
  {
    // P4 company, fleet and finance: owned/leased aircraft, their event log (wear,
    // repairs, purchases), bank loans (plan §7.2 columns plus a JSON copy), and the
    // ledger gains a running balance and the company-clock time. P3 `job_payout` rows
    // become `mission_payout`; their running balance starts from the P3 starting cash
    // ($250,000) and their company-clock time is 0. The settings row records the phase.
    version: 4,
    sql: `
      CREATE TABLE fleet (
        id TEXT PRIMARY KEY,
        registration TEXT NOT NULL,
        type_key TEXT NOT NULL,
        ownership TEXT NOT NULL,
        status TEXT NOT NULL,
        location TEXT NOT NULL,
        condition REAL NOT NULL,
        loan_id TEXT,
        acquired_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX fleet_status ON fleet (status);
      CREATE TABLE aircraft_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        aircraft_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        game_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        json TEXT
      );
      CREATE INDEX aircraft_events_aircraft ON aircraft_events (aircraft_id, id);
      CREATE TABLE loans (
        id TEXT PRIMARY KEY,
        lender TEXT NOT NULL,
        principal REAL NOT NULL,
        apr REAL NOT NULL,
        term_months INTEGER NOT NULL,
        payment REAL NOT NULL,
        balance REAL NOT NULL,
        collateral_type TEXT NOT NULL,
        collateral_id TEXT NOT NULL,
        next_due_at INTEGER NOT NULL,
        missed_count INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX loans_status ON loans (status);
      ALTER TABLE ledger ADD COLUMN balance REAL;
      ALTER TABLE ledger ADD COLUMN game_at INTEGER NOT NULL DEFAULT 0;
      CREATE INDEX ledger_category ON ledger (category);
      UPDATE ledger SET category = 'mission_payout' WHERE category = 'job_payout';
      UPDATE ledger SET balance = 250000 + (SELECT SUM(l2.amount) FROM ledger l2 WHERE l2.id <= ledger.id);
      INSERT OR REPLACE INTO settings (key, json) VALUES ('economy.phase', '4');
    `,
  },
];
