// One shared cache per weather product (METAR, TAF) for the whole page, so components that
// show the same stations never fetch them twice:
//  - every station's last result is kept per "online" setting and reused while it is
//    younger than `freshMs`;
//  - stations requested in the same tick by different components (weather panel, map
//    badges, job cards) are merged into ONE request to the local connector (split only above
//    the connector's 8-station batch limit);
//  - a station already being fetched is awaited, not requested again.
// The connector then batches and caches upstream (aviationweather.gov) on its side.

import { MAX_STATIONS, type StationResult, type WeatherResponse } from "@cargo-ops/weather";

import { connectorJson } from "@/lib/transport/connector-api";

type Online = 0 | 1;
type Meta<R> = Omit<WeatherResponse<R>, "stations">;

interface Pending {
  stations: Set<string>;
  promise: Promise<void>;
  resolve: () => void;
  reject: (err: unknown) => void;
}

export class StationStore<R> {
  private readonly cache = new Map<string, { result: StationResult<R>; at: number }>();
  private readonly meta = new Map<Online, Meta<R>>();
  private readonly pending = new Map<Online, Pending>();
  private readonly inFlight = new Map<string, Promise<void>>();
  /** Requests sent to the connector (diagnostics and tests). */
  requests = 0;

  constructor(
    readonly path: string,
    readonly freshMs: number,
  ) {}

  private key(online: Online, station: string): string {
    return `${online}|${station}`;
  }

  /** Results for `stations` (normalised ids), fetching only what is missing or old. */
  async load(
    stations: readonly string[],
    online: boolean,
    now: number = Date.now(),
  ): Promise<WeatherResponse<R>> {
    const o: Online = online ? 1 : 0;
    const waits: Promise<void>[] = [];
    const queue: string[] = [];
    for (const s of stations) {
      const k = this.key(o, s);
      const hit = this.cache.get(k);
      if (hit && now - hit.at < this.freshMs) continue;
      const running = this.inFlight.get(k);
      if (running) waits.push(running);
      else queue.push(s);
    }
    if (queue.length > 0) waits.push(this.enqueue(o, queue));
    await Promise.all(waits);
    const meta = this.meta.get(o);
    if (!meta) throw new Error("Weather request failed");
    return {
      ...meta,
      stations: stations.map(
        (station) =>
          this.cache.get(this.key(o, station))?.result ?? {
            station,
            report: null,
            note: "Weather not fetched yet.",
          },
      ),
    };
  }

  private enqueue(o: Online, stations: readonly string[]): Promise<void> {
    let p = this.pending.get(o);
    if (!p) {
      let resolve!: () => void;
      let reject!: (err: unknown) => void;
      const promise = new Promise<void>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      p = { stations: new Set(), promise, resolve, reject };
      this.pending.set(o, p);
      // Collect everything asked for in this tick, then send one request.
      globalThis.setTimeout(() => void this.flush(o), 0);
    }
    for (const s of stations) {
      p.stations.add(s);
      this.inFlight.set(this.key(o, s), p.promise);
    }
    return p.promise;
  }

  private async flush(o: Online): Promise<void> {
    const p = this.pending.get(o);
    if (!p) return;
    this.pending.delete(o);
    const all = [...p.stations];
    try {
      for (let i = 0; i < all.length; i += MAX_STATIONS) {
        const chunk = all.slice(i, i + MAX_STATIONS);
        this.requests++;
        const data = await connectorJson<WeatherResponse<R>>(
          `${this.path}?ids=${chunk.join(",")}&online=${o}`,
        );
        const at = Date.now();
        const { stations, ...meta } = data;
        this.meta.set(o, meta);
        for (const r of stations) this.cache.set(this.key(o, r.station), { result: r, at });
      }
      p.resolve();
    } catch (err) {
      p.reject(err);
    } finally {
      for (const s of all) this.inFlight.delete(this.key(o, s));
    }
  }

  /** Forget everything (tests; a new connector session). */
  reset(): void {
    this.cache.clear();
    this.meta.clear();
    this.requests = 0;
  }
}
