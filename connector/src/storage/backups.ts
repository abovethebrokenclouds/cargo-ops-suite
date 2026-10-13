// Database backups (plan §3.3, P6): `VACUUM INTO <data-dir>/backups/<prefix>-YYYYMMDD.db`
// once a day while the connector runs, plus on-demand backups
// (`<prefix>-YYYYMMDD-HHMMSS.db`). Only the newest `keep` files of the current database are
// kept. The prefix is the database's own name (`cargo-ops` for the career database,
// `demo` for replays), so a replay never rotates career backups away.
//
// Restore is deliberately NOT done while the connector runs: stop the connector, copy a
// backup over the database file, delete the `-wal`/`-shm` files next to it, start again
// (docs/SETUP_WINDOWS.md §6).

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { DatabaseKind } from "./db";

export const DEFAULT_BACKUP_KEEP = 14;
/** How often the daily scheduler checks whether today's backup exists, ms. */
export const BACKUP_CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface BackupInfo {
  name: string;
  sizeBytes: number;
  /** ISO timestamp derived from the file name (UTC). */
  createdAt: string;
  kind: "daily" | "manual";
}

export function backupPrefix(kind: DatabaseKind): string {
  return kind === "live" ? "cargo-ops" : "demo";
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** `cargo-ops-20261013.db` (daily) or `cargo-ops-20261013-142501.db` (manual), UTC. */
export function backupFileName(kind: DatabaseKind, at: Date, manual: boolean): string {
  const day = `${at.getUTCFullYear()}${pad(at.getUTCMonth() + 1)}${pad(at.getUTCDate())}`;
  const time = `${pad(at.getUTCHours())}${pad(at.getUTCMinutes())}${pad(at.getUTCSeconds())}`;
  return `${backupPrefix(kind)}-${day}${manual ? `-${time}` : ""}.db`;
}

function namePattern(kind: DatabaseKind): RegExp {
  return new RegExp(`^${backupPrefix(kind)}-(\\d{8})(?:-(\\d{6}))?\\.db$`);
}

/** Parse a backup file name of this database kind; null for anything else. */
export function parseBackupName(
  kind: DatabaseKind,
  name: string,
): { createdAt: string; kind: "daily" | "manual" } | null {
  const m = namePattern(kind).exec(name);
  if (!m) return null;
  const d = m[1] as string;
  const t = m[2] ?? "000000";
  const iso = `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}T${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)}Z`;
  if (Number.isNaN(Date.parse(iso))) return null;
  return { createdAt: iso, kind: m[2] ? "manual" : "daily" };
}

/** Chronological sort key: the UTC stamp (a daily file counts as that day's 00:00:00). */
function sortKey(kind: DatabaseKind, name: string): string {
  const parsed = parseBackupName(kind, name);
  return parsed ? `${parsed.createdAt}|${parsed.kind === "daily" ? 0 : 1}|${name}` : name;
}

/** Oldest first. */
function chronological(kind: DatabaseKind, names: readonly string[]): string[] {
  return [...names].sort((a, b) => {
    const ka = sortKey(kind, a);
    const kb = sortKey(kind, b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

/**
 * Which backup files to delete so only the newest `keep` remain. Pure. Ordered by the UTC
 * stamp in the name (a daily file before that day's manual ones). `keep` < 1 keeps all.
 */
export function planRotation(kind: DatabaseKind, names: readonly string[], keep: number): string[] {
  if (!Number.isInteger(keep) || keep < 1) return [];
  const ours = chronological(
    kind,
    names.filter((n) => parseBackupName(kind, n) !== null),
  );
  return ours.slice(0, Math.max(0, ours.length - keep));
}

export function listBackups(dir: string, kind: DatabaseKind): BackupInfo[] {
  if (!existsSync(dir)) return [];
  const out: BackupInfo[] = [];
  for (const name of readdirSync(dir)) {
    const parsed = parseBackupName(kind, name);
    if (!parsed) continue;
    try {
      const st = statSync(join(dir, name));
      if (!st.isFile()) continue;
      out.push({ name, sizeBytes: st.size, ...parsed });
    } catch {
      // Vanished between readdir and stat.
    }
  }
  const order = chronological(
    kind,
    out.map((b) => b.name),
  ).reverse();
  return order.map((name) => out.find((b) => b.name === name) as BackupInfo);
}

export interface BackupManagerOptions {
  db: DatabaseSync;
  kind: DatabaseKind;
  dir: string;
  /** Newest files kept per database (default 14; < 1 keeps all). */
  keep?: number;
  now?: () => number;
}

export type BackupResult =
  | { ok: true; backup: BackupInfo; removed: string[] }
  | { ok: false; code: "backup_exists" | "backup_failed"; message: string };

export class BackupManager {
  readonly dir: string;
  readonly kind: DatabaseKind;
  readonly keep: number;
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  constructor(options: BackupManagerOptions) {
    this.db = options.db;
    this.kind = options.kind;
    this.dir = options.dir;
    this.keep = options.keep ?? DEFAULT_BACKUP_KEEP;
    this.now = options.now ?? Date.now;
  }

  list(): BackupInfo[] {
    return listBackups(this.dir, this.kind);
  }

  /** True when today's (UTC) daily file exists. */
  hasToday(): boolean {
    return existsSync(join(this.dir, backupFileName(this.kind, new Date(this.now()), false)));
  }

  /** Write a consistent copy with `VACUUM INTO`, then rotate. */
  create(manual: boolean): BackupResult {
    const name = backupFileName(this.kind, new Date(this.now()), manual);
    const target = join(this.dir, name);
    if (existsSync(target)) {
      return { ok: false, code: "backup_exists", message: `${name} already exists` };
    }
    const tmp = `${target}.partial`;
    try {
      mkdirSync(this.dir, { recursive: true });
      rmSync(tmp, { force: true });
      // VACUUM INTO takes an expression, so the path is bound, never spliced into SQL.
      this.db.prepare("VACUUM INTO ?").run(tmp);
      renameSync(tmp, target);
    } catch (err) {
      rmSync(tmp, { force: true });
      return {
        ok: false,
        code: "backup_failed",
        message: err instanceof Error ? err.message : String(err),
      };
    }
    const removed = this.rotate();
    const backup = this.list().find((b) => b.name === name);
    if (!backup) return { ok: false, code: "backup_failed", message: `${name} was not written` };
    return { ok: true, backup, removed };
  }

  /** Daily backup when today's file is missing; null when nothing was due. */
  daily(): BackupResult | null {
    if (this.hasToday()) return null;
    return this.create(false);
  }

  rotate(): string[] {
    const names = existsSync(this.dir) ? readdirSync(this.dir) : [];
    const doomed = planRotation(this.kind, names, this.keep);
    for (const name of doomed) rmSync(join(this.dir, name), { force: true });
    return doomed;
  }
}
