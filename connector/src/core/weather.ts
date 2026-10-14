// METAR fetcher (plan §3 "METAR fetcher (cached)", §8 Weather). Server-side so the browser
// needs no CORS and never talks to a third party itself.
//
// Network etiquette for aviationweather.gov (documented limits: 100 requests/min, custom
// User-Agent, at most one request per minute per thread):
//   - one request at a time, all due stations in one `ids=` list;
//   - a station is fetched again only when its cache entry is older than 10 minutes, and
//     never more than once a minute (also after failures);
//   - hard timeout, no automatic retries; failures serve the last report marked stale;
//   - nothing is fetched unless the connector runs in "online" mode AND the page's
//     "online weather" switch is on (sent as `online=1`).
// Replays default to "sample" mode: built-in SAMPLE reports, no network at all.

import type { DatabaseSync } from "node:sqlite";
import {
  AWC_ATTRIBUTION,
  AWC_METAR_URL,
  awcMetarUrl,
  fromAwcResponse,
  sampleMetar,
  SAMPLE_NOTE,
  type MetarReport,
  type MetarResponse,
  type MetarStationResult,
  type WeatherMode,
} from "../weather";
import type { LogFn } from "../sim/source";

export const WEATHER_TTL_MS = 10 * 60_000;
export const WEATHER_MIN_INTERVAL_MS = 60_000;
export const WEATHER_TIMEOUT_MS = 10_000;
/** A cached live report older than this is not shown at all, even as stale. */
export const WEATHER_STALE_MAX_MS = 3 * 3600_000;
const MAX_BODY_BYTES = 1024 * 1024;

export interface WeatherServiceOptions {
  mode: WeatherMode;
  version: string;
  log: LogFn;
  /** Database holding the `metar_cache` table (survives restarts); null = memory only. */
  db?: DatabaseSync | null;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface CacheEntry {
  fetchedAt: number;
  /** null = the API had no report for this station. */
  report: MetarReport | null;
}

export class WeatherService {
  readonly mode: WeatherMode;
  private readonly options: WeatherServiceOptions;
  private readonly memory = new Map<string, CacheEntry>();
  private readonly lastAttempt = new Map<string, number>();
  private readonly lastError = new Map<string, string>();
  private inFlight: Promise<void> | null = null;
  /** Number of HTTP requests made (diagnostics and tests). */
  requests = 0;

  constructor(options: WeatherServiceOptions) {
    this.options = options;
    this.mode = options.mode;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private cached(station: string): CacheEntry | null {
    const mem = this.memory.get(station);
    if (mem) return mem;
    const db = this.options.db;
    if (!db) return null;
    try {
      const row = db
        .prepare("SELECT fetched_at, json FROM metar_cache WHERE station = ?")
        .get(station) as { fetched_at: number; json: string } | undefined;
      if (!row) return null;
      const entry: CacheEntry = {
        fetchedAt: row.fetched_at,
        report: JSON.parse(row.json) as MetarReport | null,
      };
      this.memory.set(station, entry);
      return entry;
    } catch {
      return null;
    }
  }

  private store(station: string, entry: CacheEntry): void {
    this.memory.set(station, entry);
    try {
      this.options.db
        ?.prepare(
          "INSERT INTO metar_cache (station, fetched_at, json) VALUES (?, ?, ?) ON CONFLICT(station) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json",
        )
        .run(station, entry.fetchedAt, JSON.stringify(entry.report));
    } catch (err) {
      this.options.log(
        "debug",
        `METAR cache write failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private response(onlineAllowed: boolean, stations: MetarStationResult[]): MetarResponse {
    return {
      mode: this.mode,
      onlineAllowed,
      stations,
      attribution: AWC_ATTRIBUTION,
      endpoint: AWC_METAR_URL,
    };
  }

  /** METARs for `stations` (already normalised). `online` is the page's switch. */
  async metar(stations: readonly string[], online: boolean): Promise<MetarResponse> {
    if (this.mode === "off") {
      return this.response(
        online,
        stations.map((station) => ({
          station,
          report: null,
          note: "Weather is off in the connector (--weather off).",
        })),
      );
    }
    if (this.mode === "sample") {
      const at = new Date(this.now());
      return this.response(
        online,
        stations.map((station) => ({
          station,
          report: sampleMetar(station, at),
          note: SAMPLE_NOTE,
        })),
      );
    }
    if (!online) {
      return this.response(
        false,
        stations.map((station) => ({
          station,
          report: null,
          note: "Online weather is off in Settings.",
        })),
      );
    }
    if (this.inFlight) await this.inFlight;
    const now = this.now();
    const due = stations.filter((s) => {
      const c = this.cached(s);
      const fresh = c !== null && now - c.fetchedAt <= WEATHER_TTL_MS;
      const recentlyTried = now - (this.lastAttempt.get(s) ?? -Infinity) < WEATHER_MIN_INTERVAL_MS;
      return !fresh && !recentlyTried;
    });
    if (due.length > 0) {
      this.inFlight = this.fetchStations(due).finally(() => {
        this.inFlight = null;
      });
      await this.inFlight;
    }
    const at = this.now();
    return this.response(
      true,
      stations.map((station) => this.result(station, at)),
    );
  }

  private result(station: string, now: number): MetarStationResult {
    const c = this.cached(station);
    const error = this.lastError.get(station) ?? null;
    if (c && now - c.fetchedAt <= WEATHER_TTL_MS && !error) {
      return c.report
        ? { station, report: { ...c.report, stale: false }, note: null }
        : { station, report: null, note: "No current METAR from this station." };
    }
    if (c?.report && now - c.fetchedAt <= WEATHER_STALE_MAX_MS) {
      return {
        station,
        report: { ...c.report, stale: true },
        note: error ?? "Refresh pending.",
      };
    }
    if (c && !c.report && now - c.fetchedAt <= WEATHER_STALE_MAX_MS && !error) {
      return { station, report: null, note: "No current METAR from this station." };
    }
    return { station, report: null, note: error ?? "Weather not fetched yet." };
  }

  private async fetchStations(stations: string[]): Promise<void> {
    const startedAt = this.now();
    for (const s of stations) this.lastAttempt.set(s, startedAt);
    const fail = (message: string) => {
      for (const s of stations) this.lastError.set(s, message);
      this.options.log("warn", `METAR fetch failed (${stations.join(",")}): ${message}`);
    };
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? WEATHER_TIMEOUT_MS,
    );
    this.requests++;
    try {
      let res: Response;
      try {
        res = await fetchImpl(awcMetarUrl(stations), {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": `CargoOps/${this.options.version} (private use)`,
          },
        });
      } catch {
        fail(
          controller.signal.aborted
            ? "aviationweather.gov did not answer in time."
            : "Could not reach aviationweather.gov (offline?).",
        );
        return;
      }
      let body: unknown = [];
      if (res.status !== 204) {
        if (!res.ok) {
          fail(`aviationweather.gov answered HTTP ${res.status}.`);
          return;
        }
        let text: string;
        try {
          text = await res.text();
        } catch {
          fail("aviationweather.gov closed the connection.");
          return;
        }
        if (text.length > MAX_BODY_BYTES) {
          fail("The aviationweather.gov response is unexpectedly large.");
          return;
        }
        try {
          body = text.trim() === "" ? [] : JSON.parse(text);
        } catch {
          fail("aviationweather.gov did not return JSON.");
          return;
        }
      }
      const fetchedAt = this.now();
      const iso = new Date(fetchedAt).toISOString();
      const latest = new Map<string, MetarReport>();
      for (const d of fromAwcResponse(body, new Date(fetchedAt))) {
        const prev = latest.get(d.station);
        if (prev && (prev.observedAt ?? "") >= (d.observedAt ?? "")) continue;
        latest.set(d.station, { ...d, origin: "live", fetchedAt: iso, stale: false });
      }
      for (const s of stations) {
        this.lastError.delete(s);
        this.store(s, { fetchedAt, report: latest.get(s) ?? null });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
