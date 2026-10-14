// Jobs, missions, company and ledger in SQLite (plan §3.3, migration 3). Same
// database as the flights: cargo-ops.db for live sessions, demo.db for replays.

import { z } from "zod";
import {
  DEMAND_EVENT_KINDS,
  FBO_MODULE_KINDS,
  MILESTONE_IDS,
  AIRCRAFT_STATUSES,
  LEDGER_CATEGORIES,
  LOAN_STATUSES,
  OWNERSHIPS,
  SYSTEM_KEYS,
  collateralSchema,
  defectSchema,
  ferryPermitSchema,
  maintenanceOrderSchema,
  jobSchema,
  missionSchema,
  pnlMonthSchema,
  touchdownSchema,
  type Job,
  type JobBoard,
  type JobStatus,
  type LedgerCategory,
  type Mission,
  type PayloadCheck,
  type PnlMonth,
  type Touchdown,
} from "../protocol";
import {
  CAPITAL_CATEGORIES,
  STARTING_CASH,
  gameMonthIndex,
  type AircraftEventRecord,
  type BookAircraftInput,
  type BookChanges,
  type BookLoan,
  type DemandEventRecord,
  type FboRecord,
  type FboTransactionRecord,
  type ListingRecord,
  type MilestoneRecord,
} from "../economy";
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
  /** Payload check pilot/crew allowance, kg; null = automatic (docs/ECONOMY.md). */
  crewAllowanceKg: z.number().finite().nonnegative().nullable().default(null),
  // ---- P4 (defaults make a P3 record valid) ----
  /** Cash the company was founded with; Σ ledger = cash − startingCash. */
  startingCash: z.number().finite().default(STARTING_CASH),
  /** Company clock (in-game time), ms since founding. */
  gameMs: z.number().finite().nonnegative().default(0),
  monthBilled: z.number().int().nonnegative().default(0),
  defaultUntilGameMs: z.number().finite().nonnegative().nullable().default(null),
  fleetCounter: z.number().int().nonnegative().default(0),
  loanCounter: z.number().int().nonnegative().default(0),
  selectedAircraftId: z.string().nullable().default(null),
  pnl: z.array(pnlMonthSchema).default([]),
  ledgerCount: z.number().int().nonnegative().default(0),
  // ---- P5 (defaults make a P4 record valid) ----
  marketGeneration: z.number().int().nonnegative().default(0),
  marketRefreshedGameMs: z.number().finite().nonnegative().default(0),
  orderCounter: z.number().int().nonnegative().default(0),
  // ---- P5 part 2 (defaults make a P5-part-1 record valid) ----
  fboCounter: z.number().int().nonnegative().default(0),
  /** Absent in older records: the book starts counting days from the company clock. */
  dayProcessed: z.number().int().nonnegative().optional(),
  activity: z.record(z.number().finite()).default({}),
  flightHours: z.number().finite().nonnegative().default(0),
  deliveries: z.number().int().nonnegative().default(0),
  landingStreak: z.number().int().nonnegative().default(0),
  restorations: z.number().int().nonnegative().default(0),
  milestones: z
    .array(
      z.object({
        id: z.enum(MILESTONE_IDS),
        gameMs: z.number().finite().nonnegative(),
        at: z.number().finite(),
      }),
    )
    .default([]),
});
export type CompanyRecord = z.infer<typeof companyRecordSchema>;

export { LEDGER_CATEGORIES };
export type { LedgerCategory };

export interface LedgerEntry {
  id?: number;
  at: number;
  /** Company-clock time, ms (0 for P3 rows). */
  gameMs?: number;
  category: LedgerCategory;
  amount: number;
  /** Cash after the entry (running balance). */
  balance?: number | null;
  refType: string | null;
  refId: string | null;
  memo: string | null;
}

const systemConditionsSchema = z.object(
  Object.fromEntries(SYSTEM_KEYS.map((k) => [k, z.number().finite().min(0).max(100)])) as Record<
    (typeof SYSTEM_KEYS)[number],
    z.ZodNumber
  >,
);

const bookAircraftSchema = z.object({
  id: z.string().min(1),
  registration: z.string().min(1),
  typeKey: z.string().min(1),
  ownership: z.enum(OWNERSHIPS),
  status: z.enum(AIRCRAFT_STATUSES),
  location: z.string().min(2).max(8),
  hours: z.number().finite().nonnegative(),
  cycles: z.number().int().nonnegative(),
  condition: z.number().finite().min(0).max(100),
  purchasePrice: z.number().finite().nonnegative(),
  acquiredAt: z.number().finite(),
  acquiredGameMs: z.number().finite().nonnegative(),
  readyAtGameMs: z.number().finite().nonnegative().nullable(),
  loanId: z.string().nullable(),
  // ---- P5 (absent in P4 rows; the book normalises them) ----
  ageYears: z.number().finite().nonnegative().optional(),
  systems: systemConditionsSchema.optional(),
  defects: z.array(defectSchema).optional(),
  annual: z
    .object({
      lastGameMs: z.number().finite().nonnegative(),
      lastHours: z.number().finite().nonnegative(),
    })
    .optional(),
  ferryPermit: ferryPermitSchema.nullable().optional(),
  orders: z.array(maintenanceOrderSchema).optional(),
  defectCounter: z.number().int().nonnegative().optional(),
  // ---- P5 part 2 (absent in older rows) ----
  insurance: z
    .object({
      sinceGameMs: z.number().finite().nonnegative(),
      premium: z.number().finite().nonnegative(),
      claims: z.number().int().nonnegative(),
      claimsPaid: z.number().finite().nonnegative(),
    })
    .nullable()
    .optional(),
  incidents: z
    .array(
      z.object({
        gameMs: z.number().finite().nonnegative(),
        kind: z.enum(["hard_landing", "crash"]),
      }),
    )
    .optional(),
});
export const fleetRecordSchema: z.ZodType<BookAircraftInput, z.ZodTypeDef, unknown> =
  bookAircraftSchema;

/** A used market listing as stored (hidden defects included). */
export const listingRecordSchema: z.ZodType<ListingRecord, z.ZodTypeDef, unknown> = z.object({
  id: z.string().min(1),
  generation: z.number().int().nonnegative(),
  typeKey: z.string().min(1),
  ageYears: z.number().finite().nonnegative(),
  hours: z.number().finite().nonnegative(),
  cycles: z.number().int().nonnegative(),
  location: z.string().min(2).max(8),
  systems: systemConditionsSchema,
  defects: z.array(defectSchema),
  askingPrice: z.number().finite().positive(),
  sellerNote: z.string(),
  listedGameMs: z.number().finite().nonnegative(),
  inspection: z.object({
    status: z.enum(["none", "pending", "done"]),
    fee: z.number().finite().nonnegative(),
    readyAtGameMs: z.number().finite().nonnegative().optional(),
    found: z.number().int().nonnegative().optional(),
  }),
  status: z.enum(["listed", "sold", "expired"]),
});

const moneyByKind = z.object({
  ramp: z.number().finite(),
  handling: z.number().finite(),
  fuel: z.number().finite(),
  cargo: z.number().finite(),
  maintenance: z.number().finite(),
  hangar: z.number().finite(),
});

const moduleRecordSchema = z.object({
  level: z.number().int().min(0).max(3),
  pending: z
    .object({
      toLevel: z.number().int().min(1).max(3),
      cost: z.number().finite().nonnegative(),
      readyAtGameMs: z.number().finite().nonnegative(),
    })
    .nullable(),
});

/** An FBO as stored (P5 part 2). */
export const fboRecordSchema: z.ZodType<FboRecord, z.ZodTypeDef, unknown> = z.object({
  id: z.string().min(1),
  icao: z.string().min(2).max(8),
  status: z.enum(["building", "active", "sold", "repossessed"]),
  origin: z.enum(["bought", "built"]),
  acquiredGameMs: z.number().finite().nonnegative(),
  acquiredAt: z.number().finite(),
  readyAtGameMs: z.number().finite().nonnegative().nullable(),
  builtAt: z.number().finite().nullable(),
  price: z.number().finite().nonnegative(),
  invested: z.number().finite().nonnegative(),
  landLeaseMonthly: z.number().finite().nonnegative(),
  modules: z.object(
    Object.fromEntries(FBO_MODULE_KINDS.map((k) => [k, moduleRecordSchema])) as Record<
      (typeof FBO_MODULE_KINDS)[number],
      typeof moduleRecordSchema
    >,
  ),
  fuelPriceRatio: z.number().finite().positive(),
  handlingFeeUsd: z.number().finite().nonnegative(),
  loanId: z.string().nullable(),
  nextHour: z.number().int().nonnegative(),
  today: z.object({
    day: z.number().int().nonnegative(),
    own: z.number().finite(),
    modelled: z.number().finite(),
    simAi: z.number().finite(),
    movements: z.number().int().nonnegative(),
    fuelKg: z.number().finite().nonnegative(),
    byKind: moneyByKind,
  }),
  daily: z.array(
    z.object({
      day: z.number().int().nonnegative(),
      own: z.number().finite(),
      modelled: z.number().finite(),
      simAi: z.number().finite(),
      movements: z.number().int().nonnegative(),
    }),
  ),
  pnl: z.array(
    z.object({
      month: z.number().int().nonnegative(),
      income: z.number().finite(),
      upkeep: z.number().finite().nonnegative(),
      savings: z.number().finite().nonnegative(),
      net: z.number().finite(),
    }),
  ),
  rented: z.number().int().nonnegative(),
  aiArrivals: z.number().int().nonnegative(),
  loungeDay: z.number().int(),
});

export const fboTransactionSchema: z.ZodType<FboTransactionRecord, z.ZodTypeDef, unknown> =
  z.object({
    fboId: z.string().min(1),
    at: z.number().finite(),
    gameMs: z.number().finite().nonnegative(),
    kind: z.string().min(1),
    amount: z.number().finite(),
    source: z.enum(["own", "modelled", "sim_ai"]),
    memo: z.string().nullable(),
  });

export const demandEventRecordSchema: z.ZodType<DemandEventRecord, z.ZodTypeDef, unknown> =
  z.object({
    id: z.string().min(1),
    icao: z.string().min(2).max(8),
    kind: z.enum(DEMAND_EVENT_KINDS),
    startGameMs: z.number().finite().nonnegative(),
    endGameMs: z.number().finite().nonnegative(),
  });

export const loanRecordSchema: z.ZodType<BookLoan, z.ZodTypeDef, unknown> = z.object({
  id: z.string().min(1),
  lenderId: z.string().min(1),
  principal: z.number().finite().positive(),
  apr: z.number().finite().nonnegative(),
  termMonths: z.number().int().positive(),
  payment: z.number().finite().nonnegative(),
  balance: z.number().finite().nonnegative(),
  collateral: collateralSchema,
  nextDueGameMs: z.number().finite().nonnegative(),
  missedCount: z.number().int().nonnegative(),
  paymentsMade: z.number().int().nonnegative(),
  status: z.enum(LOAN_STATUSES),
  takenAt: z.number().finite(),
  takenGameMs: z.number().finite().nonnegative(),
});

export interface AircraftEventRow extends AircraftEventRecord {
  id: number;
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
    /** Cargo vs sim payload, frozen at departure (absent on older missions). */
    payloadCheck: PayloadCheck | null;
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
           created_at, mission_id, location)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, payout = excluded.payout,
           json = excluded.json, mission_id = excluded.mission_id, location = excluded.location`,
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
        // Transit cargo: where the cargo is now (migration 8).
        job.transit?.location ?? job.origin,
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
        "INSERT INTO ledger (at, category, amount, ref_type, ref_id, memo, json, balance, game_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)",
      )
      .run(
        entry.at,
        entry.category,
        entry.amount,
        entry.refType,
        entry.refId,
        entry.memo,
        entry.balance ?? null,
        Math.floor(entry.gameMs ?? 0),
      );
  }

  /** Ledger rows, newest first (insertion order: the order cash changed). */
  listLedger(
    limit = 200,
    options: { beforeId?: number; category?: string } = {},
  ): Array<LedgerEntry & { id: number }> {
    const where: string[] = [];
    const args: Array<number | string> = [];
    if (options.beforeId !== undefined) {
      where.push("id < ?");
      args.push(options.beforeId);
    }
    if (options.category) {
      where.push("category = ?");
      args.push(options.category);
    }
    const rows = this.db
      .prepare(
        `SELECT id, at, game_at, category, amount, balance, ref_type, ref_id, memo FROM ledger
         ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, Math.max(1, Math.min(1_000_000, Math.floor(limit)))) as Array<{
      id: number;
      at: number;
      game_at: number | null;
      category: string;
      amount: number;
      balance: number | null;
      ref_type: string | null;
      ref_id: string | null;
      memo: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      at: r.at,
      gameMs: r.game_at ?? 0,
      category: r.category as LedgerCategory,
      amount: r.amount,
      balance: r.balance,
      refType: r.ref_type,
      refId: r.ref_id,
      memo: r.memo,
    }));
  }

  /** Σ amounts and the number of ledger rows. */
  ledgerTotals(): { sum: number; count: number } {
    const row = this.db
      .prepare("SELECT COALESCE(SUM(ROUND(amount * 100)), 0) AS cents, COUNT(*) AS n FROM ledger")
      .get() as { cents: number; n: number };
    return { sum: row.cents / 100, count: row.n };
  }

  /** Operating P&L per in-game month rebuilt from the ledger (P3 rows are month 0). */
  pnlFromLedger(): PnlMonth[] {
    const rows = this.db
      .prepare("SELECT game_at, category, amount FROM ledger ORDER BY id")
      .all() as Array<{ game_at: number | null; category: string; amount: number }>;
    const months = new Map<number, PnlMonth>();
    for (const r of rows) {
      if (CAPITAL_CATEGORIES.has(r.category as LedgerCategory) || r.amount === 0) continue;
      const month = gameMonthIndex(r.game_at ?? 0);
      const m = months.get(month) ?? { month, revenue: 0, expense: 0, net: 0 };
      if (r.amount > 0) m.revenue = Math.round((m.revenue + r.amount) * 100) / 100;
      else m.expense = Math.round((m.expense - r.amount) * 100) / 100;
      m.net = Math.round((m.revenue - m.expense) * 100) / 100;
      months.set(month, m);
    }
    return [...months.values()].sort((a, b) => a.month - b.month).slice(-24);
  }

  // ---- fleet, loans, aircraft events (P4) ----

  saveAircraft(a: BookAircraftInput): void {
    this.db
      .prepare(
        `INSERT INTO fleet (id, registration, type_key, ownership, status, location, condition, loan_id,
           acquired_at, json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET registration = excluded.registration, type_key = excluded.type_key,
           ownership = excluded.ownership, status = excluded.status, location = excluded.location,
           condition = excluded.condition, loan_id = excluded.loan_id, json = excluded.json`,
      )
      .run(
        a.id,
        a.registration,
        a.typeKey,
        a.ownership,
        a.status,
        a.location,
        a.condition,
        a.loanId,
        Math.floor(a.acquiredAt),
        JSON.stringify(a),
      );
  }

  listFleet(): BookAircraftInput[] {
    const rows = this.db.prepare("SELECT json FROM fleet ORDER BY acquired_at, id").all() as Array<{
      json: string;
    }>;
    return rows.flatMap((r) => {
      const a = parse(fleetRecordSchema, r.json);
      return a ? [a] : [];
    });
  }

  saveLoan(l: BookLoan): void {
    this.db
      .prepare(
        `INSERT INTO loans (id, lender, principal, apr, term_months, payment, balance, collateral_type,
           collateral_id, next_due_at, missed_count, status, json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET apr = excluded.apr, term_months = excluded.term_months,
           payment = excluded.payment, balance = excluded.balance, next_due_at = excluded.next_due_at,
           missed_count = excluded.missed_count, status = excluded.status, json = excluded.json`,
      )
      .run(
        l.id,
        l.lenderId,
        l.principal,
        l.apr,
        l.termMonths,
        l.payment,
        l.balance,
        l.collateral.type,
        l.collateral.id,
        Math.floor(l.nextDueGameMs),
        l.missedCount,
        l.status,
        JSON.stringify(l),
      );
  }

  listLoans(): BookLoan[] {
    const rows = this.db.prepare("SELECT json FROM loans ORDER BY id").all() as Array<{
      json: string;
    }>;
    return rows.flatMap((r) => {
      const l = parse(loanRecordSchema, r.json);
      return l ? [l] : [];
    });
  }

  // ---- used market (P5) ----

  saveListing(l: ListingRecord): void {
    if (l.status !== "listed") {
      this.db.prepare("DELETE FROM market_listings WHERE id = ?").run(l.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO market_listings (id, generation, type_key, location, asking_price, inspection, json)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET inspection = excluded.inspection, json = excluded.json`,
      )
      .run(
        l.id,
        l.generation,
        l.typeKey,
        l.location,
        l.askingPrice,
        l.inspection.status,
        JSON.stringify(l),
      );
  }

  listListings(): ListingRecord[] {
    const rows = this.db
      .prepare("SELECT json FROM market_listings ORDER BY generation, id")
      .all() as Array<{ json: string }>;
    return rows.flatMap((r) => {
      const l = parse(listingRecordSchema, r.json);
      return l ? [l] : [];
    });
  }

  // ---- FBOs, demand, insurance, milestones (P5 part 2) ----

  saveFbo(f: FboRecord): void {
    this.db
      .prepare(
        `INSERT INTO fbos (id, icao, status, built_at, json) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET status = excluded.status, built_at = excluded.built_at,
           json = excluded.json`,
      )
      .run(
        f.id,
        f.icao,
        f.status,
        f.builtAt === null ? null : Math.floor(f.builtAt),
        JSON.stringify(f),
      );
    const mod = this.db.prepare(
      `INSERT INTO fbo_modules (fbo_id, kind, level, json) VALUES (?, ?, ?, ?)
       ON CONFLICT(fbo_id, kind) DO UPDATE SET level = excluded.level, json = excluded.json`,
    );
    for (const k of FBO_MODULE_KINDS) {
      const m = f.modules[k];
      mod.run(f.id, k, m.level, JSON.stringify(m));
    }
  }

  listFbos(): FboRecord[] {
    const rows = this.db.prepare("SELECT json FROM fbos ORDER BY id").all() as Array<{
      json: string;
    }>;
    return rows.flatMap((r) => {
      const f = parse(fboRecordSchema, r.json);
      return f ? [f] : [];
    });
  }

  addFboTransaction(t: FboTransactionRecord): void {
    this.db
      .prepare(
        "INSERT INTO fbo_transactions (fbo_id, at, game_at, kind, amount, source, memo) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(t.fboId, Math.floor(t.at), Math.floor(t.gameMs), t.kind, t.amount, t.source, t.memo);
  }

  /** FBO transactions, oldest first (optionally one FBO, the last `limit`). */
  listFboTransactions(
    options: { fboId?: string; limit?: number } = {},
  ): Array<FboTransactionRecord & { id: number }> {
    const limit = Math.max(1, Math.min(1_000_000, Math.floor(options.limit ?? 1_000_000)));
    const rows = (
      options.fboId
        ? this.db
            .prepare(
              "SELECT id, fbo_id, at, game_at, kind, amount, source, memo FROM fbo_transactions WHERE fbo_id = ? ORDER BY id DESC LIMIT ?",
            )
            .all(options.fboId, limit)
        : this.db
            .prepare(
              "SELECT id, fbo_id, at, game_at, kind, amount, source, memo FROM fbo_transactions ORDER BY id DESC LIMIT ?",
            )
            .all(limit)
    ) as Array<{
      id: number;
      fbo_id: string;
      at: number;
      game_at: number;
      kind: string;
      amount: number;
      source: "own" | "modelled" | "sim_ai";
      memo: string | null;
    }>;
    return rows.reverse().map((r) => ({
      id: r.id,
      fboId: r.fbo_id,
      at: r.at,
      gameMs: r.game_at,
      kind: r.kind,
      amount: r.amount,
      source: r.source,
      memo: r.memo,
    }));
  }

  saveDemandEvent(e: DemandEventRecord): void {
    this.db
      .prepare(
        `INSERT INTO demand_events (id, icao, kind, start_at, end_at, json) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET end_at = excluded.end_at, json = excluded.json`,
      )
      .run(
        e.id,
        e.icao,
        e.kind,
        Math.floor(e.startGameMs),
        Math.floor(e.endGameMs),
        JSON.stringify(e),
      );
  }

  /** Demand events that ended after `sinceGameMs` (the book keeps the last 30 days). */
  listDemandEvents(sinceGameMs = 0): DemandEventRecord[] {
    const rows = this.db
      .prepare("SELECT json FROM demand_events WHERE end_at > ? ORDER BY start_at, id")
      .all(Math.floor(sinceGameMs)) as Array<{ json: string }>;
    return rows.flatMap((r) => {
      const e = parse(demandEventRecordSchema, r.json);
      return e ? [e] : [];
    });
  }

  saveDemandActivity(activity: Record<string, number>): void {
    this.db.exec("DELETE FROM demand_index");
    const ins = this.db.prepare("INSERT INTO demand_index (icao, activity) VALUES (?, ?)");
    for (const [icao, v] of Object.entries(activity)) ins.run(icao, v);
  }

  saveInsurance(a: BookAircraftInput): void {
    if (!a.insurance || a.status === "sold" || a.status === "returned") {
      this.db.prepare("DELETE FROM insurance_policies WHERE aircraft_id = ?").run(a.id);
      return;
    }
    this.db
      .prepare(
        `INSERT INTO insurance_policies (aircraft_id, status, premium, json) VALUES (?, ?, ?, ?)
         ON CONFLICT(aircraft_id) DO UPDATE SET status = excluded.status, premium = excluded.premium,
           json = excluded.json`,
      )
      .run(
        a.id,
        a.status === "written_off" ? "claimed" : "active",
        a.insurance.premium,
        JSON.stringify(a.insurance),
      );
  }

  saveMilestone(m: MilestoneRecord): void {
    this.db
      .prepare("INSERT OR IGNORE INTO milestones (id, game_at, at) VALUES (?, ?, ?)")
      .run(m.id, Math.floor(m.gameMs), Math.floor(m.at));
  }

  addAircraftEvent(e: AircraftEventRecord): void {
    this.db
      .prepare(
        "INSERT INTO aircraft_events (aircraft_id, at, game_at, kind, json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(e.aircraftId, Math.floor(e.at), Math.floor(e.gameMs), e.kind, JSON.stringify(e.data));
  }

  listAircraftEvents(limit = 1_000_000): AircraftEventRow[] {
    const rows = this.db
      .prepare(
        "SELECT id, aircraft_id, at, game_at, kind, json FROM aircraft_events ORDER BY id LIMIT ?",
      )
      .all(Math.max(1, Math.floor(limit))) as Array<{
      id: number;
      aircraft_id: string;
      at: number;
      game_at: number;
      kind: string;
      json: string | null;
    }>;
    return rows.map((r) => ({
      id: r.id,
      aircraftId: r.aircraft_id,
      at: r.at,
      gameMs: r.game_at,
      kind: r.kind,
      data: parseLoose(r.json) ?? {},
    }));
  }

  /** Persist what the company book changed, in one transaction. */
  persistBook(company: CompanyRecord, changes: BookChanges): void {
    this.transaction(() => {
      if (changes.company || changes.ledger.length > 0) this.saveCompany(company);
      for (const e of changes.ledger) this.addLedger(e);
      for (const a of changes.aircraft) {
        this.saveAircraft(a);
        this.saveInsurance(a);
      }
      for (const l of changes.loans) this.saveLoan(l);
      for (const e of changes.events) this.addAircraftEvent(e);
      for (const l of changes.listings) this.saveListing(l);
      for (const f of changes.fbos) this.saveFbo(f);
      for (const t of changes.fboTransactions) this.addFboTransaction(t);
      for (const e of changes.demandEvents) this.saveDemandEvent(e);
      if (changes.activity) this.saveDemandActivity(company.activity);
      for (const m of changes.milestones) this.saveMilestone(m);
    });
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
              payloadCheck: mission.payloadCheck ?? null,
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
