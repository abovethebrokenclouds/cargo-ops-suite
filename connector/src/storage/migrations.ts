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
  {
    // P5 used aircraft and airworthiness: the used market's listings (hidden defects
    // included, so they live only in the database, never in a frame). Per-aircraft systems,
    // defects, annual inspection, ferry permit and maintenance orders are new fields of the
    // fleet row's JSON: a P4 row is normalised when it is loaded (its condition mapped onto
    // every system, no defects, a current annual from the migration time).
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS market_listings (
        id TEXT PRIMARY KEY,
        generation INTEGER NOT NULL,
        type_key TEXT NOT NULL,
        location TEXT NOT NULL,
        asking_price REAL NOT NULL,
        inspection TEXT NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS market_listings_generation ON market_listings (generation);
      INSERT OR REPLACE INTO settings (key, json) VALUES ('economy.phase', '5');
    `,
  },
  {
    // P5 part 2: FBOs (plan §7.3 columns plus a JSON copy), their modules and traffic
    // transactions (source own | modelled | sim_ai), demand events and the per-airport
    // activity index, hull insurance policies and milestones. Company and fleet rows gain
    // JSON fields with defaults (no change needed). Idempotent: every statement is
    // IF NOT EXISTS / OR REPLACE, so re-running it on a database that has the tables is safe.
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS fbos (
        id TEXT PRIMARY KEY,
        icao TEXT NOT NULL,
        status TEXT NOT NULL,
        built_at INTEGER,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS fbos_icao ON fbos (icao, status);
      CREATE TABLE IF NOT EXISTS fbo_modules (
        fbo_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        level INTEGER NOT NULL,
        json TEXT,
        PRIMARY KEY (fbo_id, kind)
      );
      CREATE TABLE IF NOT EXISTS fbo_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        fbo_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        game_at INTEGER NOT NULL,
        kind TEXT NOT NULL,
        amount REAL NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('own', 'modelled', 'sim_ai')),
        memo TEXT
      );
      CREATE INDEX IF NOT EXISTS fbo_transactions_fbo ON fbo_transactions (fbo_id, id);
      CREATE TABLE IF NOT EXISTS demand_events (
        id TEXT PRIMARY KEY,
        icao TEXT NOT NULL,
        kind TEXT NOT NULL,
        start_at INTEGER NOT NULL,
        end_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS demand_events_end ON demand_events (end_at);
      CREATE TABLE IF NOT EXISTS demand_index (
        icao TEXT PRIMARY KEY,
        activity REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS insurance_policies (
        aircraft_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        premium REAL NOT NULL,
        json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS milestones (
        id TEXT PRIMARY KEY,
        game_at INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      INSERT OR REPLACE INTO settings (key, json) VALUES ('economy.phase', '6');
    `,
  },
  {
    // Weather: TAF cache next to the v1 metar_cache (same columns; survives restarts).
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS taf_cache (
        station TEXT PRIMARY KEY,
        fetched_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
    `,
  },
  {
    // Transit cargo (docs/ECONOMY.md "Transit cargo"): a job can wait at an intermediate
    // airport with status 'in_transit'. `location` is the airport its cargo is at now (the
    // origin until the first transit leg); the stop, the chain clock and every flown leg live
    // in the row's JSON (`transit`). Existing rows get their origin.
    version: 8,
    sql: `
      ALTER TABLE jobs ADD COLUMN location TEXT;
      UPDATE jobs SET location = origin WHERE location IS NULL;
      CREATE INDEX IF NOT EXISTS jobs_location ON jobs (location, status);
      INSERT OR REPLACE INTO settings (key, json) VALUES ('economy.phase', '8');
    `,
  },
  {
    // Hired pilots (docs/ECONOMY.md "Hired pilots"): simulated operations on fixed routes.
    // One row per pilot ever hired (status hired | fired, the assigned aircraft) with the
    // record as JSON (route, leg in progress, monthly P&L, last legs). The company row gains
    // `pilotCounter` (JSON, default 0) and fleet rows may carry the status 'hired'; neither
    // needs a column change. Idempotent (IF NOT EXISTS / OR REPLACE).
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS hired_pilots (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('hired', 'fired')),
        aircraft_id TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS hired_pilots_status ON hired_pilots (status);
      INSERT OR REPLACE INTO settings (key, json) VALUES ('economy.phase', '9');
    `,
  },
  {
    // MSFS facilities override (plan §6.1, §8, §14.3): airport data the connected simulator
    // returned for one ICAO (requestFacilityData), as the protocol's MsfsAirport JSON. Only
    // sim answers are stored (`source` is always 'msfs'); misses are never cached here.
    // Idempotent (IF NOT EXISTS).
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS msfs_airports (
        icao TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'msfs' CHECK (source = 'msfs'),
        sim TEXT,
        fetched_at INTEGER NOT NULL,
        json TEXT NOT NULL
      );
    `,
  },
];
