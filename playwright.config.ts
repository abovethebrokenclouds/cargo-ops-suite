import { defineConfig, devices } from "@playwright/test";

// Two targets:
//  - demo: the Vite dev server (no connector) → DemoTransport, chip must read DEMO DATA.
//  - replay: the real connector with `--sim fake` serving the CARGO_OPS_LOCAL SPA build. Every
//    replay spec file starts its OWN connector on a free port with a fresh data dir
//    (e2e/replay-fixtures.ts), so the specs are independent of each other and of their order.
// PW_CHROMIUM_PATH lets cloud containers use a preinstalled Chromium.
const DEMO_PORT = 5180;
const executablePath = process.env["PW_CHROMIUM_PATH"];
// MapLibre needs WebGL; headless Chromium gets it from SwiftShader (software GL).
const webglArgs = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env["CI"],
  reporter: process.env["CI"] ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    ...devices["Desktop Chrome"],
    launchOptions: { args: webglArgs, ...(executablePath ? { executablePath } : {}) },
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "demo",
      testMatch: /demo\.spec\.ts/,
      // The demo project runs on the unbundled Vite dev server, where loading hundreds of
      // modules dominates time-to-hydrate: measured 1–4 s locally and up to 5.7 s at 4× CPU
      // throttling, which is what a CI runner looks like. A 15 s assertion budget keeps the
      // checks about labels (DEMO DATA, never LIVE), not dev-server speed. The replay project
      // runs the production build and keeps the 5 s default.
      expect: { timeout: 15_000 },
      use: { baseURL: `http://127.0.0.1:${DEMO_PORT}` },
    },
    {
      // baseURL comes from the per-file connector fixture (e2e/replay-fixtures.ts).
      name: "replay",
      testMatch: /replay\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: `bunx vite dev --host 127.0.0.1 --port ${DEMO_PORT} --strictPort`,
      url: `http://127.0.0.1:${DEMO_PORT}`,
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
    },
  ],
});
