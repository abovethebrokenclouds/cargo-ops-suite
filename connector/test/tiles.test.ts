import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { request, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startConnector, type RunningConnector } from "../src/cli/app";
import { parseArgs } from "../src/cli/args";
import { parseRange, tileFilePath } from "../src/server/tiles";
import { FakeSource } from "../src/sim/fake-source";
import { shortFixture, tempDir } from "./helpers";

interface BinaryResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

function fetchBinary(
  port: number,
  path: string,
  headers: Record<string, string> = {},
  method = "GET",
): Promise<BinaryResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks),
          }),
        );
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("parseRange", () => {
  it("returns null without a header", () => {
    assert.equal(parseRange(undefined, 100), null);
  });
  it("parses closed, open and suffix ranges", () => {
    assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
    assert.deepEqual(parseRange("bytes=90-", 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
    assert.deepEqual(parseRange("bytes=-500", 100), { start: 0, end: 99 });
    assert.deepEqual(parseRange("bytes=95-500", 100), { start: 95, end: 99 });
  });
  it("rejects malformed, multiple and unsatisfiable ranges", () => {
    for (const bad of [
      "bytes=100-",
      "bytes=10-5",
      "bytes=-0",
      "bytes=-",
      "bytes=0-1,5-6",
      "items=0-1",
      "bytes=a-b",
    ]) {
      assert.equal(parseRange(bad, 100), "invalid", bad);
    }
    assert.equal(parseRange("bytes=0-0", 0), "invalid");
  });
});

describe("tileFilePath", () => {
  it("accepts lowercase names only, never traversal", () => {
    assert.equal(tileFilePath("/b", "/tiles/basemap.pmtiles"), join("/b", "basemap.pmtiles"));
    assert.equal(tileFilePath("/b", "/tiles/europe-z11.pmtiles"), join("/b", "europe-z11.pmtiles"));
    for (const bad of [
      "/tiles/../secret.pmtiles",
      "/tiles/..%2fsecret.pmtiles",
      "/tiles/sub/basemap.pmtiles",
      "/tiles/Basemap.pmtiles",
      "/tiles/basemap.mbtiles",
      "/tiles/.pmtiles",
      "/tiles/basemap.pmtiles.bak",
      "/tiles/a_b.pmtiles",
    ]) {
      assert.equal(tileFilePath("/b", bad), null, bad);
    }
  });
});

describe("--basemap-dir", () => {
  it("is parsed", () => {
    const r = parseArgs(["--basemap-dir", "D:/maps"]);
    assert.ok(r.ok);
    if (r.ok) assert.equal(r.options.basemapDir, "D:/maps");
  });
});

describe("GET /tiles/*.pmtiles with a local basemap", () => {
  let tmp: ReturnType<typeof tempDir>;
  let connector: RunningConnector;
  let port: number;
  const archive = randomBytes(64 * 1024 + 17);

  before(async () => {
    tmp = tempDir();
    const dataDir = join(tmp.dir, "data");
    mkdirSync(join(dataDir, "basemap"), { recursive: true });
    writeFileSync(join(dataDir, "basemap", "basemap.pmtiles"), archive);
    writeFileSync(join(tmp.dir, "secret.pmtiles"), "TOP SECRET");
    connector = await startConnector({
      sim: "fake",
      dataDir,
      port: 0,
      quiet: true,
      source: new FakeSource({ frames: shortFixture(), speed: 1, loop: true, loopGapMs: 200 }),
    });
    port = connector.server.port;
  });

  after(async () => {
    await connector.stop();
    tmp.cleanup();
  });

  it("/api/health reports basemap.local = true", async () => {
    const res = await fetchBinary(port, "/api/health");
    assert.equal(res.status, 200);
    const body = JSON.parse(res.body.toString("utf8")) as { basemap?: { local?: boolean } };
    assert.deepEqual(body.basemap, { local: true });
  });

  it("serves the whole archive with range and cache headers", async () => {
    const res = await fetchBinary(port, "/tiles/basemap.pmtiles");
    assert.equal(res.status, 200);
    assert.equal(res.headers["accept-ranges"], "bytes");
    assert.equal(res.headers["content-length"], String(archive.length));
    assert.match(String(res.headers["cache-control"]), /max-age=\d+/);
    assert.ok(res.headers["etag"]);
    assert.ok(res.headers["last-modified"]);
    assert.ok(res.body.equals(archive));
  });

  it("answers a byte range with 206 and Content-Range", async () => {
    const res = await fetchBinary(port, "/tiles/basemap.pmtiles", { Range: "bytes=100-1123" });
    assert.equal(res.status, 206);
    assert.equal(res.headers["content-range"], `bytes 100-1123/${archive.length}`);
    assert.equal(res.headers["content-length"], "1024");
    assert.ok(res.body.equals(archive.subarray(100, 1124)));
  });

  it("answers open-ended and suffix ranges", async () => {
    const open = await fetchBinary(port, "/tiles/basemap.pmtiles", {
      Range: `bytes=${archive.length - 5}-`,
    });
    assert.equal(open.status, 206);
    assert.ok(open.body.equals(archive.subarray(archive.length - 5)));
    const suffix = await fetchBinary(port, "/tiles/basemap.pmtiles", { Range: "bytes=-16" });
    assert.equal(suffix.status, 206);
    assert.ok(suffix.body.equals(archive.subarray(archive.length - 16)));
  });

  it("returns 416 with Content-Range */size for a bad range", async () => {
    for (const range of [`bytes=${archive.length}-`, "bytes=5-1", "bytes=0-1,4-5", "junk"]) {
      const res = await fetchBinary(port, "/tiles/basemap.pmtiles", { Range: range });
      assert.equal(res.status, 416, range);
      assert.equal(res.headers["content-range"], `bytes */${archive.length}`);
    }
  });

  it("HEAD returns headers and no body", async () => {
    const res = await fetchBinary(port, "/tiles/basemap.pmtiles", {}, "HEAD");
    assert.equal(res.status, 200);
    assert.equal(res.headers["content-length"], String(archive.length));
    assert.equal(res.body.length, 0);
  });

  it("revalidates with If-None-Match", async () => {
    const first = await fetchBinary(port, "/tiles/basemap.pmtiles", {}, "HEAD");
    const etag = String(first.headers["etag"]);
    const res = await fetchBinary(port, "/tiles/basemap.pmtiles", { "If-None-Match": etag });
    assert.equal(res.status, 304);
  });

  it("refuses bad names and traversal, and 404s unknown archives", async () => {
    for (const path of [
      "/tiles/..%2fsecret.pmtiles",
      "/tiles/%2e%2e%2fsecret.pmtiles",
      "/tiles/Basemap.pmtiles",
      "/tiles/basemap.json",
    ]) {
      const res = await fetchBinary(port, path);
      assert.equal(res.status, 400, path);
      assert.ok(!res.body.toString("utf8").includes("TOP SECRET"));
    }
    const missing = await fetchBinary(port, "/tiles/europe.pmtiles");
    assert.equal(missing.status, 404);
  });

  it("only answers GET and HEAD", async () => {
    const res = await fetchBinary(port, "/tiles/basemap.pmtiles", {}, "POST");
    assert.equal(res.status, 405);
  });

  it("applies the Host-header guard", async () => {
    const res = await fetchBinary(port, "/tiles/basemap.pmtiles", { Host: "evil.example:80" });
    assert.equal(res.status, 421);
  });
});

describe("GET /tiles without a local basemap", () => {
  let tmp: ReturnType<typeof tempDir>;
  let connector: RunningConnector;

  before(async () => {
    tmp = tempDir();
    connector = await startConnector({
      sim: "fake",
      dataDir: join(tmp.dir, "data"),
      port: 0,
      quiet: true,
      source: new FakeSource({ frames: shortFixture(), speed: 1, loop: true, loopGapMs: 200 }),
    });
  });

  after(async () => {
    await connector.stop();
    tmp.cleanup();
  });

  it("health says local = false and the archive is 404", async () => {
    const port = connector.server.port;
    const health = await fetchBinary(port, "/api/health");
    const body = JSON.parse(health.body.toString("utf8")) as { basemap?: { local?: boolean } };
    assert.deepEqual(body.basemap, { local: false });
    const res = await fetchBinary(port, "/tiles/basemap.pmtiles");
    assert.equal(res.status, 404);
  });
});
