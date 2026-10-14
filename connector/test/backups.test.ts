import assert from "node:assert/strict";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startConnector, type RunningConnector } from "../src/cli/app";
import { parseArgs } from "../src/cli/args";
import { FakeSource } from "../src/sim/fake-source";
import {
  BackupManager,
  backupFileName,
  parseBackupName,
  planRotation,
} from "../src/storage/backups";
import { loadSqlite, openStorage } from "../src/storage/db";
import { shortFixture, tempDir } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.UTC(2026, 9, 13, 14, 25, 1); // 2026-10-13 14:25:01 UTC

describe("backup names and rotation (pure)", () => {
  it("names daily and manual backups per database, in UTC", () => {
    assert.equal(backupFileName("live", new Date(T0), false), "cargo-ops-20261013.db");
    assert.equal(backupFileName("live", new Date(T0), true), "cargo-ops-20261013-142501.db");
    assert.equal(backupFileName("demo", new Date(T0), false), "demo-20261013.db");
    assert.deepEqual(parseBackupName("live", "cargo-ops-20261013-142501.db"), {
      createdAt: "2026-10-13T14:25:01Z",
      kind: "manual",
    });
    assert.equal(parseBackupName("live", "demo-20261013.db"), null);
    assert.equal(parseBackupName("live", "cargo-ops.db"), null);
    assert.equal(parseBackupName("live", "cargo-ops-20261013.db.partial"), null);
  });

  it("keeps the newest N of this database and never touches other files", () => {
    const names = [
      "cargo-ops-20261001.db",
      "cargo-ops-20261002.db",
      "cargo-ops-20261002-120000.db",
      "cargo-ops-20261003.db",
      "demo-20260901.db",
      "notes.txt",
      "cargo-ops.db",
    ];
    assert.deepEqual(planRotation("live", names, 2), [
      "cargo-ops-20261001.db",
      "cargo-ops-20261002.db",
    ]);
    assert.deepEqual(planRotation("live", names, 14), []);
    assert.deepEqual(planRotation("live", names, 0), [], "0 keeps everything");
    assert.deepEqual(planRotation("demo", names, 1), []);
  });

  it("never rotates away the file just written, even when it sorts oldest", () => {
    // Two manual backups earlier today, then a restart writes today's daily file, which sorts
    // before them (00:00:00). With keep 2 it must survive; the oldest manual one goes.
    const names = [
      "cargo-ops-20261003-090000.db",
      "cargo-ops-20261003-120000.db",
      "cargo-ops-20261003.db",
    ];
    assert.deepEqual(planRotation("live", names, 2, "cargo-ops-20261003.db"), [
      "cargo-ops-20261003-090000.db",
    ]);
    assert.deepEqual(planRotation("live", names, 1, "cargo-ops-20261003.db"), [
      "cargo-ops-20261003-090000.db",
      "cargo-ops-20261003-120000.db",
    ]);
    assert.deepEqual(planRotation("live", names, 2, "missing.db"), ["cargo-ops-20261003.db"]);
  });
});

describe("BackupManager (VACUUM INTO on node:sqlite)", () => {
  it("writes a consistent, openable copy, is daily-idempotent and rotates to keep", () => {
    const tmp = tempDir();
    let now = T0;
    const storage = openStorage(tmp.dir, "live");
    try {
      storage.setSetting("marker", { value: 42 });
      const dir = join(tmp.dir, "backups");
      const m = new BackupManager({ db: storage.db, kind: "live", dir, keep: 3, now: () => now });
      assert.equal(m.hasToday(), false);
      const first = m.daily();
      assert.ok(first?.ok);
      assert.equal(first.backup.name, "cargo-ops-20261013.db");
      assert.equal(first.backup.kind, "daily");
      assert.ok(first.backup.sizeBytes > 0);
      assert.equal(m.daily(), null, "a second daily run the same day does nothing");

      // The copy is a complete database with the data at backup time.
      const { DatabaseSync } = loadSqlite();
      const copy = new DatabaseSync(join(dir, first.backup.name), { readOnly: true });
      const row = copy.prepare("SELECT json FROM settings WHERE key = 'marker'").get() as
        { json: string } | undefined;
      copy.close();
      assert.equal(row?.json, JSON.stringify({ value: 42 }));

      // A manual backup in the same second is refused, not overwritten.
      assert.ok(m.create(true).ok);
      const again = m.create(true);
      assert.equal(again.ok, false);
      if (!again.ok) assert.equal(again.code, "backup_exists");

      // Days pass: only the newest 3 remain; foreign files are left alone.
      writeFileSync(join(dir, "README.txt"), "mine");
      for (let d = 1; d <= 4; d++) {
        now = T0 + d * DAY;
        const r = m.daily();
        assert.ok(r?.ok);
      }
      const names = m.list().map((b) => b.name);
      assert.deepEqual(names, [
        "cargo-ops-20261017.db",
        "cargo-ops-20261016.db",
        "cargo-ops-20261015.db",
      ]);
      assert.ok(existsSync(join(dir, "README.txt")));
      assert.ok(!readdirSync(dir).some((n) => n.endsWith(".partial")));
    } finally {
      storage.close();
      tmp.cleanup();
    }
  });
});

describe("backups through the connector", () => {
  async function start(dir: string, options: { daily?: boolean; keep?: number } = {}) {
    return startConnector({
      sim: "fake",
      dataDir: dir,
      port: 0,
      quiet: true,
      clockIntervalMs: 0,
      now: () => T0,
      ...(options.daily !== undefined ? { dailyBackups: options.daily } : {}),
      ...(options.keep !== undefined ? { backupKeep: options.keep } : {}),
      source: new FakeSource({ frames: shortFixture(), speed: 1, loop: false }),
    });
  }
  const api = (c: RunningConnector, path: string, init: RequestInit = {}) =>
    fetch(`${c.server.url}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${c.token}`, ...(init.headers ?? {}) },
    });

  it("GET/POST /api/backups behind the token; replays back up demo.db on demand only", async () => {
    const tmp = tempDir();
    const c = await start(tmp.dir);
    try {
      assert.equal((await fetch(`${c.server.url}/api/backups`)).status, 401);
      const empty = (await (await api(c, "/api/backups")).json()) as {
        backups: unknown[];
        keep: number;
        database: string;
        dir: string;
        restore: string[];
      };
      assert.deepEqual(empty.backups, [], "no daily backup for a replay");
      assert.equal(empty.keep, 14);
      assert.equal(empty.database, "demo");
      assert.equal(empty.dir, join(tmp.dir, "backups"));
      assert.ok(empty.restore.some((s) => s.includes("Stop the connector")));

      const created = await api(c, "/api/backups", { method: "POST" });
      assert.equal(created.status, 201);
      const body = (await created.json()) as { backup: { name: string; kind: string } };
      assert.equal(body.backup.name, "demo-20261013-142501.db");
      assert.equal(body.backup.kind, "manual");
      assert.equal((await api(c, "/api/backups", { method: "POST" })).status, 409);
      const list = (await (await api(c, "/api/backups")).json()) as {
        backups: Array<{ name: string }>;
      };
      assert.deepEqual(
        list.backups.map((b) => b.name),
        ["demo-20261013-142501.db"],
      );
      assert.equal((await api(c, "/api/backups", { method: "DELETE" })).status, 405);
    } finally {
      await c.stop();
      tmp.cleanup();
    }
  });

  it("runs the daily backup at start when enabled; --backup-keep parses", async () => {
    const tmp = tempDir();
    const c = await start(tmp.dir, { daily: true, keep: 5 });
    try {
      const list = (await (await api(c, "/api/backups")).json()) as {
        backups: Array<{ name: string; kind: string }>;
        keep: number;
      };
      assert.equal(list.keep, 5);
      assert.deepEqual(list.backups, [
        { ...list.backups[0], name: "demo-20261013.db", kind: "daily" },
      ]);
    } finally {
      await c.stop();
      tmp.cleanup();
    }
    const parsed = parseArgs(["--backup-keep", "30"]);
    assert.ok(parsed.ok && parsed.options.backupKeep === 30);
    const def = parseArgs([]);
    assert.ok(def.ok && def.options.backupKeep === 14);
    assert.equal(parseArgs(["--backup-keep", "-1"]).ok, false);
  });
});
