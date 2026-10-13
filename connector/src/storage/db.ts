// Thin adapter over Node's built-in `node:sqlite` (DatabaseSync). No native
// addons. Live sessions use cargo-ops.db; demo/replay sessions use demo.db so a
// replay can never write into the career database (plan §3.2).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { MIGRATIONS } from "./migrations";

export type DatabaseKind = "live" | "demo";

export function databaseFileName(kind: DatabaseKind): string {
  return kind === "live" ? "cargo-ops.db" : "demo.db";
}

type SqliteModule = typeof import("node:sqlite");

/** Load node:sqlite lazily so an unsupported Node fails with a clear message. */
export function loadSqlite(): SqliteModule {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require("node:sqlite") as SqliteModule;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `node:sqlite is not available in Node ${process.versions.node} (${detail}). ` +
        "Cargo Ops needs Node 24 LTS (or Node 22.13 or newer).",
    );
  }
}

export interface Storage {
  readonly path: string;
  readonly kind: DatabaseKind;
  readonly db: DatabaseSyncType;
  schemaVersion(): number;
  journalMode(): string;
  getSetting<T = unknown>(key: string): T | undefined;
  setSetting(key: string, value: unknown): void;
  close(): void;
}

/** Apply pending migrations in order, each in its own transaction. Returns versions applied. */
export function migrate(db: DatabaseSyncType): number[] {
  db.exec(
    "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)",
  );
  const done = new Set(
    (db.prepare("SELECT version FROM schema_migrations").all() as { version: number }[]).map(
      (r) => r.version,
    ),
  );
  const applied: number[] = [];
  for (const migration of MIGRATIONS) {
    if (done.has(migration.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
        migration.version,
        Date.now(),
      );
      db.exec("COMMIT");
      applied.push(migration.version);
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration ${migration.version} failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return applied;
}

export function openStorage(dataDir: string, kind: DatabaseKind): Storage {
  const { DatabaseSync } = loadSqlite();
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, databaseFileName(kind));
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  let open = true;

  return {
    path,
    kind,
    db,
    schemaVersion() {
      const row = db.prepare("SELECT MAX(version) AS v FROM schema_migrations").get() as
        { v: number | null } | undefined;
      return row?.v ?? 0;
    },
    journalMode() {
      const row = db.prepare("PRAGMA journal_mode").get() as { journal_mode: string } | undefined;
      return row?.journal_mode ?? "unknown";
    },
    getSetting<T>(key: string): T | undefined {
      const row = db.prepare("SELECT json FROM settings WHERE key = ?").get(key) as
        { json: string } | undefined;
      return row ? (JSON.parse(row.json) as T) : undefined;
    },
    setSetting(key: string, value: unknown) {
      db.prepare(
        "INSERT INTO settings (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json",
      ).run(key, JSON.stringify(value));
    },
    close() {
      if (!open) return;
      open = false;
      db.close();
    },
  };
}
