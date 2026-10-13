import { defineConfig, devices } from "@playwright/test";

// Two targets:
//  - demo: the Vite dev server (no connector) → DemoTransport, chip must read DEMO DATA.
//  - replay: the real connector with `--sim fake` serving the CARGO_OPS_LOCAL SPA build.
// PW_CHROMIUM_PATH lets cloud containers use a preinstalled Chromium.
const DEMO_PORT = 5180;
const CONNECTOR_PORT = 4399;
const executablePath = process.env["PW_CHROMIUM_PATH"];
// MapLibre needs WebGL; headless Chromium gets it from SwiftShader (software GL).
const webglArgs = ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"];

export default defineConfig({
  testDir: "e2e",
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
      use: { baseURL: `http://127.0.0.1:${DEMO_PORT}` },
    },
    {
      name: "replay",
      testMatch: /replay\.spec\.ts/,
      use: { baseURL: `http://127.0.0.1:${CONNECTOR_PORT}` },
    },
  ],
  webServer: [
    {
      command: `bunx vite dev --host 127.0.0.1 --port ${DEMO_PORT} --strictPort`,
      url: `http://127.0.0.1:${DEMO_PORT}`,
      reuseExistingServer: !process.env["CI"],
      timeout: 120_000,
    },
    {
      // Expects `bun run build:local` and `npm run build` in connector/ to have run (see e2e/README.md).
      command: `node scripts/e2e-connector.mjs ${CONNECTOR_PORT}`,
      url: `http://127.0.0.1:${CONNECTOR_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
