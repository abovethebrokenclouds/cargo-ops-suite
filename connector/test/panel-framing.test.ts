// Framing rules for the in-sim toolbar panel (msfs-panel/): GET /panel may be shown inside
// the simulator's coui: page (and only that path), every other route stays unframable.

import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { startConnector, type RunningConnector } from "../src/cli/app";
import { parseArgs } from "../src/cli/args";
import {
  DEFAULT_PANEL_FRAME_ANCESTORS,
  normalizeFrameAncestor,
  panelFramingHeaders,
} from "../src/server/security";
import { FakeSource } from "../src/sim/fake-source";
import { rawGet, shortFixture, tempDir, type RawResponse } from "./helpers";

const STRICT_PATHS = [
  "/",
  "/flight",
  "/settings",
  "/jobs",
  "/panel/",
  "/panel/x",
  "/Panel",
  "/panelx",
  "/panel%2F..%2Fsettings",
  "/assets/app.js",
  "/api/health",
  "/api/session",
];

function assertStrict(res: RawResponse, path: string): void {
  assert.equal(res.headers["x-frame-options"], "DENY", `${path}: X-Frame-Options DENY`);
  assert.equal(
    res.headers["content-security-policy"],
    "frame-ancestors 'none'",
    `${path}: frame-ancestors 'none'`,
  );
}

async function withConnector(
  extra: string[] | undefined,
  fn: (port: number, connector: RunningConnector) => Promise<void>,
): Promise<void> {
  const tmp = tempDir("cargo-ops-panel-");
  const web = join(tmp.dir, "web");
  mkdirSync(join(web, "assets"), { recursive: true });
  writeFileSync(join(web, "_shell.html"), "<!doctype html><title>shell</title>");
  writeFileSync(join(web, "assets", "app.js"), "console.log('app');");
  let connector: RunningConnector;
  try {
    connector = await startConnector({
      sim: "fake",
      dataDir: join(tmp.dir, "data"),
      port: 0,
      web,
      quiet: true,
      ...(extra ? { panelFrameAncestors: extra } : {}),
      source: new FakeSource({ frames: shortFixture(), speed: 1, loop: true, loopGapMs: 200 }),
    });
  } catch (err) {
    tmp.cleanup();
    throw err;
  }
  try {
    await fn(connector.server.port, connector);
  } finally {
    await connector.stop();
    tmp.cleanup();
  }
}

describe("panel framing rules (pure)", () => {
  it("defaults to this connector and the simulator's coui: scheme", () => {
    assert.deepEqual([...DEFAULT_PANEL_FRAME_ANCESTORS], ["'self'", "coui:"]);
    assert.deepEqual(panelFramingHeaders("/panel", DEFAULT_PANEL_FRAME_ANCESTORS), {
      csp: "frame-ancestors 'self' coui:",
    });
  });

  it("relaxes the exact /panel path only", () => {
    for (const p of ["/", "/flight", "/panel/", "/panel/x", "/Panel", "/panels", "/api/panel"]) {
      assert.equal(panelFramingHeaders(p, DEFAULT_PANEL_FRAME_ANCESTORS), null, p);
    }
  });

  it('"any" drops the CSP for /panel; duplicates are listed once', () => {
    assert.deepEqual(panelFramingHeaders("/panel", ["'self'", "any"]), { csp: null });
    assert.deepEqual(panelFramingHeaders("/panel", ["'self'", "coui:", "coui:"]), {
      csp: "frame-ancestors 'self' coui:",
    });
  });

  it("validates extra ancestors: origins, schemes and any; nothing that injects directives", () => {
    assert.equal(
      normalizeFrameAncestor("http://Panel-Host.test:8080"),
      "http://panel-host.test:8080",
    );
    assert.equal(normalizeFrameAncestor("https://example.org/"), "https://example.org");
    assert.equal(normalizeFrameAncestor("COUI:"), "coui:");
    assert.equal(normalizeFrameAncestor(" any "), "any");
    for (const bad of [
      "*",
      "http:",
      "https:",
      "data:",
      "'none'",
      "http://a.test/path",
      "http://a.test; script-src *",
      "ftp://a.test",
      "not an origin",
      "",
    ]) {
      assert.throws(() => normalizeFrameAncestor(bad), Error, bad);
    }
  });

  it("parses --panel-frame-ancestor (repeatable) and refuses an empty value", () => {
    const r = parseArgs([
      "--panel-frame-ancestor",
      "http://a.test",
      "--panel-frame-ancestor=coui:",
    ]);
    assert.ok(r.ok);
    if (r.ok) assert.deepEqual(r.options.panelFrameAncestors, ["http://a.test", "coui:"]);
    const none = parseArgs([]);
    assert.ok(none.ok);
    if (none.ok) assert.deepEqual(none.options.panelFrameAncestors, []);
    assert.equal(parseArgs(["--panel-frame-ancestor"]).ok, false);
    assert.equal(parseArgs(["--panel-frame-ancestor="]).ok, false);
  });
});

describe("panel framing headers on the real server", () => {
  it("GET /panel may be framed by 'self' and coui: only; every other path is DENY", async () => {
    await withConnector(undefined, async (port) => {
      const panel = await rawGet(port, "/panel");
      assert.equal(panel.status, 200);
      assert.match(panel.body, /shell/, "the SPA shell is served for /panel");
      assert.equal(panel.headers["x-frame-options"], undefined, "no X-Frame-Options on /panel");
      assert.equal(panel.headers["content-security-policy"], "frame-ancestors 'self' coui:");
      // Everything else about /panel stays as strict as the other routes.
      assert.equal(panel.headers["x-content-type-options"], "nosniff");
      assert.equal(panel.headers["referrer-policy"], "no-referrer");
      assert.equal(panel.headers["cross-origin-resource-policy"], "same-origin");
      const query = await rawGet(port, "/panel?compact=1");
      assert.equal(query.headers["content-security-policy"], "frame-ancestors 'self' coui:");
      for (const path of STRICT_PATHS) assertStrict(await rawGet(port, path), path);
    });
  });

  it("the token still only goes to same-origin loopback requests", async () => {
    await withConnector(undefined, async (port, connector) => {
      const own = await rawGet(port, "/api/session");
      assert.equal(own.status, 200);
      assert.equal((JSON.parse(own.body) as { token: string }).token, connector.token);
      // A page in the simulator (coui:) or any other origin never gets it.
      for (const origin of ["coui://html_ui", "http://panel-host.test", "null"]) {
        const res = await rawGet(port, "/api/session", { Origin: origin });
        assert.equal(res.status, 403, origin);
        assert.ok(!res.body.includes(connector.token), origin);
      }
    });
  });

  it("--panel-frame-ancestor adds an origin for /panel only", async () => {
    await withConnector(["http://panel-host.test:8080"], async (port) => {
      const panel = await rawGet(port, "/panel");
      assert.equal(
        panel.headers["content-security-policy"],
        "frame-ancestors 'self' coui: http://panel-host.test:8080",
      );
      assert.equal(panel.headers["x-frame-options"], undefined);
      for (const path of STRICT_PATHS) assertStrict(await rawGet(port, path), path);
    });
  });

  it('"any" lifts the restriction for /panel and nothing else', async () => {
    await withConnector(["any"], async (port) => {
      const panel = await rawGet(port, "/panel");
      assert.equal(panel.headers["content-security-policy"], undefined);
      assert.equal(panel.headers["x-frame-options"], undefined);
      for (const path of STRICT_PATHS) assertStrict(await rawGet(port, path), path);
    });
  });

  it("refuses to start with an ancestor that is not an origin, a scheme or any", async () => {
    await assert.rejects(
      withConnector(["http://a.test; script-src *"], async () => {}),
      /frame ancestor/,
    );
  });
});
