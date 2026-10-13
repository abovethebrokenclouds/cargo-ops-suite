// Logbook exports (CSV, GPX) and the JSON career export/import (plan §3.3, P3).
// Small hand-written writers: no dependency.

import { z } from "zod";
import { jobSchema, missionSchema } from "../protocol";
import type { DatabaseKind } from "./db";
import { STARTING_CASH } from "../economy";
import { ledgerCategorySchema } from "../protocol";
import {
  companyRecordSchema,
  fleetRecordSchema,
  listingRecordSchema,
  loanRecordSchema,
  type EconomyRepo,
  type LogbookEntry,
} from "./economy";
import type { FlightTrack } from "./flights";

// ---- CSV ----

export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "number" ? String(value) : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const LOGBOOK_CSV_COLUMNS = [
  "date",
  "flight_id",
  "status",
  "source",
  "origin",
  "destination",
  "aircraft",
  "distance_nm",
  "block_min",
  "airborne_min",
  "fuel_used_kg",
  "payload_kg",
  "landing_grade",
  "landing_rate_fpm",
  "landing_peak_g",
  "mission_id",
  "mission_status",
  "payout_usd",
] as const;

export function logbookCsv(entries: readonly LogbookEntry[]): string {
  const lines = [LOGBOOK_CSV_COLUMNS.join(",")];
  for (const e of entries) {
    lines.push(
      [
        e.startedAt,
        e.id,
        e.status,
        e.source,
        e.origin,
        e.destination,
        e.aircraftTitle,
        e.distanceNm,
        e.blockMin,
        e.airborneMin,
        e.fuelUsedKg,
        e.payloadKg,
        e.landing?.grade,
        e.landing?.rateFpm,
        e.landing?.peakG,
        e.mission?.id,
        e.mission?.status,
        e.mission?.payout,
      ]
        .map(csvField)
        .join(","),
    );
  }
  return lines.join("\r\n") + "\r\n";
}

// ---- GPX 1.1 ----

function xml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const FT_TO_M = 0.3048;

/**
 * GPX track of one flight from the telemetry table. Point times are the flight's
 * wall-clock start plus the simulator time since block-out (pauses excluded), so a
 * compressed replay produces simulator-time stamps, not the replay's wall clock.
 */
export function flightGpx(
  track: FlightTrack,
  meta: {
    origin: string | null;
    destination: string | null;
    startedAt: string | null;
    source: string;
  },
): string {
  const start = meta.startedAt ? Date.parse(meta.startedAt) : 0;
  const name = `${meta.origin ?? "????"} → ${meta.destination ?? "????"}`;
  const points = track.points.flatMap((p) => {
    const lat = p["lat"];
    const lon = p["lon"];
    if (typeof lat !== "number" || typeof lon !== "number") return [];
    const alt = p["altFt"];
    const ele = typeof alt === "number" ? `<ele>${(alt * FT_TO_M).toFixed(1)}</ele>` : "";
    const time = start ? `<time>${new Date(start + p.t).toISOString()}</time>` : "";
    return [`      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">${ele}${time}</trkpt>`];
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Cargo Ops" xmlns="http://www.topografix.com/GPX/1/1">',
    "  <metadata>",
    `    <name>${xml(name)}</name>`,
    `    <desc>${xml(`Cargo Ops flight ${track.id} (${meta.source}); times are simulator time since block-out`)}</desc>`,
    ...(start ? [`    <time>${new Date(start).toISOString()}</time>`] : []),
    "  </metadata>",
    "  <trk>",
    `    <name>${xml(name)}</name>`,
    `    <type>${xml(meta.source)}</type>`,
    "    <trkseg>",
    ...points,
    "    </trkseg>",
    "  </trk>",
    "</gpx>",
    "",
  ].join("\n");
}

// ---- JSON career export / import ----

const flightRowSchema = z.object({
  id: z.string().min(1).max(64),
  started_at: z.number().int().nullable(),
  ended_at: z.number().int().nullable(),
  origin: z.string().nullable(),
  dest: z.string().nullable(),
  aircraft_id: z.string().nullable(),
  job_ids: z.string().nullable(),
  payload_kg: z.number().nullable(),
  distance_nm: z.number().nullable(),
  fuel_used_kg: z.number().nullable(),
  landing_json: z.string().nullable(),
  score_json: z.string().nullable(),
  summary_json: z.string().nullable(),
  status: z.string().min(1),
  source: z.enum(["sim", "replay", "demo"]),
});

const ledgerRowSchema = z.object({
  at: z.number().int(),
  /** P3 exports use `job_payout`, imported as `mission_payout`. */
  category: z
    .string()
    .min(1)
    .transform((c) => (c === "job_payout" ? "mission_payout" : c))
    .pipe(ledgerCategorySchema),
  amount: z.number().finite(),
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  memo: z.string().nullable(),
  // P4 (absent in version 1 exports).
  gameMs: z.number().finite().nonnegative().optional(),
  balance: z.number().finite().nullable().optional(),
});

const aircraftEventRowSchema = z.object({
  aircraftId: z.string().min(1),
  at: z.number().finite(),
  gameMs: z.number().finite().nonnegative(),
  kind: z.string().min(1),
  data: z.record(z.unknown()),
});

export const CAREER_FORMAT = "cargo-ops-career";
/**
 * Version 3 (P5) adds the used market's listings (and fleet rows carry systems, defects,
 * annual, ferry permit and maintenance orders); version 2 (P4) adds fleet, loans and
 * aircraft events; versions 1 and 2 are still accepted.
 */
export const CAREER_VERSION = 3;

export const careerExportSchema = z.object({
  format: z.literal(CAREER_FORMAT),
  version: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  exportedAt: z.string(),
  database: z.enum(["live", "demo"]),
  company: companyRecordSchema.nullable(),
  jobs: z.array(jobSchema),
  missions: z.array(missionSchema),
  ledger: z.array(ledgerRowSchema),
  flights: z.array(flightRowSchema),
  fleet: z.array(fleetRecordSchema).default([]),
  loans: z.array(loanRecordSchema).default([]),
  aircraftEvents: z.array(aircraftEventRowSchema).default([]),
  market: z.array(listingRecordSchema).default([]),
});
export type CareerExport = z.infer<typeof careerExportSchema>;
export type CareerExportInput = z.input<typeof careerExportSchema>;

const FLIGHT_COLUMNS = [
  "id",
  "started_at",
  "ended_at",
  "origin",
  "dest",
  "aircraft_id",
  "job_ids",
  "payload_kg",
  "distance_nm",
  "fuel_used_kg",
  "landing_json",
  "score_json",
  "summary_json",
  "status",
  "source",
] as const;

/** Everything except telemetry (tracks stay in the database; GPX exports them). */
export function exportCareer(
  repo: EconomyRepo,
  database: DatabaseKind,
  now = Date.now(),
): CareerExport {
  const db = repo.db;
  const jobs = (
    db.prepare("SELECT json FROM jobs ORDER BY created_at, id").all() as Array<{ json: string }>
  ).flatMap((r) => {
    const p = jobSchema.safeParse(JSON.parse(r.json));
    return p.success ? [p.data] : [];
  });
  const missions = (
    db.prepare("SELECT json FROM missions ORDER BY created_at, id").all() as Array<{ json: string }>
  ).flatMap((r) => {
    const p = missionSchema.safeParse(JSON.parse(r.json));
    return p.success ? [p.data] : [];
  });
  const ledger = repo
    .listLedger(1_000_000)
    .reverse()
    .map((e) => ({
      at: e.at,
      category: e.category,
      amount: e.amount,
      refType: e.refType,
      refId: e.refId,
      memo: e.memo,
      gameMs: e.gameMs ?? 0,
      balance: e.balance ?? null,
    }));
  const flights = db
    .prepare(`SELECT ${FLIGHT_COLUMNS.join(", ")} FROM flights ORDER BY started_at, id`)
    .all() as unknown as CareerExport["flights"];
  return {
    format: CAREER_FORMAT,
    version: CAREER_VERSION,
    exportedAt: new Date(now).toISOString(),
    database,
    company: repo.getCompany(),
    jobs,
    missions,
    ledger,
    flights,
    fleet: repo.listFleet(),
    loans: repo.listLoans(),
    aircraftEvents: repo.listAircraftEvents().map(({ id: _id, ...e }) => e),
    market: repo.listListings(),
  };
}

export type ImportResult =
  | {
      ok: true;
      counts: {
        jobs: number;
        missions: number;
        ledger: number;
        flights: number;
        fleet: number;
        loans: number;
        market: number;
      };
      version: 1 | 2 | 3;
    }
  | { ok: false; status: number; code: string; message: string };

/**
 * Replace the career tables of this database with an export. Flights are upserted
 * (their telemetry is kept); flights missing from the export are deleted. The live
 * database only accepts flights recorded from the simulator (source "sim").
 */
export function importCareer(
  repo: EconomyRepo,
  database: DatabaseKind,
  input: unknown,
): ImportResult {
  const parsed = careerExportSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      ok: false,
      status: 400,
      code: "invalid_export",
      message: `Not a valid Cargo Ops career export: ${issue ? `${issue.path.join(".")}: ${issue.message}` : "invalid"}`,
    };
  }
  const data = parsed.data;
  if (database === "live" && data.flights.some((f) => f.source !== "sim")) {
    return {
      ok: false,
      status: 409,
      code: "demo_data_in_live",
      message: "The export contains replay/demo flights; they cannot enter the career database",
    };
  }
  const db = repo.db;
  repo.transaction(() => {
    db.exec(
      "DELETE FROM mission_jobs; DELETE FROM missions; DELETE FROM jobs; DELETE FROM ledger; DELETE FROM company; DELETE FROM fleet; DELETE FROM loans; DELETE FROM aircraft_events; DELETE FROM market_listings;",
    );
    if (data.company) {
      // Version 1 companies get the P4 defaults from the schema; the counter and P&L are
      // rebuilt from the imported ledger when the engine reloads.
      repo.saveCompany({ ...data.company, ledgerCount: data.ledger.length });
    }
    for (const job of data.jobs) repo.saveJob(job);
    for (const m of data.missions) repo.saveMission(m);
    // Running balance: kept when the export has it, else recomputed from the starting cash.
    let running = Math.round((data.company?.startingCash ?? STARTING_CASH) * 100);
    for (const e of data.ledger) {
      running += Math.round(e.amount * 100);
      repo.addLedger({ ...e, balance: e.balance ?? running / 100, gameMs: e.gameMs ?? 0 });
    }
    for (const a of data.fleet) repo.saveAircraft(a);
    for (const l of data.loans) repo.saveLoan(l);
    for (const e of data.aircraftEvents) repo.addAircraftEvent(e);
    for (const l of data.market) repo.saveListing(l);
    const keep = new Set(data.flights.map((f) => f.id));
    const existing = db.prepare("SELECT id FROM flights").all() as Array<{ id: string }>;
    const del = db.prepare("DELETE FROM flights WHERE id = ?");
    for (const row of existing) if (!keep.has(row.id)) del.run(row.id);
    const cols = FLIGHT_COLUMNS.join(", ");
    const marks = FLIGHT_COLUMNS.map(() => "?").join(", ");
    const updates = FLIGHT_COLUMNS.filter((c) => c !== "id")
      .map((c) => `${c} = excluded.${c}`)
      .join(", ");
    const upsert = db.prepare(
      `INSERT INTO flights (${cols}) VALUES (${marks}) ON CONFLICT(id) DO UPDATE SET ${updates}`,
    );
    for (const f of data.flights) upsert.run(...FLIGHT_COLUMNS.map((c) => f[c]));
  });
  return {
    ok: true,
    counts: {
      jobs: data.jobs.length,
      missions: data.missions.length,
      ledger: data.ledger.length,
      flights: data.flights.length,
      fleet: data.fleet.length,
      loans: data.loans.length,
      market: data.market.length,
    },
    version: data.version,
  };
}
