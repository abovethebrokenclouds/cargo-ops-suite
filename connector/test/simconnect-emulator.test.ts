// The REAL SimConnectSource (and, at the end, the real connector CLI) against the test-only
// SimConnect protocol emulator (test/support/simconnect-emulator.ts) over TCP.
//
// What this proves: the connector and node-simconnect agree with the SimConnect wire format
// as the public SDK documents it — handshake and protocol fallback, every data definition,
// frame decoding, exceptions, system events, reconnects, AI traffic by type. What it does NOT
// prove: anything about what MSFS itself sends (names it accepts, units, event timing).
// Results are recorded as "Emulated" evidence in docs/VERIFICATION.md, never as PC checks.

import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { after, afterEach, describe, it } from "node:test";
import { configPath } from "../src/core/config";
import { loadAirportsData } from "../src/core/economy/airports-data";
import { ConnectorSession } from "../src/core/session";
import {
  PROTOCOL_VERSION,
  type Command,
  type Frame,
  type JobsState,
  type Mission,
  type Result,
  type ServerMessage,
  type SimStatePatch,
} from "../src/protocol";
import { SimConnectSource } from "../src/sim/simconnect-source";
import { SIMVARS, buildDatums } from "../src/sim/simvars";
import type { LogLevel, SimUpdate } from "../src/sim/source";
import { connectClient, hello, tempDir } from "./helpers";
import {
  DATATYPE,
  FN,
  SimConnectEmulator,
  type EmulatorOptions,
  type SimValue,
} from "./support/simconnect-emulator";

const MAIN = join(__dirname, "..", "src", "cli", "main.js");

/** A Caravan parked at KMEM: values in the units the connector asks for. */
const CARAVAN: Record<string, SimValue> = {
  "NUMBER OF ENGINES": 1,
  "PAYLOAD STATION COUNT": 2,
  TITLE: "Emulated Caravan 208B",
  "ATC ID": "N208EM",
  "FUEL TOTAL QUANTITY": 335.5,
  "FUEL TOTAL QUANTITY WEIGHT": 2247.9,
  "ENG FUEL FLOW PPH:1": 62.5,
  "TOTAL WEIGHT": 7417.9,
  "EMPTY WEIGHT": 4600,
  "MAX GROSS WEIGHT": 8807,
  "PAYLOAD STATION WEIGHT:1": 170,
  "PAYLOAD STATION WEIGHT:2": 400,
  "PAYLOAD STATION NAME:1": "Pilot",
  "PAYLOAD STATION NAME:2": "Cargo",
  "GENERAL ENG COMBUSTION:1": 1,
  "BRAKE PARKING POSITION": 1,
  "SIMULATION RATE": 1,
  "ZULU TIME": 50_400,
  "ZULU DAY OF MONTH": 13,
  "ZULU MONTH OF YEAR": 10,
  "ZULU YEAR": 2026,
  "PLANE LATITUDE": 35.0424,
  "PLANE LONGITUDE": -89.9767,
  "INDICATED ALTITUDE": 341,
  "PLANE ALT ABOVE GROUND": 0,
  "AIRSPEED INDICATED": 0,
  "AIRSPEED TRUE": 0,
  "GROUND VELOCITY": 0,
  "PLANE HEADING DEGREES MAGNETIC": 178,
  "PLANE HEADING DEGREES TRUE": 179.5,
  "VERTICAL SPEED": 0,
  "G FORCE": 1,
  "PLANE TOUCHDOWN NORMAL VELOCITY": 0,
  "PLANE TOUCHDOWN BANK DEGREES": 0,
  "PLANE TOUCHDOWN PITCH DEGREES": 0,
  "SIM ON GROUND": 1,
};

interface Harness {
  emu: SimConnectEmulator;
  source: SimConnectSource;
  updates: SimUpdate[];
  logs: Array<{ level: LogLevel; message: string }>;
}

const running: Harness[] = [];

async function harness(
  options: EmulatorOptions = {},
  sourceOptions: { aiSampleIntervalMs?: number; stuckPauseMs?: number } = {},
): Promise<Harness> {
  const emu = await SimConnectEmulator.start({
    secondMs: 100,
    simFrameMs: 40,
    values: CARAVAN,
    ...options,
  });
  const logs: Harness["logs"] = [];
  const updates: SimUpdate[] = [];
  const source = new SimConnectSource({
    log: (level, message) => logs.push({ level, message }),
    remote: { host: "127.0.0.1", port: emu.port },
    retryMinMs: 100,
    retryMaxMs: 400,
    ...sourceOptions,
  });
  source.subscribe((u) => updates.push(u));
  const h = { emu, source, updates, logs };
  running.push(h);
  source.start();
  return h;
}

afterEach(async () => {
  for (const h of running.splice(0)) {
    await h.source.stop();
    await h.emu.close();
  }
});

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

function latest<K extends keyof SimStatePatch>(
  updates: SimUpdate[],
  domain: K,
  from = 0,
): SimStatePatch[K] | undefined {
  for (let i = updates.length - 1; i >= from; i--) {
    const u = updates[i];
    if (u?.type === "data" && u.patch[domain] !== undefined) return u.patch[domain];
  }
  return undefined;
}

function events(updates: SimUpdate[], name: string, from = 0): unknown[] {
  return updates
    .slice(from)
    .filter(
      (u): u is Extract<SimUpdate, { type: "event" }> => u.type === "event" && u.name === name,
    )
    .map((u) => u.data);
}

function connectedUpdates(updates: SimUpdate[]) {
  return updates.filter(
    (u): u is Extract<SimUpdate, { type: "connected" }> => u.type === "connected",
  );
}

describe("SimConnect emulator: handshake (PC-03/04/05 logic)", () => {
  it("MSFS 2024: opens with SunRise, names the sim from applicationName", async () => {
    const h = await harness({ profile: "msfs2024" });
    const conn = await waitFor(() => connectedUpdates(h.updates)[0], "connected");
    assert.deepEqual(conn, {
      type: "connected",
      simName: "MSFS 2024",
      protocol: "SunRise",
      version: "12.1.282174.999",
    });
    assert.deepEqual(h.source.link(), {
      connected: true,
      name: "MSFS 2024",
      version: "12.1.282174.999",
      protocol: "SunRise",
    });
    const opens = h.emu.packets.filter((p) => p.fn === FN.OPEN);
    assert.equal(opens.length, 1);
    assert.equal(opens[0]?.protocol, 6);
    assert.equal(opens[0]?.fields["appName"], "Cargo Ops");
    assert.ok(
      h.logs.some((l) =>
        /Connected to SunRise \(MSFS 2024\) v12\.1\.282174\.999 via SimConnect SunRise/.test(
          l.message,
        ),
      ),
    );
    // Every system event subscribed and the "Sim" state requested (the state reply comes
    // after the subscriptions, which are sent first on the same connection).
    await waitFor(() => h.logs.some((l) => l.message === 'System state "Sim" = 1'), "Sim state");
    const subscribed = h.emu.packets
      .filter((p) => p.fn === FN.SUBSCRIBE_TO_SYSTEM_EVENT)
      .map((p) => p.fields["name"]);
    for (const name of [
      "Pause",
      "Pause_EX1",
      "SimStart",
      "SimStop",
      "FlightLoaded",
      "AircraftLoaded",
      "Crashed",
      "CrashReset",
      "1sec",
    ]) {
      assert.ok(subscribed.includes(name), `subscribed ${name}`);
    }
    assert.deepEqual(h.emu.unhandled, []);
    assert.deepEqual(h.emu.protocolErrors, []);
  });

  it("MSFS 2020: SunRise refused (VERSION_MISMATCH), falls back to KittyHawk quickly", async () => {
    const started = Date.now();
    const h = await harness({ profile: "msfs2020" });
    const conn = await waitFor(() => connectedUpdates(h.updates)[0], "connected");
    // Without the fast-fail open helper this took node-simconnect's 5 s open timeout.
    assert.ok(Date.now() - started < 3000, `fallback took ${Date.now() - started} ms`);
    assert.equal(conn.simName, "MSFS 2020");
    assert.equal(conn.protocol, "KittyHawk");
    assert.equal(conn.version, "11.0.282174.999");
    const opens = h.emu.packets.filter((p) => p.fn === FN.OPEN);
    assert.deepEqual(
      opens.map((p) => [p.protocol, p.fields["alias"]]),
      [
        [6, "RS"],
        [5, "HK"],
      ],
    );
    assert.ok(
      h.logs.some((l) =>
        /open with SunRise failed: open refused: VERSION_MISMATCH/.test(l.message),
      ),
    );
  });

  it("MSFS 2020 that just closes the connection on SunRise also falls back", async () => {
    const started = Date.now();
    const h = await harness({ profile: "msfs2020", unsupportedProtocol: "close" });
    const conn = await waitFor(() => connectedUpdates(h.updates)[0], "connected");
    assert.ok(Date.now() - started < 3000, `fallback took ${Date.now() - started} ms`);
    assert.equal(conn.simName, "MSFS 2020");
    assert.equal(conn.protocol, "KittyHawk");
  });

  it("the name follows applicationName, not the protocol; unknown names fall back to the protocol", async () => {
    const a = await harness({ profile: "msfs2024", applicationName: "KittyHawk" });
    const connA = await waitFor(() => connectedUpdates(a.updates)[0], "connected A");
    assert.equal(connA.simName, "MSFS 2020");
    assert.equal(connA.protocol, "SunRise");
    const b = await harness({ profile: "msfs2024", applicationName: "FutureSim" });
    const connB = await waitFor(() => connectedUpdates(b.updates)[0], "connected B");
    assert.equal(connB.simName, "MSFS 2024");
  });

  it("nothing listening: stays offline, says so once at info level, keeps retrying", async () => {
    const emu = await SimConnectEmulator.start();
    const port = emu.port;
    await emu.close();
    const logs: Array<{ level: LogLevel; message: string }> = [];
    const updates: SimUpdate[] = [];
    const source = new SimConnectSource({
      log: (level, message) => logs.push({ level, message }),
      remote: { host: "127.0.0.1", port },
      retryMinMs: 50,
      retryMaxMs: 50,
    });
    source.subscribe((u) => updates.push(u));
    source.start();
    try {
      await waitFor(
        () => logs.filter((l) => /Simulator not reachable/.test(l.message)).length >= 3,
        "three attempts",
        // Windows retries a refused loopback connect for ~2 s before failing it.
        30_000,
      );
      const notReachable = logs.filter((l) => /Simulator not reachable/.test(l.message));
      assert.equal(notReachable[0]?.level, "info");
      assert.ok(notReachable.slice(1).every((l) => l.level === "debug"));
      assert.equal(source.link().connected, false);
      assert.equal(connectedUpdates(updates).length, 0);
    } finally {
      await source.stop();
    }
  });
});

describe("SimConnect emulator: data definitions and decoding (PC-07/08/09 decode path)", () => {
  it("every SimVar in the table is defined with the right type and decodes into telemetry", async () => {
    const h = await harness();
    await waitFor(() => latest(h.updates, "payload"), "slow data");
    await waitFor(() => latest(h.updates, "motion"), "fast data");

    // Every table entry was sent (indexed ones per engine / station), as the right data type.
    const defined = h.emu.packets.filter((p) => p.fn === FN.ADD_TO_DATA_DEFINITION);
    const counts = { engines: 1, stations: 2 };
    const expected = [
      ...buildDatums("fast", counts),
      ...buildDatums("counts", counts),
      ...buildDatums("slow", counts),
    ];
    for (const d of expected) {
      const p = defined.find((x) => x.fields["name"] === d.simvar);
      assert.ok(p, `defined ${d.simvar}`);
      const type =
        d.type === "f64"
          ? DATATYPE.FLOAT64
          : d.type === "string64"
            ? DATATYPE.STRING64
            : DATATYPE.STRING256;
      assert.equal(p.fields["type"], type, `${d.simvar} type`);
      assert.equal(p.fields["unit"], d.unit ?? "", `${d.simvar} unit`);
    }
    for (const spec of SIMVARS) {
      assert.ok(
        defined.some((p) => String(p.fields["name"]).split(":")[0] === spec.name),
        `table entry ${spec.name}`,
      );
    }
    assert.equal(h.logs.filter((l) => /SimConnect rejected/.test(l.message)).length, 0);
    assert.equal(h.logs.filter((l) => /Dropped a/.test(l.message)).length, 0);
    assert.ok(h.logs.some((l) => l.message === "Aircraft has 1 engine(s), 2 payload station(s)"));

    assert.deepEqual(latest(h.updates, "position"), {
      lat: 35.0424,
      lon: -89.9767,
      altFt: 341,
      aglFt: 0,
    });
    assert.deepEqual(latest(h.updates, "motion"), {
      iasKt: 0,
      tasKt: 0,
      gsKt: 0,
      hdgMagDeg: 178,
      hdgTrueDeg: 179.5,
      vsFpm: 0,
      gForce: 1,
      onGround: true,
      touchdownVelocityFpm: 0,
      touchdownBankDeg: 0,
      touchdownPitchDeg: 0,
    });
    assert.deepEqual(latest(h.updates, "aircraft"), {
      title: "Emulated Caravan 208B",
      atcId: "N208EM",
    });
    assert.deepEqual(latest(h.updates, "fuel"), {
      totalGal: 335.5,
      totalLb: 2247.9,
      flowPph: [62.5],
    });
    assert.deepEqual(latest(h.updates, "payload"), {
      stations: [
        { name: "Pilot", weightLb: 170 },
        { name: "Cargo", weightLb: 400 },
      ],
    });
    assert.deepEqual(latest(h.updates, "weights"), {
      totalLb: 7417.9,
      emptyLb: 4600,
      maxGrossLb: 8807,
      payloadLb: 570,
    });
    assert.deepEqual(latest(h.updates, "engines"), { running: [true] });
    assert.deepEqual(latest(h.updates, "controls"), { parkingBrake: true });
    assert.deepEqual(latest(h.updates, "sim"), {
      connected: true,
      paused: false,
      simRate: 1,
      name: "MSFS 2024",
    });
    assert.equal(h.source.zulu, "2026-10-13T14:00:00.000Z");
    assert.equal(h.source.simRunning, true);
  });

  it("follows changing values (a takeoff roll) at the throttled fast rate", async () => {
    const h = await harness();
    await waitFor(() => latest(h.updates, "motion"), "fast data");
    const mark = h.updates.length;
    h.emu.set({
      "PLANE ALT ABOVE GROUND": 1500,
      "INDICATED ALTITUDE": 1841,
      "AIRSPEED INDICATED": 120,
      "AIRSPEED TRUE": 124,
      "GROUND VELOCITY": 130,
      "VERTICAL SPEED": 700,
      "SIM ON GROUND": 0,
    });
    const motion = await waitFor(() => {
      const m = latest(h.updates, "motion", mark);
      return m && m.onGround === false ? m : undefined;
    }, "airborne motion");
    assert.equal(motion.iasKt, 120);
    assert.equal(motion.vsFpm, 700);
    // Above 1,000 ft AGL the fast domains are throttled to 5 Hz (emulator sends at 25 Hz).
    const t0 = Date.now();
    const before = h.updates.filter((u) => u.type === "data" && u.patch.position).length;
    await new Promise((r) => setTimeout(r, 1000));
    const n = h.updates.filter((u) => u.type === "data" && u.patch.position).length - before;
    const elapsed = (Date.now() - t0) / 1000;
    assert.ok(n >= 3 && n <= 6.5 * elapsed, `${n} fast patches in ${elapsed.toFixed(2)} s`);
  });
});

describe("SimConnect emulator: rejected SimVars", () => {
  it("logs 'SimConnect rejected', drops the datum and keeps everything else working", async () => {
    // One fast and one slow SimVar rejected: their exceptions land in the same 250 ms rebuild
    // window. Before the fix only the last group was rebuilt and fast data never came back.
    const h = await harness({ reject: ["PLANE TOUCHDOWN PITCH DEGREES", "PAYLOAD STATION NAME"] });
    await waitFor(
      () => h.logs.filter((l) => /SimConnect rejected/.test(l.message)).length >= 2,
      "two rejections",
    );
    const rejected = h.logs.filter((l) => /SimConnect rejected/.test(l.message));
    assert.ok(rejected.every((l) => l.level === "warn"));
    assert.ok(
      rejected.some((l) =>
        l.message.startsWith(
          'SimConnect rejected "PLANE TOUCHDOWN PITCH DEGREES" (degrees): NAME_UNRECOGNIZED. ' +
            "Dropping PLANE TOUCHDOWN PITCH DEGREES;",
        ),
      ),
    );
    assert.ok(
      rejected.some((l) =>
        /"PAYLOAD STATION NAME:1" \(string\): NAME_UNRECOGNIZED/.test(l.message),
      ),
    );
    const mark = h.updates.length;
    // Fast data comes back without the rejected touchdown pitch (never guessed).
    const motion = await waitFor(
      () => latest(h.updates, "motion", mark),
      "fast data after rebuild",
    );
    assert.equal(motion.onGround, true);
    assert.equal(motion.touchdownPitchDeg, undefined);
    assert.equal(motion.touchdownBankDeg, 0);
    assert.ok(latest(h.updates, "position", mark));
    // Slow data comes back; stations without a name get the "Station i" label.
    const payload = await waitFor(
      () => latest(h.updates, "payload", mark),
      "slow data after rebuild",
    );
    assert.deepEqual(payload, {
      stations: [
        { name: "Station 1", weightLb: 170 },
        { name: "Station 2", weightLb: 400 },
      ],
    });
    // The rebuilt definitions no longer contain the rejected names.
    const lastFast = h.emu.packets.filter(
      (p) => p.fn === FN.ADD_TO_DATA_DEFINITION && p.fields["name"] === "PLANE LATITUDE",
    );
    assert.ok(lastFast.length >= 2, "fast definition rebuilt");
    const pitch = h.emu.definedNames().filter((n) => n === "PLANE TOUCHDOWN PITCH DEGREES");
    assert.equal(pitch.length, 1, "PLANE TOUCHDOWN PITCH DEGREES not requested again");
  });

  it("an unknown SIMULATION RATE leaves the sim domain unreported (nothing guessed)", async () => {
    const h = await harness({ reject: ["SIMULATION RATE"] });
    await waitFor(
      () => h.logs.some((l) => /SimConnect rejected "SIMULATION RATE"/.test(l.message)),
      "rejection",
    );
    const mark = h.updates.length;
    await waitFor(() => latest(h.updates, "fuel", mark), "slow data after rebuild");
    assert.equal(latest(h.updates, "sim"), undefined);
  });
});

describe("SimConnect emulator: system events (PC-11/14/21/22 logic)", () => {
  it("Pause_EX1 / Pause / EX1-shaped events and sim-rate changes are reported", async () => {
    const h = await harness();
    await waitFor(() => latest(h.updates, "sim"), "sim domain");
    let mark = h.updates.length;
    h.emu.pause(4); // ACTIVE_PAUSE
    await waitFor(() => events(h.updates, "sim.paused", mark).length > 0, "paused");
    assert.deepEqual(events(h.updates, "sim.paused", mark)[0], {
      paused: true,
      event: "Pause_EX1",
      flags: 4,
    });
    await waitFor(() => latest(h.updates, "sim", mark)?.paused === true, "sim.paused true");
    mark = h.updates.length;
    h.emu.pause(0);
    await waitFor(() => events(h.updates, "sim.paused", mark).length > 0, "unpaused");
    assert.equal((events(h.updates, "sim.paused", mark)[0] as { paused: boolean }).paused, false);
    // The legacy Pause event that follows does not flip it back.
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(events(h.updates, "sim.paused", mark).length, 1);

    // Active pause delivered in the SIMCONNECT_RECV_EVENT_EX1 shape.
    mark = h.updates.length;
    h.emu.systemEventEx1("Pause_EX1", [2]);
    await waitFor(() => events(h.updates, "sim.paused", mark).length > 0, "EX1 pause");
    assert.deepEqual(events(h.updates, "sim.paused", mark)[0], {
      paused: true,
      event: "Pause_EX1",
      flags: 2,
    });
    h.emu.pause(0);
    await waitFor(() => latest(h.updates, "sim")?.paused === false, "running again");

    // SIM_PAUSE (8, esc menu) is a pause too; the old 0b111 mask read it as running.
    mark = h.updates.length;
    h.emu.pause(8);
    await waitFor(() => events(h.updates, "sim.paused", mark).length > 0, "SIM_PAUSE");
    assert.deepEqual(events(h.updates, "sim.paused", mark)[0], {
      paused: true,
      event: "Pause_EX1",
      flags: 8,
    });
    h.emu.pause(0);
    await waitFor(() => latest(h.updates, "sim")?.paused === false, "running after SIM_PAUSE");

    mark = h.updates.length;
    h.emu.set({ "SIMULATION RATE": 4 });
    await waitFor(() => events(h.updates, "sim.rate", mark).length > 0, "sim.rate");
    assert.deepEqual(events(h.updates, "sim.rate", mark)[0], { rate: 4 });
    await waitFor(() => latest(h.updates, "sim", mark)?.simRate === 4, "sim domain rate 4");
  });

  it("AircraftLoaded re-reads engine and station counts and redefines the slow data", async () => {
    const h = await harness();
    await waitFor(() => latest(h.updates, "payload"), "first aircraft");
    const mark = h.updates.length;
    h.emu.loadAircraft(
      {
        TITLE: "Emulated King Air 350",
        "NUMBER OF ENGINES": 2,
        "PAYLOAD STATION COUNT": 3,
        "ENG FUEL FLOW PPH:2": 70,
        "GENERAL ENG COMBUSTION:2": 0,
        "PAYLOAD STATION WEIGHT:3": 250,
        "PAYLOAD STATION NAME:3": "Aft cargo",
      },
      "SimObjects\\Airplanes\\Emulated_KingAir\\aircraft.cfg",
    );
    await waitFor(
      () => h.logs.some((l) => l.message === "Aircraft has 2 engine(s), 3 payload station(s)"),
      "new counts",
    );
    assert.ok(
      h.logs.some(
        (l) =>
          l.message ===
          "System event AircraftLoaded: SimObjects\\Airplanes\\Emulated_KingAir\\aircraft.cfg",
      ),
    );
    const engines = await waitFor(() => {
      const e = latest(h.updates, "engines", mark);
      return e?.running?.length === 2 ? e : undefined;
    }, "two engines");
    assert.deepEqual(engines, { running: [true, false] });
    const payload = await waitFor(() => latest(h.updates, "payload", mark), "three stations");
    assert.equal(payload.stations?.length, 3);
    assert.deepEqual(payload.stations?.[2], { name: "Aft cargo", weightLb: 250 });
    assert.deepEqual(latest(h.updates, "fuel", mark)?.flowPph, [62.5, 70]);
    assert.equal(latest(h.updates, "aircraft", mark)?.title, "Emulated King Air 350");
    const names = h.emu.definedNames();
    assert.ok(names.includes("GENERAL ENG COMBUSTION:2"));
    assert.ok(names.includes("PAYLOAD STATION WEIGHT:3"));
    // The old slow definition was cleared and its request stopped.
    assert.ok(h.emu.packets.some((p) => p.fn === FN.CLEAR_DATA_DEFINITION));
    assert.ok(
      h.emu.packets.some((p) => p.fn === FN.REQUEST_DATA_ON_SIM_OBJECT && p.fields["period"] === 0),
    );

    // FlightLoaded does the same (a different aircraft may come with the flight).
    const before = h.emu.packets.filter((p) => p.fn === FN.REQUEST_DATA_ON_SIM_OBJECT).length;
    h.emu.systemEvent("FlightLoaded", 0, "flights\\other\\emulated.FLT");
    await waitFor(
      () => h.emu.packets.filter((p) => p.fn === FN.REQUEST_DATA_ON_SIM_OBJECT).length > before,
      "counts re-requested",
    );
  });

  it("Crashed emits the crash event", async () => {
    const h = await harness();
    await waitFor(() => connectedUpdates(h.updates)[0], "connected");
    await waitFor(
      () =>
        h.emu.packets.some(
          (p) => p.fn === FN.SUBSCRIBE_TO_SYSTEM_EVENT && p.fields["name"] === "Crashed",
        ),
      "subscribed",
    );
    const mark = h.updates.length;
    assert.equal(h.emu.systemEvent("Crashed"), 1);
    await waitFor(() => events(h.updates, "crash", mark).length > 0, "crash event");
    assert.ok(h.logs.some((l) => l.level === "warn" && l.message === "System event Crashed"));
  });
});

describe("SimConnect emulator: SimStart / SimStop and the effective pause (PC-11/21 logic, §14.4)", () => {
  const systemStateRequests = (h: Harness) =>
    h.emu.packets.filter((p) => p.fn === FN.REQUEST_SYSTEM_STATE && p.fields["state"] === "Sim");

  it("SimStop pauses, SimStart resumes and re-requests the Sim system state; the link stays up", async () => {
    const h = await harness();
    await waitFor(() => latest(h.updates, "sim"), "sim domain");
    await waitFor(() => systemStateRequests(h).length === 1, "Sim state requested on connect");
    let mark = h.updates.length;
    h.emu.simStop();
    await waitFor(() => events(h.updates, "sim.paused", mark).length > 0, "paused by SimStop");
    assert.deepEqual(events(h.updates, "sim.paused", mark)[0], { paused: true, event: "SimStop" });
    await waitFor(() => latest(h.updates, "sim", mark)?.paused === true, "sim domain paused");
    assert.equal(h.source.link().connected, true, "a stop is not a disconnect");
    assert.equal(h.updates.slice(mark).filter((u) => u.type === "disconnected").length, 0);
    // No frames are made up while the simulator sends none.
    await new Promise((r) => setTimeout(r, 200));
    const quiet = h.updates.length;
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(latest(h.updates, "position", quiet), undefined, "no position frames in the menu");

    mark = h.updates.length;
    h.emu.simStart();
    await waitFor(() => events(h.updates, "sim.paused", mark).length > 0, "resumed by SimStart");
    assert.deepEqual(events(h.updates, "sim.paused", mark)[0], {
      paused: false,
      event: "SimStart",
    });
    await waitFor(() => systemStateRequests(h).length === 2, "Sim state re-requested on SimStart");
    await waitFor(() => latest(h.updates, "position", mark), "frames again");
    assert.equal(latest(h.updates, "sim", mark)?.paused, false);
    assert.equal(h.source.simRunning, true);
  });

  it('a "Sim" = 0 system state on connect starts paused (user in the menus)', async () => {
    const h = await harness({ simRunning: false });
    await waitFor(() => latest(h.updates, "sim")?.paused === true, "paused from the Sim state");
    assert.equal(h.source.simRunning, false);
    const mark = h.updates.length;
    h.emu.simStart();
    await waitFor(() => latest(h.updates, "sim", mark)?.paused === false, "running after SimStart");
  });

  it("a Pause_EX1 that never clears is overridden after SimStart and sustained movement", async () => {
    const h = await harness({}, { stuckPauseMs: 400 });
    await waitFor(() => latest(h.updates, "sim"), "sim domain");
    h.emu.pause(4);
    await waitFor(() => latest(h.updates, "sim")?.paused === true, "paused");
    h.emu.simStop();
    await new Promise((r) => setTimeout(r, 100));
    // The sim drops the pause but never says so; the aircraft is still parked.
    let mark = h.updates.length;
    h.emu.simStart();
    await new Promise((r) => setTimeout(r, 800));
    assert.equal(latest(h.updates, "sim", mark)?.paused ?? true, true, "parked: stays paused");
    assert.equal(events(h.updates, "sim.paused", mark).length, 0);

    // Now it taxis and flies: positions change and ground speed is real.
    mark = h.updates.length;
    let lon = Number(CARAVAN["PLANE LONGITUDE"]);
    const timer = setInterval(() => {
      lon += 0.0005;
      h.emu.set({ "PLANE LONGITUDE": lon, "GROUND VELOCITY": 60 });
    }, 40);
    try {
      await waitFor(
        () => events(h.updates, "sim.paused", mark).length > 0,
        "stuck pause overridden",
      );
    } finally {
      clearInterval(timer);
    }
    assert.deepEqual(events(h.updates, "sim.paused", mark)[0], {
      paused: false,
      event: "stuck_pause",
      flags: 4,
    });
    await waitFor(() => latest(h.updates, "sim", mark)?.paused === false, "sim domain running");
    assert.ok(h.logs.some((l) => l.level === "warn" && /stuck/i.test(l.message)));
    // The sim reports a pause again: honoured.
    mark = h.updates.length;
    h.emu.pause(4);
    await waitFor(() => latest(h.updates, "sim", mark)?.paused === true, "paused again");
  });

  it("a session's sim clock does not count the time spent in the main menu", async () => {
    const emu = await SimConnectEmulator.start({ secondMs: 100, simFrameMs: 40, values: CARAVAN });
    const source = new SimConnectSource({
      log: () => {},
      remote: { host: "127.0.0.1", port: emu.port },
      retryMinMs: 100,
      retryMaxMs: 400,
    });
    const h: Harness = { emu, source, updates: [], logs: [] };
    running.push(h);
    const session = new ConnectorSession(source, () => {});
    const frames: Frame[] = [];
    session.store.subscribe((f) => frames.push(f));
    session.start();
    const clock = () => session.flight.clock.nowMs;
    await waitFor(() => clock() > 300, "clock running");
    emu.simStop();
    await waitFor(
      () => (session.store.getDomain("sim") as { paused?: boolean } | null)?.paused === true,
      "paused in the store",
    );
    const atStop = clock();
    await new Promise((r) => setTimeout(r, 1500)); // "main menu"
    assert.ok(clock() - atStop < 100, `clock moved ${clock() - atStop} ms while stopped`);
    emu.simStart();
    await waitFor(
      () => (session.store.getDomain("sim") as { paused?: boolean } | null)?.paused === false,
      "running in the store",
    );
    const resumedAt = Date.now();
    await waitFor(() => clock() - atStop > 200, "clock resumed");
    await new Promise((r) => setTimeout(r, Math.max(0, 300 - (Date.now() - resumedAt))));
    const moved = clock() - atStop;
    assert.ok(moved < 1000, `clock moved ${moved} ms across a 1.5 s stop (menu time not counted)`);
    assert.equal(source.link().connected, true);
    for (const f of frames) assert.equal(f.source, "sim");
    await session.stop();
  });
});

describe("SimConnect emulator: connection loss (PC-13 logic)", () => {
  it("drop → offline → simulator back → live again without a restart", async () => {
    const h = await harness();
    await waitFor(() => latest(h.updates, "sim"), "first session data");
    const mark = h.updates.length;
    h.emu.setAccepting(false); // the simulator is gone for a while
    h.emu.drop();
    const lost = await waitFor(
      () => h.updates.slice(mark).find((u) => u.type === "disconnected"),
      "disconnected",
    );
    assert.deepEqual(lost, { type: "disconnected", reason: "SimConnect connection closed" });
    assert.equal(h.source.link().connected, false);
    assert.deepEqual(events(h.updates, "sim.disconnected", mark), [
      { reason: "SimConnect connection closed" },
    ]);
    await waitFor(
      () => h.logs.some((l) => /Simulator not reachable/.test(l.message)),
      "a failed reconnect attempt",
    );
    const accepted = h.emu.connectionsAccepted;
    h.emu.setAccepting(true);
    await waitFor(() => connectedUpdates(h.updates.slice(mark))[0], "reconnected");
    assert.equal(h.source.link().connected, true);
    assert.ok(h.emu.connectionsAccepted > accepted);
    // The new session redefines everything and data flows again.
    const mark2 = h.updates.length;
    await waitFor(() => latest(h.updates, "payload", mark2), "slow data again");
    await waitFor(() => latest(h.updates, "position", mark2), "fast data again");
    assert.equal(h.emu.openConnections, 1);
  });

  it("RECV_QUIT → offline with reason 'simulator quit', then reconnects", async () => {
    const h = await harness();
    await waitFor(() => latest(h.updates, "position"), "data");
    const mark = h.updates.length;
    h.emu.quit();
    const lost = await waitFor(
      () => h.updates.slice(mark).find((u) => u.type === "disconnected"),
      "disconnected",
    );
    assert.deepEqual(lost, { type: "disconnected", reason: "simulator quit" });
    await waitFor(() => connectedUpdates(h.updates.slice(mark))[0], "reconnected");
    await waitFor(() => latest(h.updates, "position", mark), "data again");
  });
});

describe("SimConnect emulator: AI traffic by type (PC-38 logic)", () => {
  const KMEM = { fboId: "fbo-1", icao: "KMEM", lat: 35.0424, lon: -89.9767 };
  const ai = (
    objectId: number,
    lat: number,
    lon: number,
    onGround: number,
    gs: number,
    atc: string,
  ) => ({
    objectId,
    values: {
      "PLANE LATITUDE": lat,
      "PLANE LONGITUDE": lon,
      "SIM ON GROUND": onGround,
      "GROUND VELOCITY": gs,
      "ATC ID": atc,
    },
  });
  const traffic = [
    ai(201, 35.06, -89.98, 0, 140, "FDX123"),
    ai(202, 35.04, -89.97, 1, 12, "DAL456"),
    ai(203, 40.64, -73.78, 1, 0, "JBU1"), // JFK: outside the request radius
  ];

  for (const first of [1, 0] as const) {
    it(`requests AIRCRAFT within 200 km, reads every entry (numbering from ${first}), skips the user aircraft`, async () => {
      const h = await harness(
        { aiObjects: traffic, byTypeFirstEntry: first },
        { aiSampleIntervalMs: 100 },
      );
      h.source.setAiTargetsProvider(() => [KMEM]);
      const batch = await waitFor(
        () =>
          h.updates.find(
            (u): u is Extract<SimUpdate, { type: "aiTraffic" }> => u.type === "aiTraffic",
          ),
        "an AI batch",
      );
      const req = h.emu.packets.find((p) => p.fn === FN.REQUEST_DATA_ON_SIM_OBJECT_TYPE);
      assert.ok(req);
      assert.equal(req.fields["type"], 2, "SIMCONNECT_SIMOBJECT_TYPE_AIRCRAFT");
      assert.ok(Number(req.fields["radius"]) <= 200_000);
      assert.deepEqual(
        batch.samples.sort((a, b) => a.objectId - b.objectId),
        [
          { objectId: 201, lat: 35.06, lon: -89.98, onGround: false, gsKt: 140, atcId: "FDX123" },
          { objectId: 202, lat: 35.04, lon: -89.97, onGround: true, gsKt: 12, atcId: "DAL456" },
        ],
      );
      assert.ok(
        !batch.samples.some((s) => s.objectId === h.emu.userObjectId),
        "user aircraft excluded",
      );
      assert.equal(h.logs.filter((l) => /exception/i.test(l.message)).length, 0);
      // A second sample is taken on the next interval (the first one completed).
      await waitFor(
        () => h.updates.filter((u) => u.type === "aiTraffic").length >= 2,
        "a second AI batch",
      );
    });
  }

  it("an empty area gives an empty batch; no FBO in reach sends no request", async () => {
    const h = await harness(
      { aiObjects: [], includeUserInTypeRequests: false },
      { aiSampleIntervalMs: 100 },
    );
    let targets: (typeof KMEM)[] = [];
    h.source.setAiTargetsProvider(() => targets);
    await waitFor(() => latest(h.updates, "position"), "position");
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(
      h.emu.packets.filter((p) => p.fn === FN.REQUEST_DATA_ON_SIM_OBJECT_TYPE).length,
      0,
    );
    targets = [KMEM];
    const batch = await waitFor(
      () =>
        h.updates.find(
          (u): u is Extract<SimUpdate, { type: "aiTraffic" }> => u.type === "aiTraffic",
        ),
      "an empty batch",
    );
    assert.deepEqual(batch.samples, []);
  });
});

describe("SimConnect emulator: payload check against the sim (PC-49 logic)", () => {
  // The real SimConnectSource feeding a ConnectorSession with the economy engine: the
  // mission's cargo is compared with PAYLOAD STATION WEIGHT:n as decoded off the wire.
  interface PayloadRig {
    emu: SimConnectEmulator;
    session: ConnectorSession;
    source: SimConnectSource;
    frames: Frame[];
    cmd(name: string, args?: unknown): Result;
    mission(): Mission | null;
  }
  const rigs: PayloadRig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) {
      await r.source.stop();
      await r.emu.close();
    }
  });

  async function payloadRig(values: Record<string, SimValue>): Promise<PayloadRig> {
    const emu = await SimConnectEmulator.start({ secondMs: 100, simFrameMs: 40, values });
    const source = new SimConnectSource({
      log: () => {},
      remote: { host: "127.0.0.1", port: emu.port },
      retryMinMs: 100,
      retryMaxMs: 400,
    });
    let n = 0;
    const session = new ConnectorSession(source, () => {}, {
      economy: { airports: loadAirportsData().airports, seed: 4242, newId: () => `M-${++n}` },
    });
    const frames: Frame[] = [];
    session.store.subscribe((f) => frames.push(f));
    session.start();
    const r: PayloadRig = {
      emu,
      session,
      source,
      frames,
      cmd: (name, args = {}) =>
        session.command({
          type: "command",
          v: PROTOCOL_VERSION,
          id: `c${++n}`,
          name,
          args,
        } as Command),
      mission: () => (session.store.getDomain("mission") ?? null) as Mission | null,
    };
    rigs.push(r);
    source.start();
    return r;
  }

  function ok<T>(r: PayloadRig, name: string, args: unknown = {}): T {
    const res = r.cmd(name, args);
    if (!res.ok) assert.fail(`${name}: ${res.error.code} ${res.error.message}`);
    return res.data as T;
  }

  async function loadKatlMission(r: PayloadRig): Promise<Mission> {
    // The aircraft title must have reached the engine so the fleet C208B is selected.
    await waitFor(() => r.session.store.getDomain("payload"), "payload stations from the sim");
    // …and a few fast frames after it, so the flight core's last sample has the brake set
    // (unchanged values produce no store delta, so wait on the clock: 5 Hz → ≥ 2 samples).
    await waitFor(() => r.session.store.getDomain("controls"), "controls from the sim");
    await new Promise((res) => setTimeout(res, 500));
    ok(r, "jobs.refresh", { airport: "KMEM", destination: "KATL" });
    const jobs = r.session.store.getDomain("jobs") as JobsState;
    const job = jobs.available.find((j) => j.destination === "KATL");
    assert.ok(job, "a KATL job on the focused board");
    ok(r, "job.accept", { jobId: job.id });
    return ok<Mission>(r, "mission.load", { jobIds: [job.id] });
  }

  it("preview follows the stations live (source 'sim'), MTOW refuses, departure freezes it", async () => {
    // Pilot 170 lb + 400 lb cargo: 258.5 kg − 77.1 kg = 181.4 kg on board.
    const r = await payloadRig(CARAVAN);
    const m = await loadKatlMission(r);
    const cargo = m.payloadKg;
    assert.ok(cargo > 181.4 + Math.max(25, cargo * 0.1), `cargo ${cargo} kg`);
    const preview = await waitFor(
      () => (r.mission()?.payloadCheck?.status === "underloaded" ? r.mission() : null),
      "an underloaded preview",
    );
    assert.equal(preview.payloadCheck?.stage, "preview");
    assert.equal(preview.payloadCheck?.source, "sim");
    assert.equal(preview.payloadCheck?.simPayloadKg, 258.5);
    assert.equal(preview.payloadCheck?.crewBasis, "stations");
    assert.equal(preview.payloadCheck?.loadedKg, 181.4);

    // The pilot loads the cargo in the sim: the preview turns ok on the next SECOND frame.
    const cargoLb = Math.ceil(cargo / 0.45359237);
    // (TOTAL WEIGHT stays under the 8,807 lb MAX GROSS WEIGHT: less fuel on board.)
    r.emu.set({ "PAYLOAD STATION WEIGHT:2": cargoLb, "TOTAL WEIGHT": 8600 });
    await waitFor(() => r.mission()?.payloadCheck?.status === "ok", "an ok preview");

    // Over MAX GROSS WEIGHT: the preview warns and an explicit start is refused.
    r.emu.set({ "TOTAL WEIGHT": 9000 });
    await waitFor(() => r.mission()?.payloadCheck?.status === "overloaded", "overloaded");
    const refused = r.cmd("flight.start");
    assert.equal(!refused.ok && refused.error.code, "over_mtow");

    // Back to 400 lb of cargo: the start goes ahead with a warning and loses the bonuses.
    r.emu.set({ "PAYLOAD STATION WEIGHT:2": 400, "TOTAL WEIGHT": 7417.9 });
    await waitFor(() => r.mission()?.payloadCheck?.status === "underloaded", "underloaded again");
    ok(r, "flight.start");
    const flying = r.mission();
    assert.equal(flying?.status, "in_progress");
    assert.equal(flying?.payloadCheck?.stage, "departure");
    assert.equal(flying?.payloadCheck?.status, "underloaded");
    assert.equal(flying?.payloadCheck?.source, "sim");
    const ev = r.frames.find((f) => f.type === "event" && f.name === "mission.payload_check");
    assert.ok(ev && ev.type === "event");
    assert.equal(ev.source, "sim");
    assert.equal((ev.data as { payoutBonuses: boolean }).payoutBonuses, false);

    // Frozen: loading the cargo after departure does not change the departure check.
    r.emu.set({ "PAYLOAD STATION WEIGHT:2": cargoLb });
    await new Promise((res) => setTimeout(res, 300));
    assert.equal(r.mission()?.payloadCheck?.status, "underloaded");
  });

  it("MSFS quits: start refused (sim_offline), phase/flight cleared, preview unknown; back → start", async () => {
    const r = await payloadRig(CARAVAN);
    await loadKatlMission(r);
    await waitFor(() => r.mission()?.payloadCheck?.status === "underloaded", "a live preview");
    await waitFor(() => r.session.store.getDomain("phase"), "a phase from the sim");

    r.emu.setAccepting(false); // MSFS is closed for a while
    r.emu.quit();
    await waitFor(() => !r.source.link().connected, "link down");
    assert.equal(r.session.welcome().sim.connected, false);
    const state = r.session.store.snapshot().state;
    for (const domain of [
      "position",
      "motion",
      "controls",
      "payload",
      "phase",
      "flight",
    ] as const) {
      assert.equal(state[domain] ?? null, null, `${domain} cleared`);
    }
    // The last parked, brake-set sample must not let a flight start while MSFS is gone.
    const refused = r.cmd("flight.start");
    assert.equal(!refused.ok && refused.error.code, "sim_offline");
    // The payload preview no longer claims what the sim reported before it quit.
    const preview = r.mission()?.payloadCheck;
    assert.equal(preview?.stage, "preview");
    assert.equal(preview?.status, "unknown");
    assert.equal(preview?.simPayloadKg, undefined);
    assert.equal(r.mission()?.status, "loaded", "the mission itself stays loaded");

    r.emu.setAccepting(true);
    await waitFor(() => r.source.link().connected, "reconnected");
    await waitFor(() => r.mission()?.payloadCheck?.status === "underloaded", "live preview again");
    await waitFor(() => r.session.store.getDomain("phase"), "phase again");
    ok(r, "flight.start");
    assert.equal(r.mission()?.status, "in_progress");
  });

  it("an aircraft with no payload stations → unknown, the start is not penalised", async () => {
    const r = await payloadRig({ ...CARAVAN, "PAYLOAD STATION COUNT": 0 });
    await loadKatlMission(r);
    await waitFor(() => r.mission()?.payloadCheck?.status === "unknown", "unknown preview");
    ok(r, "flight.start");
    const m = r.mission();
    assert.equal(m?.payloadCheck?.stage, "departure");
    assert.equal(m?.payloadCheck?.status, "unknown");
    assert.equal(m?.payloadCheck?.simPayloadKg, undefined);
    const ev = r.frames.find((f) => f.type === "event" && f.name === "mission.payload_check");
    assert.equal(
      ev?.type === "event" && (ev.data as { payoutBonuses: boolean }).payoutBonuses,
      true,
    );
  });
});

describe("SimConnect emulator: GPS flight plan and destination (PC-55 logic)", () => {
  /** Last leg of a KMEM → KATL GPS plan, values in the units the connector asks for. */
  const GPS_LAST_LEG: Record<string, SimValue> = {
    "GPS IS ACTIVE FLIGHT PLAN": 1,
    "GPS FLIGHT PLAN WP COUNT": 2,
    "GPS FLIGHT PLAN WP INDEX": 1,
    "GPS WP NEXT ID": "KATL",
    "GPS WP NEXT LAT": 33.6367,
    "GPS WP NEXT LON": -84.4281,
    "GPS WP DISTANCE": 287.7,
    "GPS WP ETE": 6905,
    "GPS ETE": 6905,
    "GPS APPROACH AIRPORT ID": "",
  };
  const GPS_OFF: Record<string, SimValue> = {
    "GPS IS ACTIVE FLIGHT PLAN": 0,
    "GPS FLIGHT PLAN WP COUNT": 0,
    "GPS FLIGHT PLAN WP INDEX": 0,
    "GPS WP NEXT ID": "",
    "GPS WP DISTANCE": 0,
    "GPS WP ETE": 0,
    "GPS ETE": 0,
  };

  interface PlanRig {
    emu: SimConnectEmulator;
    session: ConnectorSession;
    source: SimConnectSource;
    frames: Frame[];
    plan(): Record<string, unknown> | null;
    cmd(name: string, args?: unknown): Result;
  }
  const rigs: PlanRig[] = [];
  afterEach(async () => {
    for (const r of rigs.splice(0)) {
      await r.source.stop();
      await r.emu.close();
    }
  });

  async function planRig(options: EmulatorOptions): Promise<PlanRig> {
    const emu = await SimConnectEmulator.start({ secondMs: 100, simFrameMs: 40, ...options });
    const source = new SimConnectSource({
      log: () => {},
      remote: { host: "127.0.0.1", port: emu.port },
      retryMinMs: 100,
      retryMaxMs: 400,
    });
    const session = new ConnectorSession(source, () => {}, {
      airports: loadAirportsData().airports,
    });
    const frames: Frame[] = [];
    session.store.subscribe((f) => frames.push(f));
    session.start();
    let n = 0;
    const r: PlanRig = {
      emu,
      session,
      source,
      frames,
      plan: () => (session.store.getDomain("plan") ?? null) as Record<string, unknown> | null,
      cmd: (name, args = {}) =>
        session.command({
          type: "command",
          v: PROTOCOL_VERSION,
          id: `p${++n}`,
          name,
          args,
        } as Command),
    };
    rigs.push(r);
    source.start();
    return r;
  }

  it("source: GPS active → plan (source 'sim'), then inactive → null; stale EFB values → null", async () => {
    const h = await harness({ values: { ...CARAVAN, ...GPS_LAST_LEG } });
    const plan = await waitFor(() => latest(h.updates, "plan"), "a GPS plan");
    assert.deepEqual(plan, {
      active: true,
      basis: "gps",
      wpCount: 2,
      wpIndex: 1,
      nextWpId: "KATL",
      nextWpLat: 33.6367,
      nextWpLon: -84.4281,
      nextWpDistanceNm: 287.7,
      nextWpEteSec: 6905,
      eteSec: 6905,
      destination: "KATL",
      destDistanceNm: 287.7,
    });
    // GPS IS ACTIVE FLIGHT PLAN, WP NEXT ID and APPROACH AIRPORT ID were requested as strings
    // / bools in the units of the table; nothing was rejected.
    const defined = h.emu.packets.filter((p) => p.fn === FN.ADD_TO_DATA_DEFINITION);
    const nextId = defined.find((p) => p.fields["name"] === "GPS WP NEXT ID");
    assert.equal(nextId?.fields["type"], DATATYPE.STRING64);
    const dist = defined.find((p) => p.fields["name"] === "GPS WP DISTANCE");
    assert.equal(dist?.fields["unit"], "nautical miles");
    assert.equal(h.logs.filter((l) => /SimConnect rejected/.test(l.message)).length, 0);

    // The pilot deactivates the plan: the source reports "no plan" (null), not stale values.
    let mark = h.updates.length;
    h.emu.set(GPS_OFF);
    await waitFor(() => latest(h.updates, "plan", mark) === null, "plan null after deactivation");

    // MSFS 2024 EFB plan: the flag is set but the GPS values are empty → still no plan.
    h.emu.set({ "GPS IS ACTIVE FLIGHT PLAN": 1, "GPS FLIGHT PLAN WP COUNT": 3 });
    mark = h.updates.length;
    await waitFor(
      () =>
        h.updates.slice(mark).filter((u) => u.type === "data" && u.patch.plan !== undefined)
          .length >= 3,
      "three slow frames",
    );
    assert.ok(
      h.updates
        .slice(mark)
        .every((u) => u.type !== "data" || u.patch.plan === undefined || u.patch.plan === null),
      "an empty active plan is never reported",
    );
  });

  it("rejected GPS SimVars degrade through the rebuild: no flag → no plan; no next id → no ident", async () => {
    const h = await harness({
      values: { ...CARAVAN, ...GPS_LAST_LEG },
      reject: ["GPS IS ACTIVE FLIGHT PLAN"],
    });
    await waitFor(
      () => h.logs.some((l) => /SimConnect rejected "GPS IS ACTIVE FLIGHT PLAN"/.test(l.message)),
      "rejection",
    );
    let mark = h.updates.length;
    await waitFor(() => latest(h.updates, "fuel", mark), "slow data after the rebuild");
    assert.equal(latest(h.updates, "plan", mark), null, "without the flag there is no GPS plan");

    const h2 = await harness({
      values: { ...CARAVAN, ...GPS_LAST_LEG },
      reject: ["GPS WP NEXT ID"],
    });
    await waitFor(
      () => h2.logs.some((l) => /SimConnect rejected "GPS WP NEXT ID"/.test(l.message)),
      "rejection",
    );
    mark = h2.updates.length;
    const plan = await waitFor(() => latest(h2.updates, "plan", mark), "plan after the rebuild");
    assert.equal(plan.active, true);
    assert.equal(plan.nextWpId, undefined, "never guessed");
    assert.equal(plan.destination, undefined, "no ident without GPS WP NEXT ID");
    assert.equal(plan.eteSec, 6905);
    assert.ok(latest(h2.updates, "fuel", mark));
  });

  it("session: manual KATL, GPS plan takes over (gps), GPS off → manual again; frames are 'sim'", async () => {
    const r = await planRig({ values: { ...CARAVAN, ...GPS_OFF } });
    await waitFor(() => r.session.store.getDomain("position"), "position from the sim");
    await waitFor(() => r.session.store.getDomain("fuel"), "slow data from the sim");
    assert.equal(r.plan(), null, "no GPS plan, no manual choice, no mission");

    const set = r.cmd("plan.destination", { icao: "KATL" });
    assert.ok(set.ok);
    const manual = r.plan();
    assert.equal(manual?.["basis"], "manual");
    assert.equal(manual?.["destination"], "KATL");
    assert.equal(manual?.["origin"], "KMEM");
    assert.ok(Math.abs((manual?.["destDistanceNm"] as number) - 286.6) < 2);
    assert.equal(manual?.["eteSec"], undefined, "parked: no ETE");

    // A GPS plan is activated in the sim: it wins.
    r.emu.set({ ...GPS_LAST_LEG, "GPS WP DISTANCE": 280.1, "GPS ETE": 6700 });
    const gps = await waitFor(
      () => (r.plan()?.["basis"] === "gps" ? r.plan() : null),
      "GPS plan in use",
    );
    assert.equal(gps["destDistanceNm"], 280.1, "the GPS's own distance");
    assert.equal(gps["eteSec"], 6700, "the GPS's own ETE");
    assert.equal(gps["origin"], undefined, "the GPS does not tell the origin");

    // Deactivated: back to the manual destination, no GPS leftovers.
    r.emu.set(GPS_OFF);
    const back = await waitFor(
      () => (r.plan()?.["basis"] === "manual" ? r.plan() : null),
      "manual again",
    );
    assert.equal(back["nextWpId"], undefined);
    assert.equal(back["eteSec"], undefined);
    const planDeltas = r.frames.filter(
      (f) => f.type === "delta" && (f.patch as Record<string, unknown>)["plan"] !== undefined,
    );
    assert.ok(planDeltas.length >= 3);
    assert.ok(planDeltas.every((f) => f.source === "sim"));

    // The simulator quits: the plan is cleared with the other sim-derived domains.
    r.emu.setAccepting(false);
    r.emu.quit();
    await waitFor(() => r.plan() === null && !r.source.link().connected, "plan cleared offline");
  });

  it("SimStop (main menu) is a pause: the plan stays published; menu frames are still resolved", async () => {
    const r = await planRig({ values: { ...CARAVAN, ...GPS_LAST_LEG } });
    await waitFor(() => (r.plan()?.["basis"] === "gps" ? r.plan() : null), "GPS plan in use");
    const sim = () => r.session.store.getDomain("sim") as { paused?: boolean } | null;

    // Back to the main menu, the sim sends no frames: the last plan stays, nothing cleared.
    let mark = r.frames.length;
    r.emu.simStop();
    await waitFor(() => sim()?.paused === true, "paused by SimStop");
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(r.source.link().connected, true, "a stop is not a disconnect");
    assert.equal(r.plan()?.["basis"], "gps");
    assert.equal(r.plan()?.["destination"], "KATL");
    const planPatches = (from: number) =>
      r.frames
        .slice(from)
        .filter(
          (f) => f.type === "delta" && (f.patch as Record<string, unknown>)["plan"] !== undefined,
        );
    assert.equal(planPatches(mark).length, 0, "no plan change while the menu sends nothing");
    // A destination can still be picked in the menu (it lasts for the paused flight).
    const pick = r.cmd("plan.destination", { icao: "KBNA" });
    assert.ok(pick.ok);
    assert.equal(r.plan()?.["basis"], "gps", "the active GPS plan still wins");

    // The sim does send frames in the menu and the plan was cleared there: that is real
    // data, so it is resolved as usual (manual pick, never a kept GPS plan).
    r.emu.simStart();
    await waitFor(() => sim()?.paused === false, "running again");
    r.emu.simStop({ haltFrames: false });
    await waitFor(() => sim()?.paused === true, "paused again");
    mark = r.frames.length;
    r.emu.set(GPS_OFF);
    const manual = await waitFor(
      () => (r.plan()?.["basis"] === "manual" ? r.plan() : null),
      "manual from a menu frame",
    );
    assert.equal(manual["destination"], "KBNA");
    assert.equal(manual["eteSec"], undefined, "parked: no ETE");
    assert.ok(planPatches(mark).every((f) => f.source === "sim"));

    // SimStart: the GPS plan is back from the next frames.
    r.emu.set(GPS_LAST_LEG);
    r.emu.simStart();
    await waitFor(() => (r.plan()?.["basis"] === "gps" ? r.plan() : null), "GPS plan again");
  });
});

describe("SimConnect emulator: real connector CLI end to end", () => {
  let child: ChildProcess | null = null;
  let emu: SimConnectEmulator | null = null;
  const tmp = tempDir();

  after(async () => {
    if (child && child.exitCode === null) {
      const exited = new Promise((r) => child?.once("exit", r));
      child.kill();
      await exited;
    }
    await emu?.close();
    tmp.cleanup();
  });

  it("CLI with --simconnect-host/--simconnect-port: welcome is live MSFS 2024, frames are source 'sim'", async () => {
    emu = await SimConnectEmulator.start({ values: CARAVAN, secondMs: 200 });
    child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        MAIN,
        "--port",
        "0",
        "--data-dir",
        tmp.dir,
        "--simconnect-host",
        "127.0.0.1",
        "--simconnect-port",
        String(emu.port),
      ],
      { stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
    );
    let out = "";
    child.stdout?.setEncoding("utf8").on("data", (s: string) => (out += s));
    child.stderr?.setEncoding("utf8").on("data", (s: string) => (out += s));
    const port = await waitFor(
      () => /Cargo Ops is running at http:\/\/127\.0\.0\.1:(\d+)\//.exec(out)?.[1],
      "the connector to listen",
      15_000,
    ).catch((err: Error) => {
      throw new Error(`${err.message}\n--- connector output ---\n${out}`);
    });
    // The connector itself connected to the emulator.
    await waitFor(() => emu?.openConnections === 1, "SimConnect session", 10_000);
    await waitFor(() => /Connected to SunRise \(MSFS 2024\)/.test(out), "connected log line");

    const token = (JSON.parse(readFileSync(configPath(tmp.dir), "utf8")) as { token: string })
      .token;
    const client = await connectClient(`ws://127.0.0.1:${port}/ws`, `http://127.0.0.1:${port}`);
    // Every failure below carries the connector's output and what the client received.
    const diag = () =>
      `\n--- received: ${client.messages.map((m) => m.type).join(", ") || "nothing"}` +
      `\n--- connector output ---\n${out}`;
    const onlyFrames = (m: ServerMessage) =>
      (m.type === "snapshot" || m.type === "delta") && "source" in m && m.source === "sim";
    try {
      client.send(hello(token));
      const welcome = await client
        .next((m) => m.type === "welcome", 10_000)
        .catch((err: Error) => {
          throw new Error(`welcome: ${err.message}${diag()}`);
        });
      assert.equal(welcome.type, "welcome");
      if (welcome.type !== "welcome") return;
      assert.equal(welcome.mode, "live", diag());
      assert.deepEqual(
        welcome.sim,
        { connected: true, name: "MSFS 2024", version: "12.1.282174.999", protocol: "SunRise" },
        diag(),
      );
      // Telemetry from the emulator reaches the browser side. Deltas only carry what changed,
      // so the position is in the snapshot when the connector had it before the hello (as on
      // a slower Windows runner) and in a later delta otherwise: look at every frame received.
      await waitFor(
        () =>
          client.messages.some(
            (m) =>
              onlyFrames(m) &&
              ((m.type === "snapshot" && m.state.position?.lat === 35.0424) ||
                (m.type === "delta" && m.patch.position?.lat === 35.0424)),
          ),
        "a sim frame with the emulated position",
        10_000,
      ).catch((err: Error) => {
        throw new Error(`${err.message}${diag()}`);
      });
      for (const m of client.messages) {
        if ("source" in m) assert.equal(m.source, "sim", `${m.type} frame source${diag()}`);
      }
    } finally {
      client.ws.close();
    }
  });
});
