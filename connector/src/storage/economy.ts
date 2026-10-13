// Jobs, missions, company and ledger in SQLite (plan §3.3, migration 3). Same
// database as the flights: cargo-ops.db for live sessions, demo.db for replays.

import { z } from "zod";
import {
  jobSchema,
  missionSchema,
  touchdownSchema,
  type Job,
  type JobBoard,
  type JobStatus,
  type Mission,
  type Touchdown,
} from "../protocol";
import type { Storage } from "./db";

/** Persisted company record (the `company` domain plus generator state). */
export const companyRecordSchema = z.object({
  name: z.string().min(1),
  base: z.string().min(2).max(8),
  cash: z.number().finite(),
  reputation: z.number().finite().min(0).max(100),
  /** Seed for every job board of this company. */
  seed: z.number().int().nonnegative(),
  /** Boards generated so far (part of each board's seed). */
  boardCounter: z.number().int().nonnegative(),
  boards: z
    .array(
      z.object({
        origin: z.string(),
        generatedAt: z.string(),
        seed: z.number().int().nonnegative(),
        aircraftKey: z.string(),
        focus: z.string().optional(),
      }),
    )
    .default([]),
  /** Aircraft type override; null = auto-match from TITLE. */
  aircraftTypeOverride: z.string().nullable().default(null),
});
export type CompanyRecord = z.infer<typeof companyRecordSchema>;

export const LEDGER_CATEGORIES = ["job_payout", "adjustment"] as const;
export type LedgerCategory = (typeof LEDGER_CATEGORIES)[number] | (string & {});

export interface LedgerEntry {
  id?: number;
  at: number;
  category: LedgerCategory;
  amount: number;
  refType: string | null;
  refId: string | null;
  memo: string | null;
}

export interface LogbookEntry {
  id: string;
  status: string;
  source: string;
  startedAt: string | null;
  endedAt: string | null;
  origin: string | null;
  destination: string | null;
  aircraftTitle: string | null;
  distanceNm: number | null;
  blockMin: number | null;
  airborneMin: number | null;
  fuelUsedKg: number | null;
  payloadKg: number | null;
  landing: Touchdown | null;
  flags: Record<string, boolean> | null;
  mission: {
    id: string;
    status: string;
    origin: string;
    destination: string;
    payout: number | null;
    jobs: Array<{ id: string; kind: string; weightKg: number }>;
    failure: { code: string; message: string } | null;
  } | null;
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, text: string | null): T | null {
  if (text === null) return null;
  try {
    const r = schema.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

function parseLoose(text: string | null): Record<string, unknown> | null {
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());
const ms = (s: string | undefined) => (s ? Date.parse(s) : null);

export class EconomyRepo {
  constructor(private readonly storage: Storage) {}

  get db() {
    return this.storage.db;
  }

  getCompany(): CompanyRecord | null {
    const row = this.db.prepare("SELECT json FROM company WHERE id = 'company'").get() as
      { json: string } | undefined;
    return row ? parse(companyRecordSchema, row.json) : null;
  }

  saveCompany(company: CompanyRecord): void {
    this.db
      .prepare(
        `INSERT INTO company (id, json, updated_at) VALUES ('company', ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      )
      .run(JSON.stringify(company), Date.now());
  }

  saveJob(job: Job): void {
    this.db
      .prepare(
        `INSERT INTO jobs (id, status, origin, dest, cargo_kind, weight_kg, payout, deadline_at, json,
           created_at, mission_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, payout = excluded.payout,
           json = excluded.json, mission_id = excluded.mission_id`,
      )
      .run(
        job.id,
        job.status,
        job.origin,
        job.destination,
        job.kind,
        job.weightKg,
        job.payoutEstimate,
        ms(job.expiresAt),
        JSON.stringify(job),
        ms(job.createdAt),
        job.missionId ?? null,
      );
  }

  saveJobs(jobs: readonly Job[]): void {
    this.transaction(() => {
      for (const job of jobs) this.saveJob(job);
    });
  }

  deleteJobs(ids: readonly string[]): void {
    const del = this.db.prepare("DELETE FROM jobs WHERE id = ?");
    this.transaction(() => {
      for (const id of ids) del.run(id);
    });
  }

  listJobs(statuses: readonly JobStatus[]): Job[] {
    if (statuses.length === 0) return [];
    const marks = statuses.map(() => "?").join(", ");
    const rows = this.db
      .prepare(`SELECT json FROM jobs WHERE status IN (${marks}) ORDER BY created_at, id`)
      .all(...statuses) as Array<{ json: string }>;
    return rows.flatMap((r) => {
      const job = parse(jobSchema, r.json);
      return job ? [job] : [];
    });
  }

  saveMission(mission: Mission): void {
    this.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO missions (id, status, origin, dest, aircraft_type, flight_id, payload_kg, payout,
             created_at, started_at, ended_at, json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET status = excluded.status, flight_id = excluded.flight_id,
             payout = excluded.payout, started_at = excluded.started_at,
             ended_at = excluded.ended_at, json = excluded.json`,
        )
        .run(
          mission.id,
          mission.status,
          mission.origin,
          mission.destination,
          mission.aircraftKey,
          mission.flightId ?? null,
          mission.payloadKg,
          mission.payout?.total ?? null,
          ms(mission.createdAt) ?? Date.now(),
          ms(mission.startedAt),
          ms(mission.endedAt),
          JSON.stringify(mission),
        );
      const link = this.db.prepare(
        "INSERT OR IGNORE INTO mission_jobs (mission_id, job_id) VALUES (?, ?)",
      );
      for (const id of mission.jobIds) link.run(mission.id, id);
    });
  }

  deleteMission(id: string): void {
    this.db.prepare("DELETE FROM missions WHERE id = ?").run(id);
  }

  listMissions(limit = 50): Mission[] {
    const rows = this.db
      .prepare("SELECT json FROM missions ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(Math.max(1, Math.min(500, Math.floor(limit)))) as Array<{ json: string }>;
    return rows.flatMap((r) => {
      const m = parse(missionSchema, r.json);
      return m ? [m] : [];
    });
  }

  /** The open mission (loaded or in progress), if any. */
  openMission(): Mission | null {
    const row = this.db
      .prepare(
        "SELECT json FROM missions WHERE status IN ('loaded', 'in_progress') ORDER BY created_at DESC LIMIT 1",
      )
      .get() as { json: string } | undefined;
    return row ? parse(missionSchema, row.json) : null;
  }

  addLedger(entry: LedgerEntry): void {
    this.db
      .prepare(
        "INSERT INTO ledger (at, category, amount, ref_type, ref_id, memo, json) VALUES (?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(entry.at, entry.category, entry.amount, entry.refType, entry.refId, entry.memo);
  }

  listLedger(limit = 200): LedgerEntry[] {
    const rows = this.db
      .prepare(
        "SELECT id, at, category, amount, ref_type, ref_id, memo FROM ledger ORDER BY at DESC, id DESC LIMIT ?",
      )
      .all(Math.max(1, Math.min(10_000, Math.floor(limit)))) as Array<{
      id: number;
      at: number;
      category: string;
      amount: number;
      ref_type: string | null;
      ref_id: string | null;
      memo: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      category: r.category,
      amount: r.amount,
      refType: r.ref_type,
      refId: r.ref_id,
      memo: r.memo,
    }));
  }

  /** Record the jobs, payload and payout breakdown on the flight row. */
  linkFlight(flightId: string, jobIds: readonly string[], payloadKg: number, score: unknown): void {
    this.db
      .prepare("UPDATE flights SET job_ids = ?, payload_kg = ?, score_json = ? WHERE id = ?")
      .run(
        JSON.stringify(jobIds),
        payloadKg,
        score === null ? null : JSON.stringify(score),
        flightId,
      );
  }

  /** Flights (newest first) joined with the mission flown on them. */
  logbook(limit = 200): LogbookEntry[] {
    const rows = this.db
      .prepare(
        `SELECT f.id, f.status, f.source, f.started_at, f.ended_at, f.origin, f.dest, f.distance_nm,
           f.fuel_used_kg, f.payload_kg, f.landing_json, f.summary_json, m.json AS mission_json
         FROM flights f LEFT JOIN missions m ON m.flight_id = f.id
         ORDER BY f.started_at DESC, f.id DESC LIMIT ?`,
      )
      .all(Math.max(1, Math.min(5_000, Math.floor(limit)))) as Array<{
      id: string;
      status: string;
      source: string;
      started_at: number | null;
      ended_at: number | null;
      origin: string | null;
      dest: string | null;
      distance_nm: number | null;
      fuel_used_kg: number | null;
      payload_kg: number | null;
      landing_json: string | null;
      summary_json: string | null;
      mission_json: string | null;
    }>;
    return rows.map((r) => {
      const summary = parseLoose(r.summary_json);
      const mission = parse(missionSchema, r.mission_json);
      const num = (k: string) => (typeof summary?.[k] === "number" ? (summary[k] as number) : null);
      const flags = summary?.["flags"];
      return {
        id: r.id,
        status: r.status,
        source: r.source,
        startedAt: iso(r.started_at),
        endedAt: iso(r.ended_at),
        origin: r.origin,
        destination: r.dest,
        aircraftTitle:
          typeof summary?.["aircraftTitle"] === "string"
            ? (summary["aircraftTitle"] as string)
            : null,
        distanceNm: r.distance_nm,
        blockMin: num("blockMin"),
        airborneMin: num("airborneMin"),
        fuelUsedKg: r.fuel_used_kg,
        payloadKg: r.payload_kg ?? mission?.payloadKg ?? null,
        landing: parse(touchdownSchema, r.landing_json),
        flags:
          typeof flags === "object" && flags !== null ? (flags as Record<string, boolean>) : null,
        mission: mission
          ? {
              id: mission.id,
              status: mission.status,
              origin: mission.origin,
              destination: mission.destination,
              payout: mission.payout?.total ?? null,
              jobs: mission.jobs.map((j) => ({ id: j.id, kind: j.kind, weightKg: j.weightKg })),
              failure: mission.failure ?? null,
            }
          : null,
      };
    });
  }

  private depth = 0;

  /** Run `fn` in one transaction (nested calls join the outer one). */
  transaction(fn: () => void): void {
    if (this.depth > 0) {
      fn();
      return;
    }
    this.db.exec("BEGIN");
    this.depth++;
    try {
      fn();
      this.depth--;
      this.db.exec("COMMIT");
    } catch (err) {
      this.depth--;
      this.db.exec("ROLLBACK");
      throw err;
    }
  }
}

export type { JobBoard };
