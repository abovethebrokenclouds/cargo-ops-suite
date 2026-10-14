#!/usr/bin/env node
// Screenshots of the Ops dashboard (flight operations room) in demo mode, desktop 1440 px
// and phone 390 px, for docs/screenshots/ops-mission-control-*.png.
//
//   node scripts/screenshot-ops.mjs [baseURL] [outDir] [settleMs]
//
// Needs a running demo server (e.g. `node e2e/serve-ssr.mjs --port 5180` after
// `bun run build`) and a Chromium: PW_CHROMIUM_PATH, or Playwright's own. Online maps are
// switched off so the page makes no external request; the script fails when it sees one,
// when the page throws, or when the phone layout scrolls horizontally.
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [base = "http://127.0.0.1:5180", outArg, settleArg] = process.argv.slice(2);
const out = resolve(root, outArg ?? "docs/screenshots");
const settleMs = Number(settleArg ?? 20_000);
mkdirSync(out, { recursive: true });

const executablePath = process.env["PW_CHROMIUM_PATH"];
const browser = await chromium.launch({
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  ...(executablePath ? { executablePath } : {}),
});

const sizes = [
  ["desktop", { width: 1440, height: 900 }],
  ["mobile", { width: 390, height: 844 }],
];
let failed = false;
for (const [name, viewport] of sizes) {
  const ctx = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await ctx.addInitScript(() => {
    try {
      window.localStorage.setItem("cargo-ops.map.online", "off");
    } catch {
      // storage blocked: the external-request check below catches an online map
    }
  });
  const page = await ctx.newPage();
  const external = [];
  const errors = [];
  page.on("request", (req) => {
    const host = new URL(req.url()).hostname;
    if (host !== "127.0.0.1" && host !== "localhost") external.push(req.url());
  });
  page.on("pageerror", (err) => errors.push(String(err)));
  await page.goto(`${base}/`);
  await page.waitForSelector('[data-testid="ops-map"][data-ready="true"]', { timeout: 60_000 });
  // Let the demo replay reach the climb so the readouts and the loop have real demo frames.
  await page.waitForTimeout(settleMs);
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  const file = resolve(out, `ops-mission-control-${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`${name}: ${file} (scrollWidth ${scrollWidth}px)`);
  if (scrollWidth > viewport.width) {
    console.error(`${name}: horizontal scroll (${scrollWidth} > ${viewport.width})`);
    failed = true;
  }
  if (external.length) {
    console.error(`${name}: external requests`, external);
    failed = true;
  }
  if (errors.length) {
    console.error(`${name}: page errors`, errors);
    failed = true;
  }
  await ctx.close();
}
await browser.close();
process.exit(failed ? 1 : 0);
