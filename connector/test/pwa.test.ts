import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startConnector } from "../src/cli/app";
import { contentTypeFor } from "../src/server/static";
import { FakeSource } from "../src/sim/fake-source";
import { rawGet, shortFixture, tempDir } from "./helpers";

// P6: the PWA manifest and icons are served same-origin by the connector with the right
// content types, so Edge/Chrome can offer "Install app".
const PUBLIC = join(__dirname, "..", "..", "..", "..", "public");

describe("PWA assets served by the connector", () => {
  it("serves manifest.webmanifest as application/manifest+json and the icons as PNG/SVG", async () => {
    assert.equal(
      contentTypeFor("/manifest.webmanifest"),
      "application/manifest+json; charset=utf-8",
    );
    const tmp = tempDir();
    const web = join(tmp.dir, "web");
    mkdirSync(join(web, "icons"), { recursive: true });
    writeFileSync(join(web, "_shell.html"), "<!doctype html><title>shell</title>");
    // Use the real files from public/ when present (they are copied into dist/client by Vite).
    const manifestSrc = join(PUBLIC, "manifest.webmanifest");
    const manifest = existsSync(manifestSrc)
      ? readFileSync(manifestSrc, "utf8")
      : JSON.stringify({ name: "Cargo Ops" });
    writeFileSync(join(web, "manifest.webmanifest"), manifest);
    writeFileSync(join(web, "icons", "icon-192.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    writeFileSync(join(web, "icons", "icon.svg"), "<svg xmlns='http://www.w3.org/2000/svg'/>");
    const c = await startConnector({
      sim: "fake",
      dataDir: join(tmp.dir, "data"),
      port: 0,
      web,
      quiet: true,
      clockIntervalMs: 0,
      source: new FakeSource({ frames: shortFixture(), speed: 1, loop: false }),
    });
    try {
      const m = await rawGet(c.server.port, "/manifest.webmanifest");
      assert.equal(m.status, 200);
      assert.equal(m.headers["content-type"], "application/manifest+json; charset=utf-8");
      const parsed = JSON.parse(m.body) as { name: string };
      assert.equal(parsed.name, "Cargo Ops");
      const png = await rawGet(c.server.port, "/icons/icon-192.png");
      assert.equal(png.headers["content-type"], "image/png");
      const svg = await rawGet(c.server.port, "/icons/icon.svg");
      assert.equal(svg.headers["content-type"], "image/svg+xml");
    } finally {
      await c.stop();
      tmp.cleanup();
    }
  });
});
