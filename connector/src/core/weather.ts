// METAR and TAF fetcher (plan §3 "METAR fetcher (cached)", §8 Weather). Server-side so the
// browser needs no CORS and never talks to a third party itself.
//
// Network etiquette for aviationweather.gov (documented limits: 100 requests/min, custom
// User-Agent, at most one request per minute per thread):
//   - one request at a time per product, all due stations in one `ids=` list;
//   - a station is fetched again only when its cache entry is older than the product's TTL
//     (METAR 10 minutes; TAF 30 minutes, TAFs are issued about every 6 hours), and never
//     more than once a minute (also after failures);
//   - hard timeout, no automatic retries; failures serve the last report marked stale;
//   - nothing is fetched unless the connector runs in "online" mode AND the page's
//     "online weather" switch is on (sent as `online=1`).
// Replays default to "sample" mode: built-in SAMPLE reports, no network at all.

import type { DatabaseSync } from "node:sqlite";
import {
  AWC_ATTRIBUTION,
  AWC_METAR_URL,
  AWC_TAF_ATTRIBUTION,
  AWC_TAF_URL,
  awcMetarUrl,
  awcTafUrl,
  fromAwcResponse,
  fromAwcTafResponse,
  isTafExpired,
  sampleMetar,
  sampleTaf,
  SAMPLE_NOTE,
  SAMPLE_TAF_NOTE,
  type MetarReport,
  type MetarResponse,
  type StationResult,
  type TafReport,
  type TafResponse,
  type WeatherMode,
  type WeatherResponse,
} from "../weather";
import type { LogFn } from "../sim/source";

export const WEATHER_TTL_MS = 10 * 60_000;
export const TAF_TTL_MS = 30 * 60_000;
export const WEATHER_MIN_INTERVAL_MS = 60_000;
export const WEATHER_TIMEOUT_MS = 10_000;
/** A cached live METAR older than this is not shown at all, even as stale. */
export const WEATHER_STALE_MAX_MS = 3 * 3600_000;
/** A cached live TAF older than this is not shown (it is also dropped once its validity ends). */
export const TAF_STALE_MAX_MS = 12 * 3600_000;
const MAX_BODY_BYTES = 1024 * 1024;

export interface WeatherServiceOptions {
  mode: WeatherMode;
  version: string;
  log: LogFn;
  /** Database holding the `metar_cache` and `taf_cache` tables; null = memory only. */
  db?: DatabaseSync | null;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface CacheEntry<R> {
  fetchedAt: number;
  /** null = the API had no report for this station. */
  report: R | null;
}

/** One product (METAR or TAF): endpoint, cache table, TTLs, mapping and samples. */
interface Product<R extends { stale: boolean }> {
  name: "METAR" | "TAF";
  table: "metar_cache" | "taf_cache";
  ttlMs: number;
  staleMaxMs: number;
  url: (stations: string[]) => string;
  endpoint: string;
  attribution: string;
  /** Latest report per station from a response body. */
  map: (body: unknown, fetchedAt: number) => Map<string, R>;
  sample: (station: string, at: Date) => R | null;
  sampleNote: string;
  noneNote: string;
  /** Why a cached report must not be shown (TAF: NIL/CNL or expired); null = show it. */
  unusable?: (report: R, now: number) => string | null;
}

const METAR: Product<MetarReport> = {
  name: "METAR",
  table: "metar_cache",
  ttlMs: WEATHER_TTL_MS,
  staleMaxMs: WEATHER_STALE_MAX_MS,
  url: awcMetarUrl,
  endpoint: AWC_METAR_URL,
  attribution: AWC_ATTRIBUTION,
  map: (body, fetchedAt) => {
    const iso = new Date(fetchedAt).toISOString();
    const latest = new Map<string, MetarReport>();
    for (const d of fromAwcResponse(body, new Date(fetchedAt))) {
      const prev = latest.get(d.station);
      if (prev && (prev.observedAt ?? "") >= (d.observedAt ?? "")) continue;
      latest.set(d.station, { ...d, origin: "live", fetchedAt: iso, stale: false });
    }
    return latest;
  },
  sample: sampleMetar,
  sampleNote: SAMPLE_NOTE,
  noneNote: "No current METAR from this station.",
};

const TAF: Product<TafReport> = {
  name: "TAF",
  table: "taf_cache",
  ttlMs: TAF_TTL_MS,
  staleMaxMs: TAF_STALE_MAX_MS,
  url: awcTafUrl,
  endpoint: AWC_TAF_URL,
  attribution: AWC_TAF_ATTRIBUTION,
  map: (body, fetchedAt) => {
    const iso = new Date(fetchedAt).toISOString();
    const latest = new Map<string, TafReport>();
    for (const d of fromAwcTafResponse(body, new Date(fetchedAt))) {
      const prev = latest.get(d.station);
      if (prev && (prev.issuedAt ?? "") >= (d.issuedAt ?? "")) continue;
      latest.set(d.station, {
        station: d.station,
        issuedAt: d.issuedAt,
        validFrom: d.validFrom,
        validTo: d.validTo,
        amended: d.amended,
        corrected: d.corrected,
        cancelled: d.cancelled,
        periods: d.periods,
        rawText: d.rawText,
        origin: "live",
        decodedBy: "parser",
        fetchedAt: iso,
        stale: false,
      });
    }
    return latest;
  },
  sample: sampleTaf,
  sampleNote: SAMPLE_TAF_NOTE,
  noneNote: "No current TAF for this station (many smaller airports have none).",
  unusable: (report, now) =>
    report.cancelled
      ? "The TAF for this station is NIL or cancelled (CNL): no forecast."
      : isTafExpired(report, now)
        ? "The last TAF for this station has expired."
        : null,
};

/** Cache and request state of one product. */
class ProductState<R> {
  readonly memory = new Map<string, CacheEntry<R>>();
  readonly lastAttempt = new Map<string, number>();
  readonly lastError = new Map<string, string>();
  inFlight: Promise<void> | null = null;
}

export class WeatherService {
  readonly mode: WeatherMode;
  private readonly options: WeatherServiceOptions;
  private readonly metarState = new ProductState<MetarReport>();
  private readonly tafState = new ProductState<TafReport>();
  /** Number of HTTP requests made, all products (diagnostics and tests). */
  requests = 0;

  constructor(options: WeatherServiceOptions) {
    this.options = options;
    this.mode = options.mode;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  /** METARs for `stations` (already normalised). `online` is the page's switch. */
  metar(stations: readonly string[], online: boolean): Promise<MetarResponse> {
    return this.lookup(METAR, this.metarState, stations, online);
  }

  /** TAFs for `stations` (already normalised). `online` is the page's switch. */
  taf(stations: readonly string[], online: boolean): Promise<TafResponse> {
    return this.lookup(TAF, this.tafState, stations, online);
  }

  private cached<R extends { stale: boolean }>(
    p: Product<R>,
    st: ProductState<R>,
    station: string,
  ): CacheEntry<R> | null {
    const mem = st.memory.get(station);
    if (mem) return mem;
    const db = this.options.db;
    if (!db) return null;
    try {
      const row = db
        .prepare(`SELECT fetched_at, json FROM ${p.table} WHERE station = ?`)
        .get(station) as { fetched_at: number; json: string } | undefined;
      if (!row) return null;
      const entry: CacheEntry<R> = {
        fetchedAt: row.fetched_at,
        report: JSON.parse(row.json) as R | null,
      };
      st.memory.set(station, entry);
      return entry;
    } catch {
      return null;
    }
  }

  private store<R extends { stale: boolean }>(
    p: Product<R>,
    st: ProductState<R>,
    station: string,
    entry: CacheEntry<R>,
  ): void {
    st.memory.set(station, entry);
    try {
      this.options.db
        ?.prepare(
          `INSERT INTO ${p.table} (station, fetched_at, json) VALUES (?, ?, ?) ON CONFLICT(station) DO UPDATE SET fetched_at = excluded.fetched_at, json = excluded.json`,
        )
        .run(station, entry.fetchedAt, JSON.stringify(entry.report));
    } catch (err) {
      this.options.log(
        "debug",
        `${p.name} cache write failed: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  private async lookup<R extends { stale: boolean }>(
    p: Product<R>,
    st: ProductState<R>,
    stations: readonly string[],
    online: boolean,
  ): Promise<WeatherResponse<R>> {
    const response = (onlineAllowed: boolean, results: StationResult<R>[]) => ({
      mode: this.mode,
      onlineAllowed,
      stations: results,
      attribution: p.attribution,
      endpoint: p.endpoint,
    });
    if (this.mode === "off") {
      return response(
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
      return response(
        online,
        stations.map((station) => ({
          station,
          report: p.sample(station, at),
          note: p.sampleNote,
        })),
      );
    }
    if (!online) {
      return response(
        false,
        stations.map((station) => ({
          station,
          report: null,
          note: "Online weather is off in Settings.",
        })),
      );
    }
    if (st.inFlight) await st.inFlight;
    const now = this.now();
    const due = stations.filter((s) => {
      const c = this.cached(p, st, s);
      const fresh = c !== null && now - c.fetchedAt <= p.ttlMs;
      const recentlyTried = now - (st.lastAttempt.get(s) ?? -Infinity) < WEATHER_MIN_INTERVAL_MS;
      return !fresh && !recentlyTried;
    });
    if (due.length > 0) {
      st.inFlight = this.fetchStations(p, st, due).finally(() => {
        st.inFlight = null;
      });
      await st.inFlight;
    }
    const at = this.now();
    return response(
      true,
      stations.map((station) => this.result(p, st, station, at)),
    );
  }

  private result<R extends { stale: boolean }>(
    p: Product<R>,
    st: ProductState<R>,
    station: string,
    now: number,
  ): StationResult<R> {
    const c = this.cached(p, st, station);
    const error = st.lastError.get(station) ?? null;
    const unusable = c?.report && p.unusable ? p.unusable(c.report, now) : null;
    if (unusable) return { station, report: null, note: error ?? unusable };
    if (c && now - c.fetchedAt <= p.ttlMs && !error) {
      return c.report
        ? { station, report: { ...c.report, stale: false }, note: null }
        : { station, report: null, note: p.noneNote };
    }
    if (c?.report && now - c.fetchedAt <= p.staleMaxMs) {
      return {
        station,
        report: { ...c.report, stale: true },
        note: error ?? "Refresh pending.",
      };
    }
    if (c && !c.report && now - c.fetchedAt <= p.staleMaxMs && !error) {
      return { station, report: null, note: p.noneNote };
    }
    return { station, report: null, note: error ?? "Weather not fetched yet." };
  }

  /**
   * The report the connector already holds for `station`, without any request: the
   * SAMPLE report in sample mode, the cached live report in online mode (null when none
   * or older than WEATHER_STALE_MAX_MS; `stale` when past the TTL or a refresh failed).
   * Used to freeze the weather at departure/arrival (weather bonus).
   */
  peek(station: string): MetarReport | null {
    if (this.mode === "off") return null;
    const now = this.now();
    if (this.mode === "sample") return sampleMetar(station, new Date(now));
    const c = this.cached(METAR, this.metarState, station);
    if (!c?.report || now - c.fetchedAt > METAR.staleMaxMs) return null;
    const stale = now - c.fetchedAt > METAR.ttlMs || this.metarState.lastError.has(station);
    return { ...c.report, stale };
  }

  private async fetchStations<R extends { stale: boolean }>(
    p: Product<R>,
    st: ProductState<R>,
    stations: string[],
  ): Promise<void> {
    const startedAt = this.now();
    for (const s of stations) st.lastAttempt.set(s, startedAt);
    const fail = (message: string) => {
      for (const s of stations) st.lastError.set(s, message);
      this.options.log("warn", `${p.name} fetch failed (${stations.join(",")}): ${message}`);
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
        res = await fetchImpl(p.url(stations), {
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
      const latest = p.map(body, fetchedAt);
      for (const s of stations) {
        st.lastError.delete(s);
        this.store(p, st, s, { fetchedAt, report: latest.get(s) ?? null });
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
