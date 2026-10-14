#!/usr/bin/env node
// W-44 (PC-44 without MSFS): career database backups through the REAL connector build in live
// mode (`--sim simconnect --backup-keep 2`, cargo-ops.db). On Windows the data directory is the
// default %LOCALAPPDATA%\CargoOps, so the backups land in %LOCALAPPDATA%\CargoOps\backups.
//
//   1. the daily backup cargo-ops-YYYYMMDD.db (UTC) is written at connector start
//   2. "Back up now" (POST /api/backups, what Settings → Data calls) adds -HHMMSS files
//   3. --backup-keep 2 rotates to the newest 2 files on disk
//   4. after a restart the new daily file survives rotation even though it sorts before that
//      day's manual backups (it is the file just written): daily + newest manual remain
//   5. the documented restore steps (stop, copy a backup over cargo-ops.db, delete -wal/-shm,
//      start) bring the backed-up career back, while Windows file locking is in play
//
//   node scripts/ci/backups-windows.mjs [--port 4322]

import { copyFileSync, existsSync, readdirSync, rmSync } from "node:fs";
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
  sleep,
  startConnector,
} from "./lib.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const ARGS = ["--sim", "simconnect", "--backup-keep", "2"];

function utcDay(at = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}`;
}

function filesIn(dir) {
  return existsSync(dir)
    ? readdirSync(dir)
        .filter((n) => n.startsWith("cargo-ops-"))
        .sort()
    : [];
}

/** Open a backup read-only and return its company name (proves it is a usable database). */
function companyIn(file) {
  const { DatabaseSync } = distModule("storage/db").loadSqlite();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const row = db.prepare("SELECT json FROM company WHERE id = 'company'").get();
    return row ? JSON.parse(row.json).name : null;
  } finally {
    db.close();
  }
}

/** POST /api/backups, retrying once a second apart when the -HHMMSS name already exists. */
async function backUpNow(base, token) {
  for (let i = 0; i < 5; i++) {
    const res = await api(base, token, "POST", "/api/backups");
    if (res.status === 201) return res.body;
    assertEqual(res.body?.error, "backup_exists", "only backup_exists may refuse (same second)");
    await sleep(1_100);
  }
  throw new Error("POST /api/backups kept answering backup_exists");
}

run("backups-windows", async () => {
  const port = Number(arg("--port", "4322"));
  const dataDir = ciDataDir("backups");
  const dir = dataDir.dir;
  const backupsDir = join(dir, "backups");
  const dbFile = join(dir, "cargo-ops.db");

  let original;
  let restoreFrom;
  let newestManual;
  {
    const c = await startConnector({ name: "backups", port, dataDir, args: ARGS });
    try {
      const token = await sessionToken(c.base);
      const daily = `cargo-ops-${utcDay()}.db`;
      assert(
        existsSync(join(backupsDir, daily)),
        `daily backup ${join(backupsDir, daily)} at start`,
      );
      const listed = await api(c.base, token, "GET", "/api/backups");
      assertEqual(listed.status, 200, "GET /api/backups");
      assertEqual(listed.body.dir, backupsDir, "backups folder is <data-dir>\\backups");
      assertEqual(listed.body.keep, 2, "--backup-keep 2 reaches the backup manager");
      assertEqual(listed.body.database, "live", "the career database is backed up");
      assertEqual(
        listed.body.backups.map((b) => [b.name, b.kind]),
        [[daily, "daily"]],
        "the daily file is listed",
      );
      assertEqual(listed.body.restore.length, 5, "restore steps are offered");

      original = (await api(c.base, token, "GET", "/api/export/json")).body;
      const first = await backUpNow(c.base, token);
      assert(/^cargo-ops-\d{8}-\d{6}\.db$/.test(first.backup.name), `manual ${first.backup.name}`);
      assertEqual(first.backup.kind, "manual", "Back up now writes a manual backup");
      assertEqual(first.removed, [], "two files: nothing rotated yet");
      await sleep(1_100);
      const second = await backUpNow(c.base, token);
      assertEqual(second.removed, [daily], "third file rotates the daily one away");
      await sleep(1_100);
      const third = await backUpNow(c.base, token);
      assertEqual(third.removed, [first.backup.name], "fourth file rotates the oldest manual");
      assertEqual(
        filesIn(backupsDir),
        [second.backup.name, third.backup.name].sort(),
        "exactly the newest 2 backups remain on disk",
      );
      restoreFrom = join(backupsDir, third.backup.name);
      newestManual = third.backup.name;
      assertEqual(companyIn(restoreFrom), original.company.name, "the backup opens read-only");

      // Change the career after the backup, so the restore has something to undo.
      const changed = {
        ...original,
        company: { ...original.company, name: "Changed After Backup" },
      };
      const imported = await api(c.base, token, "POST", "/api/import", changed);
      assertEqual(imported.status, 200, "career changed after the backup");
    } finally {
      await c.stop();
    }
  }

  // Restore steps exactly as /api/backups and docs/SETUP_WINDOWS.md list them.
  log("--- restore: stop, copy the backup over cargo-ops.db, delete -wal/-shm, start");
  copyFileSync(dbFile, `${dbFile}.before-restore`);
  copyFileSync(restoreFrom, dbFile);
  for (const suffix of ["-wal", "-shm"]) rmSync(`${dbFile}${suffix}`, { force: true });
  {
    const c = await startConnector({ name: "backups-restored", port, dataDir, args: ARGS });
    try {
      const token = await sessionToken(c.base);
      const restored = (await api(c.base, token, "GET", "/api/export/json")).body;
      assertEqual(restored.company?.name, original.company.name, "the backed-up career is back");
      const { exportedAt: _a, ...want } = original;
      const { exportedAt: _b, ...got } = restored;
      assertEqual(got, want, "restored export equals the export taken before the backup");
      // The daily file was rotated away above, so this start writes a new one. It sorts before
      // today's manual backups, yet it is the file just written and must survive --backup-keep 2.
      const daily = `cargo-ops-${utcDay()}.db`;
      const listed = await api(c.base, token, "GET", "/api/backups");
      assertEqual(listed.body.backups.length, 2, "rotation still keeps 2 after the restart");
      assertEqual(
        listed.body.backups.map((b) => [b.name, b.kind]).sort(),
        [
          [daily, "daily"],
          [newestManual, "manual"],
        ].sort(),
        "the daily file written at restart survives; the newest manual one stays",
      );
      assertEqual(
        filesIn(backupsDir),
        [daily, newestManual].sort(),
        "on disk: the new daily file and the newest manual backup",
      );
      assertEqual(companyIn(join(backupsDir, daily)), original.company.name, "daily file opens");
    } finally {
      await c.stop();
    }
  }
});
