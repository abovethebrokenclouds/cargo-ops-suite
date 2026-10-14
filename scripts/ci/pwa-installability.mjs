#!/usr/bin/env node
// W-40 (PC-40 without a desktop browser UI): loads the app served by a running connector in
// Playwright's Chromium and asks the browser itself, over CDP, whether the page is installable
// (`Page.getInstallabilityErrors`) and what manifest it parsed (`Page.getAppManifest`). Every
// manifest icon must resolve to a PNG/SVG of the declared size. A persistent (non-incognito)
// profile is used because Chromium never offers installation in incognito contexts.
//
// Chromium-only and headless: it proves the manifest + page meet Chromium's installability
// rules, not that Edge/Chrome show the install button, nor what the installed window looks like.
//
//   node scripts/ci/pwa-installability.mjs [--url http://127.0.0.1:4311/]
// Uses @playwright/test from the root node_modules; PW_CHROMIUM_PATH overrides the browser.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { assert, assertEqual, log, run } from "./lib.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** Width/height of a PNG from its IHDR chunk. */
function pngSize(buf) {
  const sig = buf.subarray(0, 8).toString("hex");
  if (sig !== "89504e470d0a1a0a") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

run("pwa-installability", async () => {
  const url = arg("--url", "http://127.0.0.1:4311/");
  const profile = mkdtempSync(join(tmpdir(), "cargo-ops-pwa-"));
  const executablePath = process.env.PW_CHROMIUM_PATH;
  // Full Chromium (new headless), not the headless shell: installability is a browser feature.
  const context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(executablePath ? { executablePath } : { channel: "chromium" }),
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const response = await page.goto(url, { waitUntil: "load" });
    assertEqual(response?.status(), 200, `${url} loads`);
    const cdp = await context.newCDPSession(page);

    // The manifest is fetched asynchronously after load; poll until Chromium has parsed it.
    let manifest = null;
    for (let i = 0; i < 40; i++) {
      manifest = await cdp.send("Page.getAppManifest");
      if (manifest.url && (manifest.data || manifest.errors.length > 0)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    assert(manifest?.url?.endsWith("/manifest.webmanifest"), `manifest found at ${manifest?.url}`);
    assertEqual(manifest.errors, [], "Chromium reports no manifest parse errors");

    let installability = null;
    for (let i = 0; i < 20; i++) {
      installability = await cdp.send("Page.getInstallabilityErrors");
      if (installability.installabilityErrors.length === 0) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    log(`installability errors: ${JSON.stringify(installability.installabilityErrors)}`);
    assertEqual(
      installability.installabilityErrors.map((e) => e.errorId),
      [],
      "Page.getInstallabilityErrors returns no errors",
    );

    const data = JSON.parse(manifest.data);
    assertEqual(data.display, "standalone", "manifest display is standalone");
    assert(Array.isArray(data.icons) && data.icons.length > 0, "manifest declares icons");
    const sizes = new Set();
    for (const icon of data.icons) {
      const iconUrl = new URL(icon.src, manifest.url).href;
      const res = await fetch(iconUrl);
      assertEqual(res.status, 200, `icon ${icon.src} resolves`);
      const type = res.headers.get("content-type") ?? "";
      const buf = Buffer.from(await res.arrayBuffer());
      if (icon.type) assert(type.startsWith(icon.type), `icon ${icon.src} served as ${icon.type}`);
      if (type.startsWith("image/png") && icon.sizes && icon.sizes !== "any") {
        const size = pngSize(buf);
        assertEqual(
          size && `${size.width}x${size.height}`,
          icon.sizes,
          `icon ${icon.src} is ${icon.sizes}`,
        );
        sizes.add(icon.sizes);
      }
    }
    assert(sizes.has("192x192") && sizes.has("512x512"), "192 and 512 px PNG icons present");
  } finally {
    await context.close();
    rmSync(profile, { recursive: true, force: true });
  }
});
