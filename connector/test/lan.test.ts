// LAN opt-in (plan §3.2): off by default, pairing instead of silent token delivery, brute-force
// protection, revocation, Host/Origin allowlist of bound addresses, local-only destructive
// routes. LAN clients are played over 127.0.0.1 with an injected address classifier and an
// injected interface address (192.0.2.77, TEST-NET-1), so these tests do not depend on the
// machine's network; one extra test uses a real non-loopback address when the host has one.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { connect } from "node:net";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startConnector, type RunningConnector } from "../src/cli/app";
import { parseArgs } from "../src/cli/args";
import { configPath, loadOrCreateConfig, saveLanSetting } from "../src/core/config";
import {
  FAILURE_WINDOW_MS,
  LOCKOUT_MS,
  LanAccess,
  MAX_FAILURES_PER_ADDRESS,
  MAX_FAILURES_PER_CODE,
  PAIRING_CODE_TTL_MS,
  clearLanDevices,
  formatPairingCode,
  isLocalOnlyRoute,
  isLoopbackAddress,
  lanDevicesPath,
  lanInterfaceAddresses,
  normalizePairingCode,
  sanitizeDeviceName,
  validateLanBind,
} from "../src/server/lan";
import { FakeSource } from "../src/sim/fake-source";
import { connectClient, hello, shortFixture, tempDir, upgradeStatus } from "./helpers";
import { PROTOCOL_VERSION } from "../src/protocol";

const LAN_IP = "192.0.2.77";

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  json: () => Record<string, unknown>;
}

function http(
  port: number,
  method: string,
  path: string,
  opts: { host?: string; origin?: string; token?: string; body?: unknown; connectTo?: string } = {},
): Promise<Res> {
  return new Promise((resolve, reject) => {
    const payload = opts.body === undefined ? undefined : JSON.stringify(opts.body);
    const headers: Record<string, string> = { Host: opts.host ?? `127.0.0.1:${port}` };
    if (opts.origin) headers["Origin"] = opts.origin;
    if (opts.token) headers["Authorization"] = `Bearer ${opts.token}`;
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    const req = request(
      { host: opts.connectTo ?? "127.0.0.1", port, path, method, headers },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: () => JSON.parse(body) as Record<string, unknown>,
          }),
        );
      },
    );
    req.on("error", reject);
    req.end(payload);
  });
}

/** Resolves true when a TCP connection to host:port opens. */
function canConnect(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
  });
}

const realLanIp = lanInterfaceAddresses()[0];

function fake() {
  return new FakeSource({ frames: shortFixture(), speed: 1, loop: true, loopGapMs: 200 });
}

// ---------------------------------------------------------------------------------------

describe("LAN helpers", () => {
  it("classifies loopback addresses", () => {
    for (const a of ["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"]) {
      assert.equal(isLoopbackAddress(a), true, a);
    }
    for (const a of ["192.168.1.5", "::ffff:192.168.1.5", "10.0.0.1", "fe80::1", "", undefined]) {
      assert.equal(isLoopbackAddress(a), false, String(a));
    }
  });

  it("lists non-internal IPv4 interface addresses only", () => {
    const nets = {
      lo: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
      eth0: [
        { address: "192.168.1.5", family: "IPv4", internal: false },
        { address: "fe80::1", family: "IPv6", internal: false },
      ],
      wlan0: [{ address: "10.0.0.7", family: "IPv4", internal: false }],
    } as unknown as Parameters<typeof lanInterfaceAddresses>[0];
    assert.deepEqual(lanInterfaceAddresses(nets), ["192.168.1.5", "10.0.0.7"]);
  });

  it("validates a bind address against this PC's interfaces", () => {
    const here = ["192.168.1.5"];
    assert.equal(validateLanBind("0.0.0.0", here), null);
    assert.equal(validateLanBind("192.168.1.5", here), null);
    assert.match(validateLanBind("192.168.1.6", here) ?? "", /not an address of this PC/);
    assert.match(validateLanBind("127.0.0.1", here) ?? "", /loopback/);
    assert.match(validateLanBind("example.com", here) ?? "", /IPv4 literal/);
    assert.match(validateLanBind("::", here) ?? "", /IPv6/);
  });

  it("normalises and formats pairing codes and device names", () => {
    assert.equal(normalizePairingCode(" abcd-efgh "), "ABCDEFGH");
    assert.equal(normalizePairingCode(42), "");
    assert.equal(formatPairingCode("ABCDEFGH"), "ABCD-EFGH");
    assert.equal(sanitizeDeviceName("  Kitchen\n tablet  "), "Kitchen tablet");
    assert.equal(sanitizeDeviceName(""), "LAN device");
    assert.equal(sanitizeDeviceName("x".repeat(100)).length, 40);
  });

  it("keeps destructive data actions and LAN management local-only", () => {
    assert.equal(isLocalOnlyRoute("POST", "/api/import"), true);
    assert.equal(isLocalOnlyRoute("POST", "/api/backups"), true);
    assert.equal(isLocalOnlyRoute("DELETE", "/api/simbrief/plan"), true);
    assert.equal(isLocalOnlyRoute("GET", "/api/lan"), true);
    assert.equal(isLocalOnlyRoute("DELETE", "/api/lan/devices/x"), true);
    assert.equal(isLocalOnlyRoute("GET", "/api/backups"), false);
    assert.equal(isLocalOnlyRoute("GET", "/api/jobs"), false);
    assert.equal(isLocalOnlyRoute("GET", "/api/export/json"), false);
    assert.equal(isLocalOnlyRoute("PUT", "/api/simbrief"), false);
  });
});

describe("LanAccess pairing", () => {
  it("pairs once with the right code (any case, dashes ignored); the code is single-use", () => {
    let now = 1_000_000;
    const lan = new LanAccess({ dataDir: null, now: () => now });
    const { code } = lan.createCode();
    assert.match(code, /^[A-HJKMNP-Z2-9]{8}$/);
    const r = lan.pair(formatPairingCode(code).toLowerCase(), "Tablet", "192.168.1.20");
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.match(r.token, /^[0-9a-f]{64}$/);
    assert.equal(r.device.name, "Tablet");
    assert.equal(r.device.pairedFrom, "192.168.1.20");
    assert.equal(lan.verify(r.token)?.id, r.device.id);
    now += 1000;
    assert.equal(lan.verify(r.token)?.lastSeenAt, new Date(now).toISOString());
    const again = lan.pair(code, "Second", "192.168.1.21");
    assert.equal(again.ok, false);
    assert.equal(lan.currentCode(), null);
  });

  it("refuses a wrong code and an expired one", () => {
    let now = 0;
    const lan = new LanAccess({ dataDir: null, now: () => now });
    const { code } = lan.createCode();
    const wrong = lan.pair("AAAAAAAA" === code ? "BBBBBBBB" : "AAAAAAAA", "x", "10.0.0.2");
    assert.equal(wrong.ok, false);
    if (!wrong.ok) assert.equal(wrong.code, "invalid_code");
    now += PAIRING_CODE_TTL_MS;
    const expired = lan.pair(code, "x", "10.0.0.3");
    assert.equal(expired.ok, false);
    if (!expired.ok) assert.equal(expired.status, 401);
    assert.equal(lan.devices().length, 0);
  });

  it("locks an address out after repeated wrong codes, then lets it try again", () => {
    let now = 0;
    const lan = new LanAccess({ dataDir: null, now: () => now });
    const { code } = lan.createCode();
    for (let i = 0; i < MAX_FAILURES_PER_ADDRESS; i++) lan.pair("ZZZZZZZZ", "x", "10.0.0.9");
    const locked = lan.pair(code, "x", "10.0.0.9");
    assert.equal(locked.ok, false);
    if (!locked.ok) {
      assert.equal(locked.status, 429);
      assert.equal(locked.code, "pairing_locked");
      assert.equal(locked.retryAfterSec, LOCKOUT_MS / 1000);
    }
    // Another address is not affected, but this one stays locked until the lockout ends.
    now += LOCKOUT_MS - 1000;
    assert.equal(lan.lockedFor("10.0.0.9"), 1);
    lan.createCode();
    now += 1000;
    assert.equal(lan.lockedFor("10.0.0.9"), 0);
    const fresh = lan.createCode();
    assert.equal(lan.pair(fresh.code, "x", "10.0.0.9").ok, true);
  });

  it("forgets old failures outside the window", () => {
    let now = 0;
    const lan = new LanAccess({ dataDir: null, now: () => now });
    lan.createCode();
    for (let i = 0; i < MAX_FAILURES_PER_ADDRESS - 1; i++) lan.pair("ZZZZZZZZ", "x", "10.0.0.4");
    now += FAILURE_WINDOW_MS;
    lan.pair("ZZZZZZZZ", "x", "10.0.0.4");
    assert.equal(lan.lockedFor("10.0.0.4"), 0);
  });

  it("burns the code after too many wrong guesses from any addresses", () => {
    const lan = new LanAccess({ dataDir: null, now: () => 0 });
    const { code } = lan.createCode();
    for (let i = 0; i < MAX_FAILURES_PER_CODE; i++) lan.pair("ZZZZZZZZ", "x", `10.1.0.${i}`);
    assert.equal(lan.currentCode(), null);
    assert.equal(lan.pair(code, "x", "10.2.0.1").ok, false);
  });

  it("revokes a device and stores only token hashes on disk", () => {
    const tmp = tempDir();
    try {
      const lan = new LanAccess({ dataDir: tmp.dir });
      const r = lan.pair(lan.createCode().code, "Tablet", "192.168.1.20");
      assert.ok(r.ok);
      if (!r.ok) return;
      const file = readFileSync(lanDevicesPath(tmp.dir), "utf8");
      assert.ok(!file.includes(r.token), "the LAN token itself is never written");
      const reloaded = new LanAccess({ dataDir: tmp.dir });
      assert.equal(reloaded.verify(r.token)?.name, "Tablet");
      const revoked: string[] = [];
      reloaded.onRevoke((id) => revoked.push(id));
      assert.equal(reloaded.revoke(r.device.id), true);
      assert.deepEqual(revoked, [r.device.id]);
      assert.equal(reloaded.verify(r.token), null);
      assert.equal(new LanAccess({ dataDir: tmp.dir }).verify(r.token), null);
      assert.equal(reloaded.revoke("nope"), false);
      clearLanDevices(tmp.dir);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("LAN setting and CLI flags", () => {
  it("parses --lan, --lan <address>, --no-lan and defaults to the saved setting", () => {
    const def = parseArgs([]);
    assert.ok(def.ok && def.options.lan === undefined);
    const all = parseArgs(["--lan"]);
    assert.ok(all.ok && all.options.lan === "0.0.0.0");
    const one = parseArgs(["--lan", "192.168.1.5", "--port", "4312"]);
    assert.ok(one.ok && one.options.lan === "192.168.1.5" && one.options.port === 4312);
    const inline = parseArgs(["--lan=10.0.0.7"]);
    assert.ok(inline.ok && inline.options.lan === "10.0.0.7");
    const off = parseArgs(["--no-lan"]);
    assert.ok(off.ok && off.options.lan === false);
    assert.equal(parseArgs(["--lan="]).ok, false);
  });

  it("saves the LAN setting and keeps it across a token reset", () => {
    const tmp = tempDir();
    try {
      const first = loadOrCreateConfig(tmp.dir).config;
      assert.equal(first.lan, undefined, "LAN is off by default");
      saveLanSetting(tmp.dir, { enabled: true, address: "0.0.0.0" });
      const onDisk = JSON.parse(readFileSync(configPath(tmp.dir), "utf8")) as {
        token: string;
        lan: { enabled: boolean };
      };
      assert.equal(onDisk.token, first.token);
      assert.equal(onDisk.lan.enabled, true);
      const reset = loadOrCreateConfig(tmp.dir, { resetToken: true }).config;
      assert.notEqual(reset.token, first.token);
      assert.deepEqual(reset.lan, { enabled: true, address: "0.0.0.0" });
    } finally {
      tmp.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------------------

describe("connector without the LAN opt-in", () => {
  let tmp: ReturnType<typeof tempDir>;
  let connector: RunningConnector;

  before(async () => {
    tmp = tempDir();
    connector = await startConnector({
      sim: "fake",
      dataDir: join(tmp.dir, "data"),
      port: 0,
      quiet: true,
      source: fake(),
      lanInterfaces: () => [LAN_IP],
    });
  });
  after(async () => {
    await connector.stop();
    tmp.cleanup();
  });

  it("is off by default: loopback only, no LAN URLs, pairing refused", async () => {
    const port = connector.server.port;
    assert.equal(connector.lanBind, null);
    assert.deepEqual(connector.server.lanUrls(), []);
    const pair = await http(port, "POST", "/api/lan/pair", {
      origin: `http://127.0.0.1:${port}`,
      body: { code: "ABCDEFGH" },
    });
    assert.equal(pair.status, 404);
    assert.equal(pair.json()["error"], "lan_off");
    // The LAN address is not in the allowlist either.
    const host = await http(port, "GET", "/api/health", { host: `${LAN_IP}:${port}` });
    assert.equal(host.status, 421);
    const code = await http(port, "POST", "/api/lan/code", { token: connector.token });
    assert.equal(code.status, 409);
  });

  it("does not listen on a real non-loopback address", { skip: !realLanIp }, async () => {
    assert.equal(await canConnect(realLanIp as string, connector.server.port), false);
    assert.equal(await canConnect("127.0.0.1", connector.server.port), true);
  });

  it("saves the opt-in from /settings for the next start (restart required)", async () => {
    const port = connector.server.port;
    const bad = await http(port, "PUT", "/api/lan/settings", {
      token: connector.token,
      body: { enabled: true, address: "203.0.113.9" },
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.json()["error"], "bad_address");
    const saved = await http(port, "PUT", "/api/lan/settings", {
      token: connector.token,
      body: { enabled: true },
    });
    assert.equal(saved.status, 200);
    const view = saved.json();
    assert.equal(view["active"], false, "the running server is not rebound");
    assert.equal(view["restartRequired"], true);
    assert.deepEqual(view["setting"], { enabled: true, address: "0.0.0.0" });
  });
});

describe("persisted LAN setting on the next start", () => {
  it("binds after a restart, and --no-lan overrides it", async () => {
    const tmp = tempDir();
    const dataDir = join(tmp.dir, "data");
    try {
      saveLanSetting(dataDir, { enabled: true, address: "0.0.0.0" });
      const on = await startConnector({
        sim: "fake",
        dataDir,
        port: 0,
        quiet: true,
        source: fake(),
        lanInterfaces: () => [LAN_IP],
      });
      try {
        assert.equal(on.lanBind, "0.0.0.0");
        assert.deepEqual(on.server.lanUrls(), [`http://${LAN_IP}:${on.server.port}/`]);
        const view = await http(on.server.port, "GET", "/api/lan", { token: on.token });
        assert.equal(view.json()["restartRequired"], false);
      } finally {
        await on.stop();
      }
      const off = await startConnector({
        sim: "fake",
        dataDir,
        port: 0,
        quiet: true,
        source: fake(),
        lan: false,
        lanInterfaces: () => [LAN_IP],
      });
      try {
        assert.equal(off.lanBind, null);
        const view = await http(off.server.port, "GET", "/api/lan", { token: off.token });
        assert.equal(view.json()["restartRequired"], true);
      } finally {
        await off.stop();
      }
    } finally {
      tmp.cleanup();
    }
  });

  it("refuses to start on an address that is not this PC's", async () => {
    const tmp = tempDir();
    try {
      await assert.rejects(
        startConnector({
          sim: "fake",
          dataDir: join(tmp.dir, "data"),
          port: 0,
          quiet: true,
          source: fake(),
          lan: "203.0.113.9",
          lanInterfaces: () => [LAN_IP],
        }),
        /not an address of this PC/,
      );
    } finally {
      tmp.cleanup();
    }
  });
});

describe("connector with --lan (LAN client played over 127.0.0.1)", () => {
  let tmp: ReturnType<typeof tempDir>;
  let connector: RunningConnector;
  let port: number;
  let lanOrigin: string;
  let lanHost: string;
  /** When true the injected classifier treats 127.0.0.1 as a LAN client. */
  let asLan = false;
  let now = 1_700_000_000_000;

  const lanReq = (method: string, path: string, opts: { token?: string; body?: unknown } = {}) =>
    http(port, method, path, { host: lanHost, origin: lanOrigin, ...opts });

  async function withLan<T>(fn: () => Promise<T>): Promise<T> {
    asLan = true;
    try {
      return await fn();
    } finally {
      asLan = false;
    }
  }

  async function newCode(): Promise<string> {
    const r = await http(port, "POST", "/api/lan/code", { token: connector.token });
    assert.equal(r.status, 201);
    return (r.json()["code"] as { code: string }).code;
  }

  async function pairDevice(name: string): Promise<{ token: string; id: string }> {
    const code = await newCode();
    const r = await withLan(() => lanReq("POST", "/api/lan/pair", { body: { code, name } }));
    assert.equal(r.status, 200, r.body);
    const body = r.json() as { token: string; device: { id: string } };
    return { token: body.token, id: body.device.id };
  }

  before(async () => {
    tmp = tempDir();
    connector = await startConnector({
      sim: "fake",
      dataDir: join(tmp.dir, "data"),
      port: 0,
      quiet: true,
      source: fake(),
      lan: "0.0.0.0",
      lanInterfaces: () => [LAN_IP],
      isLocalAddress: (a) => !asLan && isLoopbackAddress(a),
      lanNow: () => now,
    });
    port = connector.server.port;
    lanOrigin = `http://${LAN_IP}:${port}`;
    lanHost = `${LAN_IP}:${port}`;
  });
  after(async () => {
    await connector.stop();
    tmp.cleanup();
  });

  it("binds and reports the LAN URL; this PC still gets its token", async () => {
    assert.equal(connector.lanBind, "0.0.0.0");
    assert.deepEqual(connector.server.lanUrls(), [`http://${LAN_IP}:${port}/`]);
    const session = await http(port, "GET", "/api/session");
    assert.equal(session.status, 200);
    assert.equal(session.json()["token"], connector.token);
    assert.equal(session.json()["scope"], "local");
    const view = await http(port, "GET", "/api/lan", { token: connector.token });
    assert.equal(view.status, 200);
    assert.equal(view.json()["active"], true);
    assert.deepEqual(view.json()["urls"], [`http://${LAN_IP}:${port}/`]);
  });

  it("never hands the main token to a LAN client", async () => {
    const r = await withLan(() => lanReq("GET", "/api/session"));
    assert.equal(r.status, 403);
    assert.equal(r.json()["error"], "pairing_required");
    assert.ok(!r.body.includes(connector.token));
    // Not even with the main token in hand: it is only valid from this PC.
    const status = await withLan(() => lanReq("GET", "/api/status", { token: connector.token }));
    assert.equal(status.status, 401);
    const asSession = await withLan(() =>
      lanReq("GET", "/api/session", { token: connector.token }),
    );
    assert.equal(asSession.status, 403);
  });

  it("pairs with the code from this PC and refuses a wrong one", async () => {
    const code = await newCode();
    const view = (await http(port, "GET", "/api/lan", { token: connector.token })).json() as {
      code: { code: string; display: string; pairUrls: string[] };
    };
    assert.equal(view.code.code, code);
    assert.deepEqual(view.code.pairUrls, [`http://${LAN_IP}:${port}/settings#pair=${code}`]);
    const wrong = await withLan(() =>
      lanReq("POST", "/api/lan/pair", { body: { code: code === "ZZZZZZZZ" ? "YYYYYYYY" : "ZZZZZZZZ" } }),
    );
    assert.equal(wrong.status, 401);
    assert.equal(wrong.json()["error"], "invalid_code");
    const ok = await withLan(() =>
      lanReq("POST", "/api/lan/pair", { body: { code: view.code.display, name: "Tablet" } }),
    );
    assert.equal(ok.status, 200);
    const body = ok.json() as { token: string; scope: string; device: { name: string } };
    assert.equal(body.scope, "lan");
    assert.equal(body.device.name, "Tablet");
    assert.notEqual(body.token, connector.token);
    // The paired device gets its own token back from /api/session and can use the API.
    const session = await withLan(() => lanReq("GET", "/api/session", { token: body.token }));
    assert.equal(session.status, 200);
    assert.equal(session.json()["token"], body.token);
    assert.equal(session.json()["scope"], "lan");
    const jobs = await withLan(() => lanReq("GET", "/api/jobs", { token: body.token }));
    assert.equal(jobs.status, 200);
    const backups = await withLan(() => lanReq("GET", "/api/backups", { token: body.token }));
    assert.equal(backups.status, 200);
    // Single use.
    const reuse = await withLan(() => lanReq("POST", "/api/lan/pair", { body: { code } }));
    assert.equal(reuse.status, 401);
  });

  it("gives a paired device full control over the WebSocket", async () => {
    const device = await pairDevice("Second PC");
    asLan = true;
    try {
      const client = await connectClient(`ws://127.0.0.1:${port}/ws`, lanOrigin);
      client.send(hello(device.token));
      const welcome = await client.next();
      assert.equal(welcome.type, "welcome");
      client.send({ type: "command", v: PROTOCOL_VERSION, id: "c1", name: "jobs.list", args: {} });
      const result = await client.next((m) => m.type === "result");
      assert.equal(result.type === "result" && result.ok, true);
      client.ws.close();
      // The main token is refused on a LAN socket.
      const intruder = await connectClient(`ws://127.0.0.1:${port}/ws`, lanOrigin);
      intruder.send(hello(connector.token));
      assert.equal((await intruder.closed).code, 4401);
    } finally {
      asLan = false;
    }
  });

  it("keeps destructive data actions and LAN management on this PC", async () => {
    const device = await pairDevice("Tablet 2");
    const t = device.token;
    const cases: Array<[string, string, unknown?]> = [
      ["POST", "/api/import", { format: "cargo-ops-career" }],
      ["POST", "/api/backups"],
      ["DELETE", "/api/simbrief/plan"],
      ["GET", "/api/lan"],
      ["POST", "/api/lan/code"],
      ["PUT", "/api/lan/settings", { enabled: false }],
      ["DELETE", `/api/lan/devices/${device.id}`],
    ];
    for (const [method, path, body] of cases) {
      const r = await withLan(() =>
        lanReq(method, path, body === undefined ? { token: t } : { token: t, body }),
      );
      assert.equal(r.status, 403, `${method} ${path}`);
      assert.equal(r.json()["error"], "local_only", `${method} ${path}`);
    }
    // The device still exists: its own revoke attempt did nothing.
    const view = (await http(port, "GET", "/api/lan", { token: connector.token })).json() as {
      devices: Array<{ id: string }>;
    };
    assert.ok(view.devices.some((d) => d.id === device.id));
  });

  it("refuses foreign Origins and rebinding Host headers", async () => {
    const evil = "http://evil.example";
    const pair = await withLan(() =>
      http(port, "POST", "/api/lan/pair", { host: lanHost, origin: evil, body: { code: "x" } }),
    );
    assert.equal(pair.status, 403);
    const noOrigin = await withLan(() =>
      http(port, "POST", "/api/lan/pair", { host: lanHost, body: { code: "x" } }),
    );
    assert.equal(noOrigin.status, 403, "pairing needs the connector's own Origin");
    const session = await withLan(() =>
      http(port, "GET", "/api/session", { host: lanHost, origin: evil }),
    );
    assert.equal(session.status, 403);
    // Unbound address on the right port, wrong port on a bound address, any hostname.
    for (const host of [`192.0.2.99:${port}`, `${LAN_IP}:${port + 1}`, `evil.example:${port}`, `${LAN_IP}`]) {
      const r = await http(port, "GET", "/api/health", { host });
      assert.equal(r.status, 421, host);
    }
    assert.equal(await upgradeStatus(`ws://127.0.0.1:${port}/ws`, `http://192.0.2.99:${port}`), 403);
    assert.equal(await upgradeStatus(`ws://127.0.0.1:${port}/ws`, evil), 403);
    assert.equal(await upgradeStatus(`ws://127.0.0.1:${port}/ws`, lanOrigin), 101);
  });

  it("refuses a revoked token at once, on HTTP and on an open socket", async () => {
    const device = await pairDevice("Old phone");
    asLan = true;
    const client = await connectClient(`ws://127.0.0.1:${port}/ws`, lanOrigin);
    asLan = false;
    client.send(hello(device.token));
    assert.equal((await client.next()).type, "welcome");
    const revoke = await http(port, "DELETE", `/api/lan/devices/${device.id}`, {
      token: connector.token,
    });
    assert.equal(revoke.status, 200);
    assert.equal((await client.closed).code, 4401);
    const status = await withLan(() => lanReq("GET", "/api/status", { token: device.token }));
    assert.equal(status.status, 401);
    const session = await withLan(() => lanReq("GET", "/api/session", { token: device.token }));
    assert.equal(session.status, 403);
    assert.equal(session.json()["error"], "pairing_required");
    const unknown = await http(port, "DELETE", `/api/lan/devices/${device.id}`, {
      token: connector.token,
    });
    assert.equal(unknown.status, 404);
  });

  it("expires codes after a few minutes", async () => {
    const code = await newCode();
    now += PAIRING_CODE_TTL_MS + 1000;
    const r = await withLan(() => lanReq("POST", "/api/lan/pair", { body: { code } }));
    assert.equal(r.status, 401);
    const view = (await http(port, "GET", "/api/lan", { token: connector.token })).json();
    assert.equal(view["code"], null);
  });

  it("locks out an address after repeated wrong codes (429 + Retry-After)", async () => {
    now += FAILURE_WINDOW_MS; // earlier tests' wrong codes no longer count
    const code = await newCode();
    for (let i = 0; i < MAX_FAILURES_PER_ADDRESS; i++) {
      const r = await withLan(() => lanReq("POST", "/api/lan/pair", { body: { code: "ZZZZZZZZ" } }));
      assert.equal(r.status, 401);
    }
    const locked = await withLan(() => lanReq("POST", "/api/lan/pair", { body: { code } }));
    assert.equal(locked.status, 429);
    assert.equal(locked.json()["error"], "pairing_locked");
    assert.equal(locked.headers["retry-after"], String(LOCKOUT_MS / 1000));
    now += LOCKOUT_MS;
    const later = await newCode();
    const ok = await withLan(() => lanReq("POST", "/api/lan/pair", { body: { code: later } }));
    assert.equal(ok.status, 200);
  });
});

describe("--reset-token", () => {
  it("forgets every paired LAN device", async () => {
    const tmp = tempDir();
    const dataDir = join(tmp.dir, "data");
    try {
      const lan = new LanAccess({ dataDir });
      assert.ok(lan.pair(lan.createCode().code, "Tablet", "192.168.1.20").ok);
      const connector = await startConnector({
        sim: "fake",
        dataDir,
        port: 0,
        quiet: true,
        source: fake(),
        resetToken: true,
      });
      try {
        assert.deepEqual(connector.lan.devices(), []);
      } finally {
        await connector.stop();
      }
    } finally {
      tmp.cleanup();
    }
  });
});

describe("--lan on a real non-loopback address", { skip: !realLanIp }, () => {
  it("serves 127.0.0.1 and the chosen address; a real LAN client must pair", async () => {
    const tmp = tempDir();
    const dataDir = join(tmp.dir, "data");
    const connector = await startConnector({
      sim: "fake",
      dataDir,
      port: 0,
      quiet: true,
      source: fake(),
      lan: realLanIp as string,
    });
    try {
      const port = connector.server.port;
      const ip = realLanIp as string;
      assert.deepEqual(connector.server.lanUrls(), [`http://${ip}:${port}/`]);
      const local = await http(port, "GET", "/api/session");
      assert.equal(local.json()["token"], connector.token);
      // Connecting to the LAN address makes the remote address non-loopback.
      const remote = await http(port, "GET", "/api/session", {
        connectTo: ip,
        host: `${ip}:${port}`,
        origin: `http://${ip}:${port}`,
      });
      assert.equal(remote.status, 403);
      assert.equal(remote.json()["error"], "pairing_required");
      const code = await http(port, "POST", "/api/lan/code", { token: connector.token });
      const pair = await http(port, "POST", "/api/lan/pair", {
        connectTo: ip,
        host: `${ip}:${port}`,
        origin: `http://${ip}:${port}`,
        body: { code: (code.json()["code"] as { code: string }).code, name: "Real LAN" },
      });
      assert.equal(pair.status, 200);
      assert.equal((pair.json()["device"] as { pairedFrom: string }).pairedFrom, ip);
    } finally {
      await connector.stop();
      tmp.cleanup();
    }
  });
});
