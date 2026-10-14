// MSFS facilities override (plan §6.1 "Facilities", §8, §14.3): asks the connected
// simulator for airports on demand, one ICAO at a time, and caches the answers in SQLite
// (`msfs_airports`, migration 10) so they also serve while the sim is closed.
//
// - When: the economy engine asks for the board airport, the chosen destination and the
//   nearby destination candidates when the player opens or refreshes the job board, and
//   for the mission airports when a mission loads or the sim connects. Never bulk lists.
// - Honesty: only what the sim returned is stored. A miss, a timeout or a rejected
//   definition stores nothing and the airport keeps its OurAirports data; each kind of
//   fallback is logged once (then at debug level).
// - A cached answer older than REFRESH_AFTER_MS is asked for again on its next use; until
//   the new answer arrives the cached one stays in use.

import type { DatabaseSync } from "node:sqlite";
import {
  facilityLookup,
  type AirportSources,
  type EconomyAirport,
  type FacilityLookup,
} from "../economy";
import { msfsAirportSchema, type MsfsAirport } from "../protocol";
import type { FacilityRequester, FacilityResult } from "../sim/facilities";
import type { LogFn } from "../sim/source";

/** Re-ask the sim for a cached airport after a week (add-on scenery may have changed). */
export const REFRESH_AFTER_MS = 7 * 86_400_000;
/** Requests in flight at once. */
export const MAX_IN_FLIGHT = 4;
/** Waiting requests kept; more are dropped (asked again on the next trigger). */
export const MAX_QUEUE = 64;

const ICAO = /^[A-Z0-9]{2,8}$/;

/** What the economy engine needs from the facilities override. */
export interface FacilityOverlay {
  /** Bumped whenever the cached data changes. */
  readonly version: number;
  all(): readonly MsfsAirport[];
  get(icao: string): MsfsAirport | null;
  /** Ask the sim for these ICAOs (skips fresh, pending and already-missed ones). */
  prefetch(icaos: Iterable<string>, reason: string): number;
  /** True while requests can be sent (sim connected, definition not refused). */
  available(): boolean;
  onChange(listener: () => void): () => void;
}

export interface FacilitiesServiceOptions {
  requester: FacilityRequester | null;
  db: DatabaseSync | null;
  log: LogFn;
  now?: () => number;
}

type Fallback = "missing" | "rejected" | "timeout" | "error";

export class FacilitiesService implements FacilityOverlay {
  private readonly requester: FacilityRequester | null;
  private readonly db: DatabaseSync | null;
  private readonly log: LogFn;
  private readonly now: () => number;
  private readonly cache = new Map<string, MsfsAirport>();
  private readonly fetchedAt = new Map<string, number>();
  private readonly queue: string[] = [];
  private readonly inFlight = new Set<string>();
  /** ICAOs the sim had no answer for on this connection (not asked again until reconnect). */
  private readonly missed = new Set<string>();
  private readonly listeners = new Set<() => void>();
  private readonly logged = new Set<Fallback>();
  private connected = false;
  private rejected = false;
  private versionValue = 0;

  constructor(options: FacilitiesServiceOptions) {
    this.requester = options.requester;
    this.db = options.db;
    this.log = options.log;
    this.now = options.now ?? Date.now;
    this.load();
  }

  get version(): number {
    return this.versionValue;
  }

  all(): readonly MsfsAirport[] {
    return [...this.cache.values()];
  }

  get(icao: string): MsfsAirport | null {
    return this.cache.get(icao.trim().toUpperCase()) ?? null;
  }

  available(): boolean {
    return this.requester !== null && this.connected && !this.rejected;
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** The simulator link came up or went down (a new connection may answer differently). */
  setConnected(connected: boolean): void {
    this.connected = connected;
    this.missed.clear();
    this.rejected = false;
    this.logged.clear();
    if (!connected) this.queue.length = 0;
  }

  prefetch(icaos: Iterable<string>, reason: string): number {
    if (!this.available()) return 0;
    let queued = 0;
    for (const raw of icaos) {
      const icao = raw.trim().toUpperCase();
      if (!ICAO.test(icao)) continue;
      if (this.inFlight.has(icao) || this.queue.includes(icao) || this.missed.has(icao)) continue;
      const at = this.fetchedAt.get(icao);
      if (at !== undefined && this.now() - at < REFRESH_AFTER_MS) continue;
      if (this.queue.length >= MAX_QUEUE) break;
      this.queue.push(icao);
      queued++;
    }
    if (queued > 0) this.log("debug", `MSFS facilities: ${queued} airport(s) queued (${reason})`);
    this.pump();
    return queued;
  }

  /** Wait until nothing is queued or in flight (tests). */
  async idle(): Promise<void> {
    while (this.queue.length > 0 || this.inFlight.size > 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  private pump(): void {
    const requester = this.requester;
    if (!requester) return;
    while (this.available() && this.inFlight.size < MAX_IN_FLIGHT && this.queue.length > 0) {
      const icao = this.queue.shift() as string;
      this.inFlight.add(icao);
      void requester
        .requestAirportFacility(icao)
        .catch((err: unknown): FacilityResult => ({
          status: "error",
          reason: err instanceof Error ? err.message : String(err),
        }))
        .then((result) => {
          this.inFlight.delete(icao);
          this.onResult(icao, result);
          this.pump();
        });
    }
  }

  private onResult(icao: string, result: FacilityResult): void {
    switch (result.status) {
      case "found":
        this.store(result.airport);
        return;
      case "offline":
        return;
      case "missing":
        this.missed.add(icao);
        this.fallback("missing", `MSFS has no facility data for ${icao}`);
        return;
      case "timeout":
        this.missed.add(icao);
        this.fallback("timeout", `MSFS did not answer the facility request for ${icao}`);
        return;
      case "error":
        this.missed.add(icao);
        this.fallback("error", `MSFS facility data for ${icao} unreadable (${result.reason})`);
        return;
      case "rejected":
        if (!this.rejected) {
          this.rejected = true;
          this.queue.length = 0;
          this.fallback(
            "rejected",
            `MSFS refused the airport facility definition (${result.reason}); fix it in connector/src/sim/facilities.ts`,
          );
        }
        return;
    }
  }

  /** Each kind of fallback is logged once per connection at info/warn, then at debug. */
  private fallback(kind: Fallback, message: string): void {
    const first = !this.logged.has(kind);
    this.logged.add(kind);
    const level = !first ? "debug" : kind === "rejected" ? "warn" : "info";
    this.log(level, `${message}; using OurAirports data${first ? " (logged once)" : ""}`);
  }

  private store(airport: MsfsAirport): void {
    const icao = airport.icao.toUpperCase();
    const at = this.now();
    this.cache.set(icao, airport);
    this.fetchedAt.set(icao, at);
    try {
      this.db
        ?.prepare(
          "INSERT OR REPLACE INTO msfs_airports (icao, source, sim, fetched_at, json) VALUES (?, 'msfs', ?, ?, ?)",
        )
        .run(icao, airport.sim ?? null, at, JSON.stringify(airport));
    } catch (err) {
      this.log(
        "warn",
        `MSFS facility cache write failed: ${err instanceof Error ? err.message : err}`,
      );
    }
    this.log(
      "info",
      `MSFS facility ${icao}: ${airport.runways.length} runway(s), elevation ${airport.elevFt} ft`,
    );
    this.versionValue++;
    for (const l of [...this.listeners]) l();
  }

  private load(): void {
    if (!this.db) return;
    let rows: Array<{ icao: string; fetched_at: number; json: string }> = [];
    try {
      rows = this.db
        .prepare("SELECT icao, fetched_at, json FROM msfs_airports WHERE source = 'msfs'")
        .all() as typeof rows;
    } catch (err) {
      this.log(
        "warn",
        `MSFS facility cache unreadable: ${err instanceof Error ? err.message : err}`,
      );
      return;
    }
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.json);
      } catch {
        continue;
      }
      const p = msfsAirportSchema.safeParse(parsed);
      if (!p.success) continue;
      const icao = row.icao.toUpperCase();
      this.cache.set(icao, p.data);
      this.fetchedAt.set(icao, row.fetched_at);
    }
    if (this.cache.size > 0) {
      this.versionValue++;
      this.log("info", `MSFS facility cache: ${this.cache.size} airport(s)`);
    }
  }
}

/**
 * The economy's airport lookup: bundled OurAirports records with the cached MSFS data merged
 * over them (packages/economy facilities.ts). Rebuilt only when the cache changes, so the
 * same cache state always gives the same list (the job generator stays deterministic).
 */
export class OverlayAirportLookup implements FacilityLookup {
  private built = -1;
  private current: FacilityLookup;

  constructor(
    private readonly base: readonly EconomyAirport[],
    private readonly overlay: FacilityOverlay | null,
  ) {
    this.current = facilityLookup(base, []);
    this.refresh();
  }

  private refresh(): FacilityLookup {
    const v = this.overlay?.version ?? 0;
    if (v !== this.built) {
      this.current = facilityLookup(this.base, this.overlay?.all() ?? []);
      this.built = v;
    }
    return this.current;
  }

  get list(): readonly EconomyAirport[] {
    return this.refresh().list;
  }

  get(ident: string | null | undefined): EconomyAirport | null {
    return this.refresh().get(ident);
  }

  sourcesOf(ident: string | null | undefined): AirportSources | null {
    return this.refresh().sourcesOf(ident);
  }

  msfsOf(ident: string | null | undefined): MsfsAirport | null {
    return this.refresh().msfsOf(ident);
  }

  /** Bundled airports only (for picking nearby candidates to ask the sim about). */
  get bundled(): readonly EconomyAirport[] {
    return this.base;
  }
}
