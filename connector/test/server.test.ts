import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { PROTOCOL_VERSION, type ServerMessage } from "../src/protocol";
import { startConnector, type RunningConnector } from "../src/cli/app";
import { FakeSource } from "../src/sim/fake-source";
import { connectClient, hello, rawGet, shortFixture, tempDir, upgradeStatus } from "./helpers";

describe("connector server (FakeSource over a real WebSocket)", () => {
  let tmp: ReturnType<typeof tempDir>;
  let connector: RunningConnector;
  let port: number;
  let origin: string;
  let wsUrl: string;

  before(async () => {
    tmp = tempDir();
    const web = join(tmp.dir, "web");
    mkdirSync(join(web, "assets"), { recursive: true });
    writeFileSync(join(web, "_shell.html"), "<!doctype html><title>shell</title>");
    writeFileSync(join(web, "assets", "app.js"), "console.log('app');");
    writeFileSync(join(web, "assets", "style.css"), "body{}");
    writeFileSync(join(web, ".env"), "SECRET=1");
    writeFileSync(join(tmp.dir, "secret.txt"), "TOP SECRET");
    connector = await startConnector({
      sim: "fake",
      dataDir: join(tmp.dir, "data"),
      port: 0,
      web,
      quiet: true,
      source: new FakeSource({ frames: shortFixture(), speed: 1, loop: true, loopGapMs: 200 }),
    });
    port = connector.server.port;
    origin = `http://127.0.0.1:${port}`;
    wsUrl = `ws://127.0.0.1:${port}/ws`;
  });

  after(async () => {
    await connector.stop();
    tmp.cleanup();
  });

  it("hello → welcome(replay, not connected) → snapshot → deltas with monotonic seq", async () => {
    const client = await connectClient(wsUrl, origin);
    client.send(hello(connector.token));
    const welcome = await client.next();
    assert.equal(welcome.type, "welcome");
    if (welcome.type !== "welcome") return;
    assert.equal(welcome.mode, "replay");
    assert.equal(welcome.sim.connected, false);
    assert.equal(welcome.v, PROTOCOL_VERSION);

    const snapshot = await client.next();
    assert.equal(snapshot.type, "snapshot");
    if (snapshot.type !== "snapshot") return;
    assert.equal(snapshot.source, "replay");

    const frames: ServerMessage[] = [];
    while (frames.length < 6) {
      frames.push(
        await client.next((m) => m.type === "delta" || m.type === "event" || m.type === "snapshot"),
      );
    }
    let last = snapshot.seq;
    for (const frame of frames) {
      if (frame.type !== "delta" && frame.type !== "event" && frame.type !== "snapshot") continue;
      assert.equal(frame.source, "replay", "every frame is labelled replay");
      assert.equal(frame.seq, last + 1, "seq is contiguous across deltas, events and snapshots");
      last = frame.seq;
    }
    assert.ok(frames.some((f) => f.type === "delta"));
    client.ws.close();
  });

  it("delta patches carry only changed fields", async () => {
    const client = await connectClient(wsUrl, origin);
    client.send(hello(connector.token));
    const delta = await client.next(
      (m) => m.type === "delta" && m.patch.motion !== undefined && m.patch.motion !== null,
    );
    assert.equal(delta.type, "delta");
    if (delta.type !== "delta") return;
    assert.deepEqual(Object.keys(delta.patch.motion ?? {}), ["gsKt"]);
    client.ws.close();
  });

  it("resync returns a fresh snapshot at the current seq", async () => {
    const client = await connectClient(wsUrl, origin);
    client.send(hello(connector.token));
    await client.next((m) => m.type === "snapshot");
    const seen = await client.next((m) => m.type === "delta");
    client.send({ type: "resync", v: PROTOCOL_VERSION, lastSeq: 0 });
    const snap = await client.next((m) => m.type === "snapshot");
    assert.equal(snap.type, "snapshot");
    if (snap.type !== "snapshot" || seen.type !== "delta") return;
    assert.ok(snap.seq >= seen.seq);
    assert.equal(snap.source, "replay");
    client.ws.close();
  });

  it("answers ping with pong, flight commands with checks, others with not_implemented", async () => {
    const client = await connectClient(wsUrl, origin);
    client.send(hello(connector.token));
    await client.next((m) => m.type === "welcome");
    client.send({ type: "ping", v: PROTOCOL_VERSION, t: 123 });
    const pong = await client.next((m) => m.type === "pong");
    assert.deepEqual(pong, { type: "pong", v: PROTOCOL_VERSION, t: 123 });
    // The short fixture has no controls domain, so a start is refused (brake unknown).
    const expected: Array<[string, string]> = [
      ["flight.start", "brake_not_set"],
      ["flight.end", "no_flight"],
      ["job.accept", "not_implemented"],
    ];
    for (const [name, code] of expected) {
      client.send({ type: "command", v: PROTOCOL_VERSION, id: `c-${name}`, name, args: {} });
      const result = await client.next((m) => m.type === "result");
      assert.equal(result.type, "result");
      if (result.type !== "result") return;
      assert.equal(result.id, `c-${name}`);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.error.code, code, name);
    }
    client.ws.close();
  });

  it("rejects WebSocket upgrades from a foreign or missing Origin", async () => {
    assert.equal(await upgradeStatus(wsUrl, "http://evil.example"), 403);
    assert.equal(await upgradeStatus(wsUrl, "http://127.0.0.1:5999"), 403);
    assert.equal(await upgradeStatus(wsUrl), 403);
    assert.equal(await upgradeStatus(wsUrl, `http://localhost:${port}`), 101);
  });

  it("rejects a wrong query token at upgrade time and accepts the right one", async () => {
    assert.equal(await upgradeStatus(`${wsUrl}?token=nope`, origin), 401);
    const client = await connectClient(`${wsUrl}?token=${connector.token}`, origin);
    client.send(hello(connector.token));
    assert.equal((await client.next()).type, "welcome");
    client.ws.close();
  });

  it("closes the socket on a missing or wrong token in hello", async () => {
    const wrong = await connectClient(wsUrl, origin);
    wrong.send(hello("0".repeat(64)));
    assert.equal((await wrong.closed).code, 4401);
    assert.equal(wrong.messages.length, 0, "no data before authentication");

    const missing = await connectClient(wsUrl, origin);
    missing.send({ type: "hello", v: PROTOCOL_VERSION, client: "web", wants: [] });
    assert.equal((await missing.closed).code, 4400);

    const notHello = await connectClient(wsUrl, origin);
    notHello.send({ type: "resync", v: PROTOCOL_VERSION, lastSeq: -1 });
    assert.equal((await notHello.closed).code, 4401);
    assert.equal(notHello.messages.length, 0);
  });

  it("/api/session: same-origin only", async () => {
    const noOrigin = await rawGet(port, "/api/session");
    assert.equal(noOrigin.status, 200);
    assert.deepEqual(JSON.parse(noOrigin.body), { token: connector.token, wsUrl: "/ws" });
    assert.equal(noOrigin.headers["cache-control"], "no-store");

    const own = await rawGet(port, "/api/session", { Origin: origin });
    assert.equal(own.status, 200);
    const localhost = await rawGet(port, "/api/session", { Origin: `http://localhost:${port}` });
    assert.equal(localhost.status, 200);

    const evil = await rawGet(port, "/api/session", { Origin: "http://evil.example" });
    assert.equal(evil.status, 403);
    assert.ok(!evil.body.includes(connector.token));

    const devNotAllowed = await rawGet(port, "/api/session", { Origin: "http://localhost:8080" });
    assert.equal(devNotAllowed.status, 403, "dev origin needs --dev-origin");

    const rebinding = await rawGet(port, "/api/session", { Host: `evil.example:${port}` });
    assert.equal(rebinding.status, 421);
    assert.ok(!rebinding.body.includes(connector.token));
  });

  it("/api/health needs no token; other /api routes need the bearer token", async () => {
    const health = await rawGet(port, "/api/health");
    assert.equal(health.status, 200);
    const body = JSON.parse(health.body) as Record<string, unknown>;
    assert.equal(body["ok"], true);
    assert.equal(body["mode"], "replay");
    assert.deepEqual(body["sim"], { connected: false });
    assert.equal(typeof body["version"], "string");

    assert.equal((await rawGet(port, "/api/status")).status, 401);
    assert.equal(
      (await rawGet(port, "/api/status", { Authorization: "Bearer wrong" })).status,
      401,
    );
    const ok = await rawGet(port, "/api/status", { Authorization: `Bearer ${connector.token}` });
    assert.equal(ok.status, 200);
    assert.equal((JSON.parse(ok.body) as Record<string, unknown>)["mode"], "replay");
    const missing = await rawGet(port, "/api/nope", {
      Authorization: `Bearer ${connector.token}`,
    });
    assert.equal(missing.status, 404);
  });

  it("serves the SPA with content types, shell fallback and security headers", async () => {
    const root = await rawGet(port, "/");
    assert.equal(root.status, 200);
    assert.match(String(root.headers["content-type"]), /^text\/html/);
    assert.match(root.body, /shell/);
    assert.equal(root.headers["x-content-type-options"], "nosniff");
    assert.equal(root.headers["x-frame-options"], "DENY");

    const route = await rawGet(port, "/flight");
    assert.equal(route.status, 200);
    assert.match(route.body, /shell/);

    const js = await rawGet(port, "/assets/app.js");
    assert.equal(js.status, 200);
    assert.match(String(js.headers["content-type"]), /^text\/javascript/);
    assert.match(String(js.headers["cache-control"]), /immutable/);

    const css = await rawGet(port, "/assets/style.css");
    assert.match(String(css.headers["content-type"]), /^text\/css/);

    assert.equal((await rawGet(port, "/assets/missing.js")).status, 404);
  });

  it("refuses directory traversal and dotfiles", async () => {
    const attempts = [
      "/../secret.txt",
      "/..%2fsecret.txt",
      "/%2e%2e/secret.txt",
      "/%2e%2e%2fsecret.txt",
      "/assets/..%2f..%2fsecret.txt",
      "/assets/%2e%2e%2f%2e%2e%2fsecret.txt",
      "/..\\secret.txt",
      "/%5c..%5csecret.txt",
      "/C:/Windows/win.ini",
      "/assets/%00app.js",
      "/.env",
      "/%2eenv",
    ];
    for (const path of attempts) {
      const res = await rawGet(port, path);
      assert.ok(!res.body.includes("TOP SECRET"), `${path} leaked a file outside the web root`);
      assert.ok(!res.body.includes("SECRET=1"), `${path} served a dotfile`);
      assert.ok(
        res.status === 400 || res.status === 404 || (res.status === 200 && /shell/.test(res.body)),
        `${path} → ${res.status}`,
      );
    }
  });

  it("rejects non-GET methods on static paths", async () => {
    const res = await new Promise<number>((resolve, reject) => {
      const req = request(
        {
          host: "127.0.0.1",
          port,
          path: "/",
          method: "POST",
          headers: { Host: `127.0.0.1:${port}` },
        },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    assert.equal(res, 405);
  });

  it("serves /api/flights and /api/flights/:id/track behind the bearer token", async () => {
    const auth = { Authorization: `Bearer ${connector.token}` };
    assert.equal((await rawGet(port, "/api/flights")).status, 401);
    connector.flights.save({
      id: "test-flight",
      status: "completed",
      startedAt: "2026-10-13T12:00:00.000Z",
      endedAt: "2026-10-13T13:00:00.000Z",
      origin: "KMEM",
      destination: "KATL",
      distanceNm: 287.5,
      blockMin: 60,
      airborneMin: 50,
      maxAltFt: 9500,
      fuelUsedLb: 600,
      flags: { teleport: false, noBonus: false, invalidated: false, crashed: false, paused: false },
      landings: [],
    });
    connector.flights.addTelemetry("test-flight", [
      { tMs: 2000, data: { lat: 35.1, lon: -89.9 } },
      { tMs: 1000, data: { lat: 35, lon: -90 } },
    ]);
    const list = await rawGet(port, "/api/flights", auth);
    assert.equal(list.status, 200);
    const body = JSON.parse(list.body) as { flights: Array<{ id: string; source: string }> };
    const found = body.flights.find((f) => f.id === "test-flight");
    assert.equal(found?.source, "replay");
    const track = await rawGet(port, "/api/flights/test-flight/track", auth);
    assert.equal(track.status, 200);
    assert.deepEqual(JSON.parse(track.body), {
      id: "test-flight",
      points: [
        { lat: 35, lon: -90, t: 1000 },
        { lat: 35.1, lon: -89.9, t: 2000 },
      ],
    });
    assert.equal((await rawGet(port, "/api/flights/nope/track", auth)).status, 404);
    assert.equal((await rawGet(port, "/api/flights/../track", auth)).status, 404);
  });
});

describe("--dev-origin", () => {
  it("allows the Vite dev origin only when configured", async () => {
    const tmp = tempDir();
    const connector = await startConnector({
      sim: "fake",
      dataDir: tmp.dir,
      port: 0,
      quiet: true,
      devOrigins: ["http://localhost:8080"],
      source: new FakeSource({ frames: shortFixture() }),
    });
    try {
      const port = connector.server.port;
      const res = await rawGet(port, "/api/session", { Origin: "http://localhost:8080" });
      assert.equal(res.status, 200);
      assert.equal(await upgradeStatus(`ws://127.0.0.1:${port}/ws`, "http://localhost:8080"), 101);
    } finally {
      await connector.stop();
      tmp.cleanup();
    }
  });
});
