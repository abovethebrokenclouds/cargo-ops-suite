// MSFS facilities override (plan §6.1 "Facilities", §8, §14.3): the REAL SimConnectSource
// (node-simconnect, unmodified) against the test-only protocol emulator, the SQLite cache,
// the economy's merged airport lookup and the job generator.
//
// What this proves: the connector, node-simconnect and the SimConnect facility wire format
// (as the SDK documents it) agree; misses, refusals and timeouts fall back to OurAirports;
// the cache survives a restart; the generator stays deterministic with and without MSFS
// data. What it does NOT prove: what MSFS itself returns (member names it accepts, units,
// how it answers an unknown ICAO). PC-57 in docs/VERIFICATION.md checks that on the sim.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { loadAirportsData } from "../src/core/economy/airports-data";
import { FacilitiesService, REFRESH_AFTER_MS } from "../src/core/facilities";
import { ConnectorSession } from "../src/core/session";
import {
  destinationCandidates,
  facilityLookup,
  generateJobs,
  airportLookup,
  type EconomyAirport,
} from "../src/economy";
import {
  PROTOCOL_VERSION,
  aircraftTypeByKey,
  type Command,
  type FacilitiesState,
  type Frame,
  type MsfsAirport,
  type Result,
} from "../src/protocol";
import { AIRPORT_FACILITY_DEFINITION, type FacilityResult } from "../src/sim/facilities";
import { SimConnectSource } from "../src/sim/simconnect-source";
import type { LogLevel } from "../src/sim/source";
import { openStorage } from "../src/storage/db";
import { tempDir } from "./helpers";
import {
  FN,
  SimConnectEmulator,
  type EmulatedAirport,
  type EmulatorOptions,
} from "./support/simconnect-emulator";

/** KMEM as an emulated scenery database has it (SDK units: degrees, metres, enums). */
const KMEM: EmulatedAirport = {
  values: {
    LATITUDE: 35.0424,
    LONGITUDE: -89.9767,
    ALTITUDE: 103.9,
    NAME64: "Memphis Intl",
    N_RUNWAYS: 2,
  },
  runways: [
    {
      HEADING: 178.6,
      LENGTH: 3389.4,
      WIDTH: 45.7,
      SURFACE: 0,
      PRIMARY_NUMBER: 18,
      PRIMARY_DESIGNATOR: 3,
      SECONDARY_NUMBER: 36,
      SECONDARY_DESIGNATOR: 3,
    },
    {
      HEADING: 268.9,
      LENGTH: 2743.2,
      WIDTH: 45.7,
      SURFACE: 4,
      PRIMARY_NUMBER: 27,
      PRIMARY_DESIGNATOR: 0,
      SECONDARY_NUMBER: 9,
      SECONDARY_DESIGNATOR: 0,
    },
  ],
};

/** An add-on grass strip the bundled OurAirports data does not have (about 35 nm from KMEM). */
const ADDON: EmulatedAirport = {
  values: { LATITUDE: 35.5, LONGITUDE: -89.5, ALTITUDE: 91.4, NAME64: "Addon Field", N_RUNWAYS: 1 },
  runways: [
    {
      HEADING: 90.2,
      LENGTH: 1219.2,
      WIDTH: 30.5,
      SURFACE: 1,
      PRIMARY_NUMBER: 9,
      PRIMARY_DESIGNATOR: 0,
      SECONDARY_NUMBER: 27,
      SECONDARY_DESIGNATOR: 0,
    },
  ],
};

/** KUOX with a 600 m runway in the sim: too short for a C208B (2,500 ft). */
const KUOX_SHORT: EmulatedAirport = {
  values: { LATITUDE: 34.3843, LONGITUDE: -89.5368, ALTITUDE: 137.8, NAME64: "", N_RUNWAYS: 1 },
  runways: [
    {
      HEADING: 220,
      LENGTH: 600,
      WIDTH: 30,
      SURFACE: 4,
      PRIMARY_NUMBER: 22,
      PRIMARY_DESIGNATOR: 0,
      SECONDARY_NUMBER: 4,
      SECONDARY_DESIGNATOR: 0,
    },
  ],
};

interface Rig {
  emu: SimConnectEmulator;
  source: SimConnectSource;
  logs: Array<{ level: LogLevel; message: string }>;
}

const rigs: Rig[] = [];
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.source.stop();
    await r.emu.close();
  }
  for (const c of cleanups.splice(0)) await c();
});

async function rig(options: EmulatorOptions = {}, facilityTimeoutMs?: number): Promise<Rig> {
  const emu = await SimConnectEmulator.start({
    secondMs: 100,
    simFrameMs: 40,
    facilities: { KMEM, XADD: ADDON },
    ...options,
  });
  const logs: Rig["logs"] = [];
  const source = new SimConnectSource({
    log: (level, message) => logs.push({ level, message }),
    remote: { host: "127.0.0.1", port: emu.port },
    retryMinMs: 100,
    retryMaxMs: 400,
    ...(facilityTimeoutMs !== undefined ? { facilityTimeoutMs } : {}),
  });
  const r = { emu, source, logs };
  rigs.push(r);
  return r;
}

async function waitFor<T>(
  probe: () => T | undefined | null | false,
  what: string,
  timeoutMs = 5000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined && value !== null && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function connected(r: Rig): Promise<void> {
  r.source.start();
  await waitFor(() => r.source.link().connected, "SimConnect open");
}

function found(result: FacilityResult): MsfsAirport {
  assert.equal(result.status, "found", JSON.stringify(result));
  return (result as { airport: MsfsAirport }).airport;
}

describe("MSFS facilities: SimConnectSource against the emulator", () => {
  it("hit: one definition per connection, airport + runways decoded and converted", async () => {
    const r = await rig();
    await connected(r);
    const kmem = found(await r.source.requestAirportFacility("kmem"));
    assert.equal(kmem.icao, "KMEM");
    assert.equal(kmem.name, "Memphis Intl");
    assert.ok(Math.abs(kmem.lat - 35.0424) < 1e-9);
    assert.ok(Math.abs(kmem.lon + 89.9767) < 1e-9);
    assert.equal(kmem.elevFt, 341); // 103.9 m
    assert.equal(kmem.sim, "MSFS 2024");
    assert.ok(!Number.isNaN(Date.parse(kmem.fetchedAt)));
    assert.deepEqual(
      kmem.runways.map((rw) => [rw.ident, rw.lengthFt, rw.widthFt, rw.surface, rw.surfaceCode]),
      [
        ["18C/36C", 11120, 150, "concrete", 0],
        ["27/09", 9000, 150, "asphalt", 4],
      ],
    );
    assert.equal(kmem.runways[0]?.headingTrueDeg, 178.6);

    const addon = found(await r.source.requestAirportFacility("XADD"));
    assert.equal(addon.runways[0]?.surface, "grass");
    assert.equal(addon.runways[0]?.lengthFt, 4000);

    // The definition went out once, in table order, through node-simconnect's public API.
    const defs = r.emu.packets.filter((p) => p.fn === FN.ADD_TO_FACILITY_DEFINITION);
    assert.deepEqual(
      defs.map((p) => p.fields["name"]),
      AIRPORT_FACILITY_DEFINITION.map((f) => f.name),
    );
    assert.deepEqual(r.emu.facilityRequests(), ["KMEM", "XADD"]);
    assert.deepEqual(r.emu.unhandled, []);
    assert.deepEqual(r.emu.protocolErrors, []);
  });

  it("miss: an ICAO the sim does not know (end only, or an exception) is 'missing'", async () => {
    const a = await rig();
    await connected(a);
    assert.deepEqual(await a.source.requestAirportFacility("ZZZZ"), { status: "missing" });
    const b = await rig({ facilityMiss: "exception" });
    await connected(b);
    assert.deepEqual(await b.source.requestAirportFacility("ZZZZ"), { status: "missing" });
    // The connection survives a miss and still answers.
    assert.equal(found(await b.source.requestAirportFacility("KMEM")).icao, "KMEM");
  });

  it("rejection: a refused member disables facility requests for that connection", async () => {
    const r = await rig({ facilityReject: ["NAME64"] });
    await connected(r);
    const first = await r.source.requestAirportFacility("KMEM");
    assert.equal(first.status, "rejected");
    assert.match((first as { reason: string }).reason, /NAME64/);
    const sent = r.emu.facilityRequests().length;
    const second = await r.source.requestAirportFacility("XADD");
    assert.equal(second.status, "rejected");
    assert.equal(r.emu.facilityRequests().length, sent, "no request after a refusal");
    // The rest of the link is untouched (telemetry definitions are separate).
    assert.equal(r.source.link().connected, true);
  });

  it("timeout and disconnect: unanswered requests resolve, never hang", async () => {
    const r = await rig({ facilitySilent: ["KMEM"] }, 150);
    await connected(r);
    assert.deepEqual(await r.source.requestAirportFacility("KMEM"), { status: "timeout" });
    const r2 = await rig({ facilitySilent: ["KMEM"] });
    await connected(r2);
    const pending = r2.source.requestAirportFacility("KMEM");
    await waitFor(() => r2.emu.facilityRequests().length === 1, "request sent");
    r2.emu.drop();
    assert.deepEqual(await pending, { status: "offline" });
    assert.deepEqual(await r2.source.requestAirportFacility("KMEM"), { status: "offline" });
  });
});

describe("MSFS facilities: service, fallback and SQLite cache", () => {
  it("caches a hit (source msfs, fetched_at), serves it after a restart, refreshes stale data", async () => {
    const tmp = tempDir();
    cleanups.push(tmp.cleanup);
    const r = await rig();
    await connected(r);
    let now = Date.parse("2026-10-14T12:00:00Z");
    const storage = openStorage(tmp.dir, "live");
    cleanups.push(() => storage.close());
    assert.equal(storage.schemaVersion(), 10);
    const logs: string[] = [];
    const svc = new FacilitiesService({
      requester: r.source,
      db: storage.db,
      log: (_l, m) => logs.push(m),
      now: () => now,
    });
    svc.setConnected(true);
    let changes = 0;
    svc.onChange(() => changes++);
    assert.equal(svc.prefetch(["KMEM", "kmem", "XADD", "bad icao!"], "test"), 2);
    await svc.idle();
    assert.equal(changes, 2);
    assert.equal(svc.get("KMEM")?.runways.length, 2);
    const rows = storage.db
      .prepare("SELECT icao, source, sim, fetched_at FROM msfs_airports ORDER BY icao")
      .all() as Array<{ icao: string; source: string; sim: string; fetched_at: number }>;
    assert.deepEqual(
      rows.map((x) => ({ ...x })),
      [
        { icao: "KMEM", source: "msfs", sim: "MSFS 2024", fetched_at: now },
        { icao: "XADD", source: "msfs", sim: "MSFS 2024", fetched_at: now },
      ],
    );
    // Fresh: not asked again.
    const sent = r.emu.facilityRequests().length;
    assert.equal(svc.prefetch(["KMEM", "XADD"], "test"), 0);
    // Restart with the sim closed: the cache still answers, nothing is requested.
    const offline = new FacilitiesService({ requester: null, db: storage.db, log: () => {} });
    assert.equal(offline.get("XADD")?.name, "Addon Field");
    assert.equal(offline.available(), false);
    assert.equal(offline.prefetch(["KMEM"], "test"), 0);
    // A week later the cached answer is used until the new one arrives, then replaced.
    now += REFRESH_AFTER_MS + 1;
    assert.equal(svc.prefetch(["KMEM"], "test"), 1);
    await svc.idle();
    assert.equal(r.emu.facilityRequests().length, sent + 1);
    const again = storage.db
      .prepare("SELECT fetched_at FROM msfs_airports WHERE icao = 'KMEM'")
      .get() as { fetched_at: number };
    assert.equal(again.fetched_at, now);
  });

  it("falls back silently: misses and a refused definition store nothing and log once", async () => {
    const r = await rig({ facilityReject: ["N_RUNWAYS"] });
    await connected(r);
    const logs: Array<{ level: LogLevel; message: string }> = [];
    const svc = new FacilitiesService({
      requester: r.source,
      db: null,
      log: (level, message) => logs.push({ level, message }),
    });
    svc.setConnected(true);
    svc.prefetch(["KMEM", "XADD", "KJBR"], "test");
    await svc.idle();
    assert.equal(svc.all().length, 0);
    assert.equal(svc.available(), false);
    const loud = logs.filter((l) => l.level !== "debug" && /OurAirports/.test(l.message));
    assert.equal(loud.length, 1, JSON.stringify(logs));
    assert.equal(loud[0]?.level, "warn");
    assert.match(loud[0]?.message ?? "", /refused the airport facility definition/);
    // Nothing more is asked on this connection.
    assert.equal(svc.prefetch(["KTUP"], "test"), 0);

    const m = await rig();
    await connected(m);
    const mlogs: Array<{ level: LogLevel; message: string }> = [];
    const miss = new FacilitiesService({
      requester: m.source,
      db: null,
      log: (level, message) => mlogs.push({ level, message }),
    });
    miss.setConnected(true);
    miss.prefetch(["ZZZ1", "ZZZ2"], "test");
    await miss.idle();
    const info = mlogs.filter((l) => l.level === "info" && /no facility data/.test(l.message));
    const debug = mlogs.filter((l) => l.level === "debug" && /no facility data/.test(l.message));
    assert.equal(info.length, 1);
    assert.equal(debug.length, 1);
    // A miss is not asked again on the same connection.
    assert.equal(miss.prefetch(["ZZZ1"], "test"), 0);
    assert.equal(m.emu.facilityRequests().length, 2);
  });
});

describe("MSFS facilities: job generator determinism", () => {
  const bundled = loadAirportsData().airports;
  const c208 = aircraftTypeByKey("c208b");
  assert.ok(c208);
  const airport = (icao: string, e: EmulatedAirport): MsfsAirport => ({
    icao,
    ...(e.values["NAME64"] ? { name: String(e.values["NAME64"]) } : {}),
    lat: Number(e.values["LATITUDE"]),
    lon: Number(e.values["LONGITUDE"]),
    elevFt: Math.round(Number(e.values["ALTITUDE"]) * 3.280839895),
    runways: (e.runways ?? []).map((rw) => ({
      ident: "",
      headingTrueDeg: Number(rw["HEADING"]),
      lengthFt: Math.round(Number(rw["LENGTH"]) * 3.280839895),
      widthFt: Math.round(Number(rw["WIDTH"]) * 3.280839895),
      surfaceCode: Number(rw["SURFACE"]),
      surface: null,
    })),
    fetchedAt: "2026-10-14T12:00:00.000Z",
  });
  const board = (list: readonly EconomyAirport[], focus?: string) => {
    const lookup = airportLookup(list);
    const origin = lookup.get("KMEM");
    assert.ok(origin);
    return generateJobs({
      origin,
      airports: lookup.list,
      aircraft: c208,
      seed: 777,
      nowMs: Date.parse("2026-10-14T12:00:00Z"),
      reputation: 50,
      longHaulJobs: 2,
      focus: focus ? lookup.get(focus) : null,
    });
  };

  it("without MSFS data the merged lookup is the bundled list (same jobs)", () => {
    const merged = facilityLookup(bundled, []);
    assert.deepEqual(merged.list, airportLookup(bundled).list);
    assert.deepEqual(board(merged.list), board(bundled));
    assert.equal(merged.sourcesOf("KMEM")?.runway, "ourairports");
  });

  it("with MSFS data: same inputs give the same jobs; the sim's runways change the board", () => {
    const facilities = [airport("KMEM", KMEM), airport("XADD", ADDON), airport("KUOX", KUOX_SHORT)];
    const a = facilityLookup(bundled, facilities);
    const b = facilityLookup(bundled, [...facilities].reverse());
    assert.deepEqual(a.list, b.list, "order of the cache does not matter");
    assert.deepEqual(board(a.list, "XADD"), board(b.list, "XADD"));
    assert.deepEqual(board(a.list), board(a.list));
    // The add-on strip is a destination only with MSFS data; KUOX's short MSFS runway drops it.
    const kmem = a.get("KMEM");
    assert.ok(kmem);
    const withMsfs = destinationCandidates(kmem, a.list, c208).map((c) => c.airport.ident);
    const plain = destinationCandidates(kmem, airportLookup(bundled).list, c208).map(
      (c) => c.airport.ident,
    );
    assert.ok(withMsfs.includes("XADD") && !plain.includes("XADD"));
    assert.ok(plain.includes("KUOX") && !withMsfs.includes("KUOX"));
    assert.ok(
      board(a.list, "XADD")
        .slice(0, 3)
        .every((j) => j.destination === "XADD"),
    );
    assert.notDeepEqual(board(a.list), board(bundled));
    // Field sources: MSFS where the sim answered, OurAirports otherwise.
    assert.deepEqual(a.sourcesOf("KUOX"), {
      name: "ourairports",
      position: "msfs",
      elevation: "msfs",
      runway: "msfs",
      surface: "msfs",
    });
    assert.equal(a.get("KUOX")?.name, bundled.find((x) => x.ident === "KUOX")?.name);
    assert.equal(a.sourcesOf("KJBR")?.runway, "ourairports");
    assert.equal(a.get("XADD")?.type, "small");
  });
});

describe("MSFS facilities: connector session (board, mission, domain)", () => {
  it("asks for board airports, merges the answers into the next board and publishes them", async () => {
    const r = await rig({ facilities: { KMEM, XADD: ADDON, KUOX: KUOX_SHORT } });
    const facilities = new FacilitiesService({ requester: r.source, db: null, log: () => {} });
    let n = 0;
    const session = new ConnectorSession(r.source, () => {}, {
      facilities,
      economy: { airports: loadAirportsData().airports, seed: 4242, newId: () => `M-${++n}` },
    });
    const frames: Frame[] = [];
    session.store.subscribe((f) => frames.push(f));
    const cmd = (name: string, args: Record<string, unknown> = {}): Result =>
      session.command({
        type: "command",
        v: PROTOCOL_VERSION,
        id: `c${++n}`,
        name,
        args,
      } as Command);
    session.start();
    await waitFor(() => r.source.link().connected, "connected");
    // On connect: the board airport (KMEM) and its nearest candidates were asked for.
    await waitFor(() => r.emu.facilityRequests().includes("KMEM"), "KMEM asked");
    await facilities.idle();
    const asked = r.emu.facilityRequests();
    assert.ok(asked.includes("KUOX"), "nearest candidate asked");
    assert.ok(asked.length <= 1 + 24 + 1, `bounded: ${asked.length}`);
    assert.equal(new Set(asked).size, asked.length, "each ICAO once");

    // The add-on airport is unknown until the sim answered for it.
    const first = cmd("jobs.refresh", { airport: "KMEM", destination: "XADD" });
    assert.equal(first.ok, false);
    assert.match((first as { error: { message: string } }).error.message, /asked the simulator/);
    await facilities.idle();
    const second = cmd("jobs.refresh", { airport: "KMEM", destination: "XADD" });
    assert.equal(second.ok, true, JSON.stringify(second));
    const jobs = session.store.getDomain("jobs") as { available: Array<{ destination: string }> };
    assert.ok(jobs.available.some((j) => j.destination === "XADD"));
    assert.ok(!jobs.available.some((j) => j.destination === "KUOX"), "KUOX too short in MSFS");

    // The domain carries the MSFS records of the board airports, under the "sim" frame tag.
    const domain = session.store.getDomain("facilities") as FacilitiesState;
    assert.equal(domain.source, "sim");
    assert.equal(domain.airports["KMEM"]?.runways.length, 2);
    assert.equal(domain.airports["XADD"]?.name, "Addon Field");
    const carrying = frames.filter(
      (f) => f.type !== "event" && "facilities" in (f.type === "snapshot" ? f.state : f.patch),
    );
    assert.ok(carrying.length > 0);
    for (const f of carrying) assert.equal(f.source, "sim");
    // Opening the board again asks nothing new (everything fresh or missed).
    const before = r.emu.facilityRequests().length;
    assert.equal(cmd("jobs.list").ok, true);
    await facilities.idle();
    assert.equal(r.emu.facilityRequests().length, before);
    await session.stop();
  });
});
