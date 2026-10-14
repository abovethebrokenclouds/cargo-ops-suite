import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { databaseFileName, loadSqlite, migrate, openStorage } from "../src/storage/db";
import { MIGRATIONS } from "../src/storage/migrations";
import { tempDir } from "./helpers";

const TABLES = [
  "aircraft",
  "company",
  "flights",
  "jobs",
  "ledger",
  "metar_cache",
  "mission_jobs",
  "missions",
  "schema_migrations",
  "settings",
  "telemetry",
];

describe("storage (node:sqlite)", () => {
  it("migration versions are unique and contiguous from 1 (no two branches share a number)", () => {
    const versions = MIGRATIONS.map((m) => m.version);
    assert.equal(new Set(versions).size, versions.length, `duplicate versions: ${versions}`);
    assert.deepEqual(
      versions,
      versions.map((_, i) => i + 1),
      `versions must run 1..${versions.length} in order: ${versions}`,
    );
  });

  it("node:sqlite loads on this Node version", () => {
    assert.equal(typeof loadSqlite().DatabaseSync, "function");
  });

  it("separates demo and live databases", () => {
    assert.equal(databaseFileName("live"), "cargo-ops.db");
    assert.equal(databaseFileName("demo"), "demo.db");
    const tmp = tempDir();
    try {
      const demo = openStorage(tmp.dir, "demo");
      demo.close();
      assert.ok(existsSync(join(tmp.dir, "demo.db")));
      assert.ok(!existsSync(join(tmp.dir, "cargo-ops.db")));
    } finally {
      tmp.cleanup();
    }
  });

  it("creates the §3.3 schema in WAL mode and migrations are idempotent", () => {
    const tmp = tempDir();
    try {
      const first = openStorage(tmp.dir, "live");
      assert.equal(first.journalMode(), "wal");
      assert.equal(first.schemaVersion(), MIGRATIONS.length);
      const tables = (
        first.db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
          .all() as { name: string }[]
      ).map((r) => r.name);
      for (const table of TABLES) assert.ok(tables.includes(table), `missing table ${table}`);
      first.setSetting("units", { speed: "kt" });
      // Running migrate again applies nothing.
      assert.deepEqual(migrate(first.db), []);
      first.close();

      const second = openStorage(tmp.dir, "live");
      assert.equal(second.schemaVersion(), MIGRATIONS.length);
      const rows = second.db.prepare("SELECT COUNT(*) AS n FROM schema_migrations").get() as {
        n: number;
      };
      assert.equal(rows.n, MIGRATIONS.length);
      assert.deepEqual(second.getSetting("units"), { speed: "kt" });
      assert.equal(second.getSetting("missing"), undefined);
      second.close();
      second.close(); // closing twice is harmless
    } finally {
      tmp.cleanup();
    }
  });

  it("enforces the flight source label", () => {
    const tmp = tempDir();
    try {
      const storage = openStorage(tmp.dir, "demo");
      const insert = storage.db.prepare(
        "INSERT INTO flights (id, status, source) VALUES (?, ?, ?)",
      );
      insert.run("f1", "active", "replay");
      assert.throws(() => insert.run("f2", "active", "made-up"));
      storage.close();
    } finally {
      tmp.cleanup();
    }
  });
});
