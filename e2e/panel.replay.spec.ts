import { expect, test, type Page } from "@playwright/test";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { startConnector, type ReplayConnector } from "./replay-fixtures";

// The in-sim toolbar panel (msfs-panel/) loads http://127.0.0.1:<port>/panel in an iframe of a
// page on another origin (the simulator's coui: page). Chromium has no coui: scheme, so this
// spec plays the host page with a tiny local server on another port of 127.0.0.1 (a different
// origin; loopback, so Chromium's local-network rules do not interfere) and allows that origin
// with --panel-frame-ancestor, as a user would for another host. A second local server plays
// an origin that was NOT allowed. It checks: /panel renders inside the frame, connects in
// replay (REPLAY, never LIVE) and tells the host page it loaded; the other origin cannot frame
// it; and no other route can be framed even from the allowed origin.

const SPEED = process.env["CARGO_OPS_E2E_SPEED"] ?? "20";

let connector: ReplayConnector | null = null;
let allowed: HostServer | null = null;
let other: HostServer | null = null;

interface HostServer {
  origin: string;
  /** The iframe src for the next page load. */
  frameSrc: string;
  close(): Promise<void>;
}

/** A local page with one iframe; it records the postMessages it receives. */
async function startHostServer(): Promise<HostServer> {
  const host: HostServer = { origin: "", frameSrc: "about:blank", close: async () => {} };
  const server = createServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(`<!doctype html><html><head><title>host</title></head><body>
<script>
  window.__messages = [];
  window.addEventListener("message", (e) => window.__messages.push({ origin: e.origin, data: e.data }));
</script>
<iframe id="panel" title="Cargo Ops panel" src="${host.frameSrc}" style="width:400px;height:600px;border:0"></iframe>
</body></html>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  host.origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  host.close = () => new Promise<void>((r) => server.close(() => r()));
  return host;
}

test.beforeAll(async () => {
  allowed = await startHostServer();
  other = await startHostServer();
  connector = await startConnector("panel", [
    "--sim",
    "fake",
    "--loop",
    "--speed",
    SPEED,
    "--panel-frame-ancestor",
    allowed.origin,
  ]);
});

test.afterAll(async () => {
  await connector?.stop();
  await allowed?.close();
  await other?.close();
});

/** Open `host` with an iframe on `src`; returns the "Refused to frame …" console lines. */
async function hostPage(page: Page, host: HostServer, src: string): Promise<string[]> {
  const refused: string[] = [];
  page.on("console", (msg) => {
    if (/Refused to (frame|display)/i.test(msg.text())) refused.push(msg.text());
  });
  host.frameSrc = src;
  await page.goto(`${host.origin}/`);
  return refused;
}

test("/panel renders inside a frame from another origin and connects in replay", async ({
  page,
}) => {
  const url = connector!.url;
  await hostPage(page, allowed!, `${url}/panel`);
  const frame = page.frameLocator("#panel");

  const chip = frame.getByRole("status").first();
  await expect(chip).toHaveAttribute("data-status", "replay", { timeout: 15_000 });
  await expect(chip).toHaveText(/REPLAY/);
  await expect(frame.getByTestId("panel-source-note")).toHaveText(/not live data/);
  await expect(frame.getByTestId("compact-panel")).toBeVisible();
  await expect(frame.getByTestId("panel-route-pair")).toHaveText(/KMEM → KATL/, {
    timeout: 15_000,
  });
  await expect(
    frame.getByTestId("panel-route").locator('[data-source-tag="replay"]'),
  ).toBeVisible();
  await expect(frame.getByTestId("panel-lamps")).toBeVisible();
  // Read-only and nothing that says LIVE in a replay.
  expect(await frame.locator("button, a, input, select, textarea, form").count()).toBe(0);
  expect(await frame.getByTestId("compact-panel").textContent()).not.toMatch(/\bLIVE\b/);

  // The host page heard "ready" from the connector's origin, and nothing else.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages))
    .toEqual([{ origin: url, data: { source: "cargo-ops-panel", type: "ready" } }]);
});

test("an origin that was not allowed cannot frame /panel", async ({ page }) => {
  const refused = await hostPage(page, other!, `${connector!.url}/panel`);
  await expect.poll(() => refused.length, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(refused.join("\n")).toMatch(/frame-ancestors/);
  await page.waitForTimeout(500);
  expect(await page.frameLocator("#panel").getByTestId("compact-panel").count()).toBe(0);
  expect(
    await page.evaluate(() => (window as unknown as { __messages: unknown[] }).__messages),
  ).toEqual([]);
});

test("no other route can be framed, even from the allowed origin", async ({ page }) => {
  for (const path of ["/flight", "/settings", "/"]) {
    const p = await page.context().newPage();
    const refused = await hostPage(p, allowed!, `${connector!.url}${path}`);
    await expect.poll(() => refused.length, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(refused.join("\n"), path).toMatch(/frame-ancestors 'none'|X-Frame-Options/);
    await p.waitForTimeout(300);
    expect(await p.frameLocator("#panel").getByTestId("page").count(), path).toBe(0);
    await p.close();
  }
});

test("/panel opened directly still works (not framed)", async ({ page }) => {
  await page.goto(`${connector!.url}/panel`);
  await expect(page.getByRole("status").first()).toHaveAttribute("data-status", "replay", {
    timeout: 15_000,
  });
  // The compact layout has no app navigation.
  await expect(page.locator("nav")).toHaveCount(0);
});
