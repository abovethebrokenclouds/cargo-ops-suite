import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startConnector } from "../src/cli/app";
import { parseArgs } from "../src/cli/args";
import {
  WEATHER_MIN_INTERVAL_MS,
  WEATHER_STALE_MAX_MS,
  WEATHER_TTL_MS,
  WeatherService,
} from "../src/core/weather";
import { openStorage } from "../src/storage/db";
import { FakeSource } from "../src/sim/fake-source";
import type { MetarResponse } from "../src/weather";
import { shortFixture, tempDir } from "./helpers";

// HAND-MADE response in the documented aviationweather.gov JSON shape (see its _comment):
// the host was not reachable from the build container.
const FIXTURE = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "fixtures", "awc-metar.handmade.json"), "utf8"),
) as { response: unknown[] };
// RECORDED live response (metar-live workflow run 38491010466, 2026-10-14).
const RECORDED = JSON.parse(
  readFileSync(
    join(__dirname, "..", "..", "..", "fixtures", "awc-metar.recorded-2026-10-14.json"),
    "utf8",
  ),
) as { response: unknown[] };

const T0 = Date.parse("2026-10-13T16:05:00Z");

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

interface Call {
  url: string;
  ua: string | null;
}

function service(
  overrides: Partial<ConstructorParameters<typeof WeatherService>[0]> = {},
  respond: (url: string) => Response | Promise<Response> = () => jsonResponse(FIXTURE.response),
) {
  let now = T0;
  const calls: Call[] = [];
  const svc = new WeatherService({
    mode: "online",
    version: "0.1.0",
    log: () => {},
    now: () => now,
    fetch: async (url, init) => {
      calls.push({ url: String(url), ua: new Headers(init?.headers).get("User-Agent") });
      return respond(String(url));
    },
    ...overrides,
  });
  return {
    svc,
    calls,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const byStation = (r: MetarResponse, id: string) => r.stations.find((s) => s.station === id);

describe("WeatherService (online)", () => {
  it("fetches all due stations in one request with a User-Agent and decodes them", async () => {
    const { svc, calls } = service();
    const r = await svc.metar(["KMEM", "KATL"], true);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://aviationweather.gov/api/data/metar?ids=KMEM,KATL&format=json",
    );
    assert.equal(calls[0]?.ua, "CargoOps/0.1.0 (private use)");
    assert.equal(r.mode, "online");
    const mem = byStation(r, "KMEM")?.report;
    assert.equal(mem?.origin, "live");
    assert.equal(mem?.category, "VFR");
    assert.equal(mem?.stale, false);
    assert.equal(byStation(r, "KATL")?.report?.category, "MVFR");
  });

  it("caches for 10 minutes, then refetches", async () => {
    const { svc, calls, advance } = service();
    await svc.metar(["KMEM"], true);
    advance(WEATHER_TTL_MS - 1000);
    await svc.metar(["KMEM"], true);
    assert.equal(calls.length, 1, "served from cache within the TTL");
    advance(2000);
    await svc.metar(["KMEM"], true);
    assert.equal(calls.length, 2);
  });

  it("makes no request when the page's online-weather switch is off", async () => {
    const { svc, calls } = service();
    const r = await svc.metar(["KMEM"], false);
    assert.equal(calls.length, 0);
    assert.equal(r.onlineAllowed, false);
    assert.equal(byStation(r, "KMEM")?.report, null);
    assert.match(byStation(r, "KMEM")?.note ?? "", /off in Settings/);
  });

  it("offline: a note, no retry within a minute, stale report after a later failure", async () => {
    let online = true;
    const { svc, calls, advance } = service({}, () => {
      if (!online) throw new TypeError("fetch failed");
      return jsonResponse(FIXTURE.response);
    });
    online = false;
    const first = await svc.metar(["KMEM"], true);
    assert.equal(byStation(first, "KMEM")?.report, null);
    assert.match(byStation(first, "KMEM")?.note ?? "", /Could not reach/);
    await svc.metar(["KMEM"], true);
    assert.equal(
      calls.length,
      1,
      "at most one request per station per minute, also after failures",
    );
    advance(WEATHER_MIN_INTERVAL_MS);
    online = true;
    const ok = await svc.metar(["KMEM"], true);
    assert.equal(calls.length, 2);
    assert.equal(byStation(ok, "KMEM")?.report?.stale, false);
    online = false;
    advance(WEATHER_TTL_MS + 1000);
    const stale = await svc.metar(["KMEM"], true);
    assert.equal(byStation(stale, "KMEM")?.report?.stale, true);
    assert.equal(byStation(stale, "KMEM")?.report?.category, "VFR");
    advance(WEATHER_STALE_MAX_MS);
    const gone = await svc.metar(["KMEM"], true);
    assert.equal(byStation(gone, "KMEM")?.report, null, "too old to show even as stale");
  });

  it("times out and reports it", async () => {
    // A fetch that never answers but rejects on abort, like the real one.
    const timed = new WeatherService({
      mode: "online",
      version: "0.1.0",
      log: () => {},
      timeoutMs: 20,
      fetch: (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    const r = await timed.metar(["KMEM"], true);
    assert.match(byStation(r, "KMEM")?.note ?? "", /did not answer in time/);
  });

  it("HTTP 204 and unknown stations: no report, a note, still cached", async () => {
    const { svc, calls } = service({}, () => new Response(null, { status: 204 }));
    const r = await svc.metar(["KZZZ"], true);
    assert.equal(byStation(r, "KZZZ")?.report, null);
    assert.match(byStation(r, "KZZZ")?.note ?? "", /No current METAR/);
    await svc.metar(["KZZZ"], true);
    assert.equal(calls.length, 1);
  });

  it("HTTP errors and non-JSON bodies degrade to a note", async () => {
    const e500 = service({}, () => new Response("oops", { status: 500 }));
    assert.match(byStation(await e500.svc.metar(["KMEM"], true), "KMEM")?.note ?? "", /HTTP 500/);
    const html = service({}, () => new Response("<html>", { status: 200 }));
    assert.match(
      byStation(await html.svc.metar(["KMEM"], true), "KMEM")?.note ?? "",
      /did not return JSON/,
    );
  });

  it("persists the cache in metar_cache across restarts", async () => {
    const tmp = tempDir();
    const storage = openStorage(tmp.dir, "demo");
    try {
      const a = service({ db: storage.db });
      await a.svc.metar(["KATL"], true);
      const b = service({ db: storage.db });
      const r = await b.svc.metar(["KATL"], true);
      assert.equal(b.calls.length, 0, "second service reads the database cache");
      assert.equal(byStation(r, "KATL")?.report?.category, "MVFR");
    } finally {
      storage.close();
      tmp.cleanup();
    }
  });
});

describe("WeatherService (recorded live response)", () => {
  it("maps the recorded aviationweather.gov response for KMEM, KATL, EGLL, KJFK", async () => {
    const { svc, calls } = service({ now: () => Date.parse("2026-10-14T00:30:00Z") }, () =>
      jsonResponse(RECORDED.response),
    );
    const r = await svc.metar(["KMEM", "KATL", "EGLL", "KJFK"], true);
    assert.equal(calls.length, 1);
    for (const s of r.stations) {
      assert.equal(s.report?.origin, "live", s.station);
      assert.equal(s.report?.category, "VFR", s.station);
      assert.equal(s.report?.decodedBy, "api", s.station);
    }
    assert.equal(byStation(r, "EGLL")?.report?.altimeterHpa, 1028);
    assert.equal(byStation(r, "KMEM")?.report?.observedAt, "2026-10-13T23:54:00.000Z");
    assert.equal(byStation(r, "KMEM")?.report?.visibilityPlus, true);
  });
});

describe("WeatherService (sample / off)", () => {
  it("sample mode serves labelled SAMPLE reports without any request", async () => {
    const { svc, calls } = service({ mode: "sample" });
    const r = await svc.metar(["KMEM", "KATL"], true);
    assert.equal(calls.length, 0);
    assert.equal(r.mode, "sample");
    for (const s of r.stations) {
      assert.equal(s.report?.origin, "sample");
      assert.match(s.note ?? "", /not real weather/);
    }
  });

  it("off mode returns no reports and makes no request", async () => {
    const { svc, calls } = service({ mode: "off" });
    const r = await svc.metar(["KMEM"], true);
    assert.equal(calls.length, 0);
    assert.equal(byStation(r, "KMEM")?.report, null);
  });
});

describe("--weather and GET /api/weather/metar", () => {
  it("parses --weather", () => {
    const ok = parseArgs(["--weather", "off"]);
    assert.ok(ok.ok && ok.options.weather === "off");
    const none = parseArgs([]);
    assert.ok(none.ok && none.options.weather === undefined);
    assert.equal(parseArgs(["--weather", "live"]).ok, false);
  });

  it("serves sample reports in a replay by default, validates ids and needs the token", async () => {
    const tmp = tempDir();
    let fetched = 0;
    const c = await startConnector({
      sim: "fake",
      dataDir: tmp.dir,
      port: 0,
      quiet: true,
      clockIntervalMs: 0,
      fetch: async () => {
        fetched++;
        return jsonResponse(FIXTURE.response);
      },
      source: new FakeSource({ frames: shortFixture(), speed: 1, loop: false }),
    });
    const api = (path: string) =>
      fetch(`${c.server.url}${path}`, { headers: { Authorization: `Bearer ${c.token}` } });
    try {
      assert.equal((await fetch(`${c.server.url}/api/weather/metar?ids=KMEM`)).status, 401);
      assert.equal((await api("/api/weather/metar")).status, 400);
      assert.equal((await api("/api/weather/metar?ids=not-an-id")).status, 400);
      const res = await api("/api/weather/metar?ids=kmem,KATL&online=1");
      assert.equal(res.status, 200);
      const body = (await res.json()) as MetarResponse;
      assert.equal(body.mode, "sample");
      assert.deepEqual(
        body.stations.map((s) => [s.station, s.report?.origin]),
        [
          ["KMEM", "sample"],
          ["KATL", "sample"],
        ],
      );
      assert.equal(fetched, 0, "a replay never calls aviationweather.gov");
    } finally {
      await c.stop();
      tmp.cleanup();
    }
  });

  it("online mode fetches through the route only with online=1", async () => {
    const tmp = tempDir();
    let fetched = 0;
    const c = await startConnector({
      sim: "fake",
      weather: "online",
      dataDir: tmp.dir,
      port: 0,
      quiet: true,
      clockIntervalMs: 0,
      fetch: async () => {
        fetched++;
        return jsonResponse(FIXTURE.response);
      },
      source: new FakeSource({ frames: shortFixture(), speed: 1, loop: false }),
    });
    const api = (path: string) =>
      fetch(`${c.server.url}${path}`, { headers: { Authorization: `Bearer ${c.token}` } });
    try {
      const off = (await (await api("/api/weather/metar?ids=KMEM")).json()) as MetarResponse;
      assert.equal(off.onlineAllowed, false);
      assert.equal(fetched, 0);
      const on = (await (
        await api("/api/weather/metar?ids=KMEM&online=1")
      ).json()) as MetarResponse;
      assert.equal(fetched, 1);
      assert.equal(on.stations[0]?.report?.origin, "live");
      assert.match(on.attribution, /aviationweather\.gov/);
    } finally {
      await c.stop();
      tmp.cleanup();
    }
  });
});

describe("WeatherService.peek (weather bonus, no requests)", () => {
  it("online: the cached live report, stale after the TTL or a failed refresh; never fetches", async () => {
    let up = true;
    const { svc, calls, advance } = service({}, () => {
      if (!up) throw new TypeError("fetch failed");
      return jsonResponse(FIXTURE.response);
    });
    assert.equal(svc.peek("KMEM"), null, "nothing cached yet");
    assert.equal(calls.length, 0, "peek never fetches");
    await svc.metar(["KMEM"], true);
    const fresh = svc.peek("KMEM");
    assert.equal(fresh?.origin, "live");
    assert.equal(fresh?.stale, false);
    assert.equal(calls.length, 1);
    advance(WEATHER_TTL_MS + 1000);
    assert.equal(svc.peek("KMEM")?.stale, true, "past the TTL");
    up = false;
    await svc.metar(["KMEM"], true);
    assert.equal(svc.peek("KMEM")?.stale, true, "refresh failed");
    advance(WEATHER_STALE_MAX_MS);
    assert.equal(svc.peek("KMEM"), null, "too old");
  });

  it("sample mode: a SAMPLE report; off mode: none", () => {
    const sample = new WeatherService({
      mode: "sample",
      version: "0",
      log: () => {},
      now: () => T0,
    });
    assert.equal(sample.peek("KSEA")?.origin, "sample");
    assert.equal(sample.peek("KSEA")?.category, "LIFR");
    const off = new WeatherService({ mode: "off", version: "0", log: () => {}, now: () => T0 });
    assert.equal(off.peek("KSEA"), null);
  });
});
