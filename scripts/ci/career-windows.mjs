#!/usr/bin/env node
// W-29 / W-33 / W-36 (PC-29, PC-33, PC-36 without MSFS): career database migrations and JSON
// export/import through the REAL connector build in live mode (`--sim simconnect`, which uses
// cargo-ops.db; with no simulator it just retries the link). On Windows the data directory is
// the default %LOCALAPPDATA%\CargoOps (no --data-dir), so Windows paths and file handling are
// what is exercised. On Linux a temp folder is used.
//
//   1. a P3 install's cargo-ops.db (schema 3) migrates to the current schema on start
//   2. a P4 install's cargo-ops.db (schema 4) migrates on start; its aircraft get P5 systems
//   3. a fresh career: export → import → export is identical (except exportedAt)
//   4. version 4, 3, 2 and 1 exports derived from it (as older builds wrote them) import, and the
//      next export is the current version
//
// Not covered here: "import refused during a flight" needs an active flight (real sim or a
// replay into demo.db); it is covered by connector/test/career.test.ts on Linux and Windows.
//
//   node scripts/ci/career-windows.mjs [--port 4321]

import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  api,
  assert,
  assertEqual,
  ciDataDir,
  distModule,
  log,
  run,
  sessionToken,
  startConnector,
  wipe,
} from "./lib.mjs";

const T0 = Date.UTC(2026, 9, 1, 12);
const HOUR = 3_600_000;

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** A cargo-ops.db exactly as a build that only knew migrations 1..`upTo` left it. */
function oldDatabase(dir, upTo, fill) {
  const { MIGRATIONS } = distModule("storage/migrations");
  const { DatabaseSync } = require_sqlite();
  wipe(dir);
  const db = new DatabaseSync(join(dir, "cargo-ops.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(
    "CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  for (const m of MIGRATIONS.filter((x) => x.version <= upTo)) {
    db.exec(m.sql);
    db.prepare("INSERT INTO schema_migrations VALUES (?, 0)").run(m.version);
  }
  fill(db);
  db.close();
  return MIGRATIONS.length;
}

function require_sqlite() {
  return distModule("storage/db").loadSqlite();
}

function schemaVersion(dir) {
  const { DatabaseSync } = require_sqlite();
  const db = new DatabaseSync(join(dir, "cargo-ops.db"), { readOnly: true });
  try {
    return db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v;
  } finally {
    db.close();
  }
}

async function withConnector(name, dataDir, port, fn) {
  const c = await startConnector({ name, port, dataDir, args: ["--sim", "simconnect"] });
  try {
    const token = await sessionToken(c.base);
    const status = await api(c.base, token, "GET", "/api/status");
    assertEqual(status.body.mode, "live", `${name}: live mode (career database)`);
    assert(
      status.body.database === join(dataDir.dir, "cargo-ops.db"),
      `${name}: database is ${status.body.database}`,
    );
    return await fn(c, token);
  } finally {
    await c.stop();
  }
}

async function exportJson(c, token) {
  const res = await api(c.base, token, "GET", "/api/export/json");
  assertEqual(res.status, 200, "GET /api/export/json");
  return res.body;
}

function withoutStamp(exported) {
  const { exportedAt: _ignored, ...rest } = exported;
  return rest;
}

run("career-windows", async () => {
  const port = Number(arg("--port", "4321"));
  const dataDir = ciDataDir("career");
  const dir = dataDir.dir;

  // 1. P3 install (schema 3) → current (PC-33).
  log("--- P3 cargo-ops.db (schema 3) → current schema");
  const latest = oldDatabase(dir, 3, (db) => {
    const p3Company = {
      name: "Cargo Ops Logistics",
      base: "KMEM",
      cash: 257_124,
      reputation: 52,
      seed: 4242,
      boardCounter: 2,
      boards: [],
      aircraftTypeOverride: null,
    };
    db.prepare("INSERT INTO company VALUES ('company', ?, 0)").run(JSON.stringify(p3Company));
    db.prepare(
      "INSERT INTO ledger (at, category, amount, ref_type, ref_id, memo) VALUES (?, 'job_payout', 7124, 'job', 'J-1', 'p3')",
    ).run(T0);
  });
  await withConnector("p3-migration", dataDir, port, async (c, token) => {
    const e = await exportJson(c, token);
    assertEqual(e.company?.cash, 257_124, "P3 cash kept");
    assertEqual(e.company?.startingCash, 250_000, "P3 company gets the P4 starting cash");
    assertEqual(e.fleet.length, 1, "P3 company is granted the starter aircraft");
    assertEqual(
      e.ledger.map((l) => l.category),
      ["mission_payout"],
      "job_payout → mission_payout",
    );
    assertEqual(e.ledger[0]?.balance, 257_124, "ledger balance backfilled");
  });
  assertEqual(schemaVersion(dir), latest, `cargo-ops.db migrated to schema ${latest}`);

  // 2. P4 install (schema 4) → current (PC-36).
  log("--- P4 cargo-ops.db (schema 4) → current schema");
  oldDatabase(dir, 4, (db) => {
    const p4Company = {
      name: "Cargo Ops Logistics",
      base: "KMEM",
      cash: 240_000,
      reputation: 55,
      seed: 4242,
      boardCounter: 1,
      boards: [],
      aircraftTypeOverride: null,
      startingCash: 250_000,
      gameMs: 5 * HOUR,
      monthBilled: 0,
      defaultUntilGameMs: null,
      fleetCounter: 1,
      loanCounter: 0,
      selectedAircraftId: null,
      pnl: [],
      ledgerCount: 1,
    };
    db.prepare("INSERT INTO company VALUES ('company', ?, 0)").run(JSON.stringify(p4Company));
    const p4Aircraft = {
      id: "AC-1",
      registration: "N123AB",
      typeKey: "c208b",
      ownership: "owned",
      status: "available",
      location: "KATL",
      hours: 42.5,
      cycles: 20,
      condition: 87.5,
      purchasePrice: 0,
      acquiredAt: T0,
      acquiredGameMs: 0,
      readyAtGameMs: null,
      loanId: null,
    };
    db.prepare(
      "INSERT INTO fleet (id, registration, type_key, ownership, status, location, condition, loan_id, acquired_at, json) VALUES ('AC-1', 'N123AB', 'c208b', 'owned', 'available', 'KATL', 87.5, NULL, ?, ?)",
    ).run(T0, JSON.stringify(p4Aircraft));
    db.prepare(
      "INSERT INTO ledger (at, category, amount, ref_type, ref_id, memo, balance, game_at) VALUES (?, 'repair', -10000, 'aircraft', 'AC-1', 'p4', 240000, 0)",
    ).run(T0);
  });
  await withConnector("p4-migration", dataDir, port, async (c, token) => {
    const e = await exportJson(c, token);
    assertEqual(e.company?.cash, 240_000, "P4 cash kept");
    assertEqual(e.fleet.find((a) => a.id === "AC-1")?.registration, "N123AB", "P4 aircraft kept");
    // The fleet domain is what the app shows (P5 fields are derived when the company loads).
    const fleet = await api(c.base, token, "GET", "/api/fleet");
    const ac = fleet.body.aircraft?.find((a) => a.id === "AC-1");
    assertEqual(ac?.systems?.length, 10, "P4 aircraft gets the 10 P5 systems");
    assert(
      ac?.systems?.every((s) => s.condition === 87.5),
      "systems start at the aircraft's condition",
    );
    const market = await api(c.base, token, "GET", "/api/market");
    assertEqual(market.body.listings?.length, 12, "the used market is generated (12 listings)");
  });
  assertEqual(schemaVersion(dir), latest, `cargo-ops.db migrated to schema ${latest}`);

  // 3 + 4. Fresh career: round trip, then v3 / v2 / v1 imports (PC-29, PC-33, PC-36).
  log("--- fresh career: export/import round trip and older export versions");
  wipe(dir);
  await withConnector("career-roundtrip", dataDir, port, async (c, token) => {
    const e1 = await exportJson(c, token);
    assertEqual(e1.format, "cargo-ops-career", "export format");
    assertEqual(e1.version, 5, "export is version 5");
    assertEqual(e1.database, "live", "export comes from the live database");
    assert(e1.company !== null, "a company exists");

    const imported = await api(c.base, token, "POST", "/api/import", e1);
    assertEqual(imported.status, 200, "POST /api/import of the export");
    const e2 = await exportJson(c, token);
    assertEqual(withoutStamp(e2), withoutStamp(e1), "export → import → export is identical");

    // Version 4 (P5 part 2, before transit cargo): no long-haul or in-transit jobs.
    const v4 = {
      ...e1,
      version: 4,
      company: { ...e1.company, name: "Imported V4 Co" },
      jobs: e1.jobs
        .filter((j) => j.status !== "in_transit")
        .map(({ longHaul: _lh, transit: _t, ...j }) => j),
      missions: e1.missions.map(({ transitJobIds: _tj, startedGameMs: _sg, ...m }) => m),
    };
    const r4 = await api(c.base, token, "POST", "/api/import", v4);
    assertEqual(r4.status, 200, "POST /api/import of a version 4 export");
    const after4 = await exportJson(c, token);
    assertEqual([after4.version, after4.company?.name], [5, "Imported V4 Co"], "v4 → current");

    // Version 3 (P5 part 1): no FBO keys; company and fleet without P5-part-2 fields.
    const {
      fboCounter: _f,
      dayProcessed: _d,
      activity: _a,
      flightHours: _h,
      deliveries: _del,
      landingStreak: _l,
      restorations: _r,
      milestones: _m,
      ...p5company
    } = e1.company;
    const v3 = {
      ...e1,
      version: 3,
      company: { ...p5company, name: "Imported V3 Co" },
      fbos: undefined,
      fboTransactions: undefined,
      demandEvents: undefined,
      fleet: e1.fleet.map(({ insurance: _i, incidents: _inc, ...p5 }) => p5),
    };
    const r3 = await api(c.base, token, "POST", "/api/import", v3);
    assertEqual(r3.status, 200, "POST /api/import of a version 3 export");
    const after3 = await exportJson(c, token);
    assertEqual([after3.version, after3.company?.name], [5, "Imported V3 Co"], "v3 → current");
    const fleet3 = await api(c.base, token, "GET", "/api/fleet");
    assertEqual(
      fleet3.body.aircraft?.[0]?.insurance?.insured,
      false,
      "v3 aircraft get default insurance",
    );

    // Version 2 (P4): no market, fleet rows without P5 fields.
    const {
      marketGeneration: _mg,
      marketRefreshedGameMs: _mr,
      orderCounter: _oc,
      ...p4company
    } = p5company;
    const v2 = {
      ...v3,
      version: 2,
      company: { ...p4company, name: "Imported V2 Co" },
      market: undefined,
      fleet: v3.fleet.map(
        ({ systems: _s, defects: _de, annual: _an, orders: _o, ferryPermit: _fp, ...p4 }) => p4,
      ),
    };
    const r2 = await api(c.base, token, "POST", "/api/import", v2);
    assertEqual(r2.status, 200, "POST /api/import of a version 2 export");
    const after2 = await exportJson(c, token);
    assertEqual([after2.version, after2.company?.name], [5, "Imported V2 Co"], "v2 → current");
    const fleet2 = await api(c.base, token, "GET", "/api/fleet");
    assertEqual(fleet2.body.aircraft?.[0]?.systems?.length, 10, "v2 aircraft get the P5 systems");

    // Version 1 (P3): company, jobs, missions, ledger, flights only.
    const v1 = {
      format: "cargo-ops-career",
      version: 1,
      exportedAt: new Date(T0).toISOString(),
      database: "live",
      company: {
        name: "Imported V1 Co",
        base: "KATL",
        cash: 251_000,
        reputation: 55,
        seed: 9,
        boardCounter: 1,
        boards: [],
        aircraftTypeOverride: null,
      },
      jobs: [],
      missions: [],
      ledger: [
        { at: T0, category: "job_payout", amount: 1_000, refType: "job", refId: "J", memo: null },
      ],
      flights: [],
    };
    const r1 = await api(c.base, token, "POST", "/api/import", v1);
    assertEqual(r1.status, 200, "POST /api/import of a version 1 export");
    const after1 = await exportJson(c, token);
    assertEqual([after1.version, after1.company?.name], [5, "Imported V1 Co"], "v1 → current");
    assertEqual(after1.company?.cash, 251_000, "v1 cash kept");
    assertEqual(after1.ledger[0]?.category, "mission_payout", "v1 job_payout → mission_payout");
    const fleet1 = await api(c.base, token, "GET", "/api/fleet");
    assertEqual(
      fleet1.body.aircraft?.[0]?.location,
      "KATL",
      "v1 company gets a starter at its base",
    );

    const bad = await api(c.base, token, "POST", "/api/import", { format: "nope" });
    assert(bad.status >= 400 && bad.status < 500, `an invalid document is refused (${bad.status})`);
  });
  // The career survives a restart from disk.
  await withConnector("career-restart", dataDir, port, async (c, token) => {
    const e = await exportJson(c, token);
    assertEqual(e.company?.name, "Imported V1 Co", "imported career persists across a restart");
  });
  assert(existsSync(join(dir, "cargo-ops.db")), `career database at ${join(dir, "cargo-ops.db")}`);
});
