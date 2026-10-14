import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startConnector } from "../src/cli/app";
import { TAF_TTL_MS, WEATHER_TTL_MS, WeatherService } from "../src/core/weather";
import { openStorage } from "../src/storage/db";
import { FakeSource } from "../src/sim/fake-source";
import type { TafResponse } from "../src/weather";
import { shortFixture, tempDir } from "./helpers";

// HAND-MADE responses in the documented aviationweather.gov JSON shape (see their _comment):
// the host is not reachable from the build container.
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "fixtures", name), "utf8")) as {
    response: unknown[];
  };
const TAF_FIXTURE = fixture("awc-taf.handmade.json");
const METAR_FIXTURE = fixture("awc-metar.handmade.json");

const T0 = Date.parse("2026-10-13T16:05:00Z");

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const byUrl = (url: string) =>
  jsonResponse(url.includes("/api/data/taf") ? TAF_FIXTURE.response : METAR_FIXTURE.response);

function service(
  overrides: Partial<ConstructorParameters<typeof WeatherService>[0]> = {},
  respond: (url: string) => Response | Promise<Response> = byUrl,
) {
  let now = T0;
  const calls: Array<{ url: string; ua: string | null }> = [];
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

const tafBy = (r: TafResponse, id: string) => r.stations.find((s) => s.station === id);

describe("WeatherService TAF", () => {
  it("fetches TAFs in one request and returns decoded periods with categories", async () => {
    const { svc, calls } = service();
    const r = await svc.taf(["KMEM", "KATL", "EGLL"], true);
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://aviationweather.gov/api/data/taf?ids=KMEM,KATL,EGLL&format=json",
    );
    assert.equal(calls[0]?.ua, "CargoOps/0.1.0 (private use)");
    assert.match(r.attribution, /TAF: NOAA Aviation Weather Center/);
    assert.equal(r.endpoint, "https://aviationweather.gov/api/data/taf");
    const mem = tafBy(r, "KMEM")?.report;
    assert.equal(mem?.origin, "live");
    assert.equal(mem?.decodedBy, "parser");
    assert.equal(mem?.stale, false);
    assert.deepEqual(
      mem?.periods.map((p) => [p.kind, p.category]),
      [
        ["BASE", "VFR"],
        ["FM", "VFR"],
        ["TEMPO", "MVFR"],
        ["FM", "VFR"],
        ["PROB", "IFR"],
      ],
    );
    assert.equal(mem?.validTo, "2026-10-14T18:00:00.000Z");
    assert.ok(!("apiPeriodCount" in (mem ?? {})), "diagnostic field stays out of the report");
    assert.equal(tafBy(r, "EGLL")?.report?.periods.at(3)?.category, "LIFR");
  });

  it("caches TAFs for 30 minutes, separately from METARs", async () => {
    const { svc, calls, advance } = service();
    await svc.taf(["KATL"], true);
    await svc.metar(["KATL"], true);
    assert.equal(calls.length, 2, "one TAF and one METAR request");
    advance(WEATHER_TTL_MS + 1000);
    await svc.taf(["KATL"], true);
    assert.equal(calls.length, 2, "TAF still fresh after the METAR TTL");
    advance(TAF_TTL_MS - WEATHER_TTL_MS);
    await svc.taf(["KATL"], true);
    assert.equal(calls.length, 3);
    assert.ok(calls[2]?.url.includes("/api/data/taf"));
  });

  it("makes no request with the online switch off; sample and off modes never fetch", async () => {
    const off = service();
    const r = await off.svc.taf(["KATL"], false);
    assert.equal(off.calls.length, 0);
    assert.equal(r.onlineAllowed, false);
    assert.match(tafBy(r, "KATL")?.note ?? "", /off in Settings/);
    const sample = service({ mode: "sample" });
    const s = await sample.svc.taf(["KATL", "KXYZ"], true);
    assert.equal(sample.calls.length, 0);
    assert.equal(s.mode, "sample");
    for (const st of s.stations) {
      assert.equal(st.report?.origin, "sample");
      assert.match(st.note ?? "", /not a real forecast/);
      assert.ok((st.report?.periods.length ?? 0) > 1);
    }
    const none = service({ mode: "off" });
    assert.equal(tafBy(await none.svc.taf(["KATL"], true), "KATL")?.report, null);
    assert.equal(none.calls.length, 0);
  });

  it("serves a stale TAF after a failed refresh, and drops it once its validity ends", async () => {
    let up = true;
    const { svc, advance } = service({}, (url) => {
      if (!up) throw new TypeError("fetch failed");
      return byUrl(url);
    });
    await svc.taf(["KMEM"], true);
    up = false;
    advance(TAF_TTL_MS + 1000);
    const stale = await svc.taf(["KMEM"], true);
    assert.equal(tafBy(stale, "KMEM")?.report?.stale, true);
    assert.match(tafBy(stale, "KMEM")?.note ?? "", /Could not reach/);
    // KMEM is valid until 14/18Z; T0 is 13/16:05Z.
    advance(Date.parse("2026-10-14T18:00:00Z") - T0);
    const gone = await svc.taf(["KMEM"], true);
    assert.equal(tafBy(gone, "KMEM")?.report, null);
  });

  it("an expired TAF is not shown even when the API still returns it", async () => {
    const { svc, calls, advance } = service();
    await svc.taf(["KMEM"], true);
    advance(Date.parse("2026-10-14T18:30:00Z") - T0);
    const r = await svc.taf(["KMEM"], true);
    assert.equal(calls.length, 2, "refetched after the TTL");
    assert.equal(tafBy(r, "KMEM")?.report, null);
    assert.match(tafBy(r, "KMEM")?.note ?? "", /expired/);
  });

  it("stations without a TAF get a note", async () => {
    const { svc } = service({}, () => new Response(null, { status: 204 }));
    const r = await svc.taf(["KZZZ"], true);
    assert.equal(tafBy(r, "KZZZ")?.report, null);
    assert.match(tafBy(r, "KZZZ")?.note ?? "", /No current TAF/);
  });

  it("persists the TAF cache in taf_cache across restarts", async () => {
    const tmp = tempDir();
    const storage = openStorage(tmp.dir, "demo");
    try {
      const a = service({ db: storage.db });
      await a.svc.taf(["EGLL"], true);
      const b = service({ db: storage.db });
      const r = await b.svc.taf(["EGLL"], true);
      assert.equal(b.calls.length, 0, "second service reads the database cache");
      assert.equal(tafBy(r, "EGLL")?.report?.periods.length, 5);
    } finally {
      storage.close();
      tmp.cleanup();
    }
  });
});

describe("GET /api/weather/taf", () => {
  it("SAMPLE in a replay, live only with online=1, ids validated, token required", async () => {
    const tmp = tempDir();
    const fetched: string[] = [];
    const start = (weather?: "online") =>
      startConnector({
        sim: "fake",
        ...(weather ? { weather } : {}),
        dataDir: tmp.dir,
        port: 0,
        quiet: true,
        clockIntervalMs: 0,
        fetch: async (url) => {
          fetched.push(String(url));
          return jsonResponse(TAF_FIXTURE.response);
        },
        source: new FakeSource({ frames: shortFixture(), speed: 1, loop: false }),
      });
    type Running = Awaited<ReturnType<typeof start>>;
    const api = (c: Running, path: string) =>
      fetch(`${c.server.url}${path}`, { headers: { Authorization: `Bearer ${c.token}` } });
    const replay = await start();
    try {
      assert.equal((await fetch(`${replay.server.url}/api/weather/taf?ids=KMEM`)).status, 401);
      assert.equal((await api(replay, "/api/weather/taf?ids=bad!")).status, 400);
      const res = await api(replay, "/api/weather/taf?ids=KATL&online=1");
      assert.equal(res.status, 200);
      const body = (await res.json()) as TafResponse;
      assert.equal(body.mode, "sample");
      assert.equal(body.stations[0]?.report?.origin, "sample");
      assert.equal(fetched.length, 0, "a replay never calls aviationweather.gov");
    } finally {
      await replay.stop();
    }
    const online = await start("online");
    try {
      const off = (await (await api(online, "/api/weather/taf?ids=KATL")).json()) as TafResponse;
      assert.equal(off.onlineAllowed, false);
      assert.equal(fetched.length, 0);
      const on = (await (
        await api(online, "/api/weather/taf?ids=KATL&online=1")
      ).json()) as TafResponse;
      assert.deepEqual(fetched, ["https://aviationweather.gov/api/data/taf?ids=KATL&format=json"]);
      assert.equal(on.stations[0]?.report?.origin, "live");
    } finally {
      await online.stop();
      tmp.cleanup();
    }
  });
});
