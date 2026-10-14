import { defineConfig, devices } from "@playwright/test";

// Two targets:
//  - demo: the production SSR build (`bun run build` → .output, the build Lovable publishes),
//    served by e2e/serve-ssr.mjs with no connector → DemoTransport, chip must read DEMO DATA.
//    E2E_DEMO_DEV=1 runs the same specs against the Vite dev server instead (slower: in dev,
//    hydration fetches ~240 unbundled modules after the load event, against ~30 in the build,
//    which on a loaded CI runner took longer than the assertion budget).
//  - replay: the real connector with `--sim fake` serving the CARGO_OPS_LOCAL SPA build. Every
//    replay spec file starts its OWN connector on a free port with a fresh data dir
//    (e2e/replay-fixtures.ts), so the specs are independent of each other and of their order.
//  - live: the real connector in SimConnect mode against the test-only SimConnect protocol
//    emulator (emulated evidence about our code, never about MSFS).
// PW_CHROMIUM_PATH lets cloud containers use a preinstalled Chromium.
// E2E_PORT moves the demo server off the default so parallel runs (other worktrees, the gate)
// never collide on one port. A server already listening there is reused only when
// E2E_REUSE_SERVER=1: silently reusing another checkout's server tests the wrong code.
const DEMO_PORT = Number(process.env["E2E_PORT"] ?? 5180);
if (!Number.isInteger(DEMO_PORT) || DEMO_PORT <= 0 || DEMO_PORT > 65535) {
  throw new Error(`E2E_PORT must be a TCP port, got ${process.env["E2E_PORT"]}`);
}
const DEMO_DEV = process.env["E2E_DEMO_DEV"] === "1";
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
      // Generous for a software-WebGL CI runner; the checks are about labels (DEMO DATA,
      // never LIVE), not speed. The replay project keeps the 5 s default.
      expect: { timeout: 15_000 },
      use: { baseURL: `http://127.0.0.1:${DEMO_PORT}` },
    },
    {
      // baseURL comes from the per-file connector fixture (e2e/replay-fixtures.ts).
      name: "replay",
      testMatch: /replay\.spec\.ts/,
    },
    {
      // Live mode: the real connector against the test-only SimConnect emulator
      // (connector/test/support/simconnect-emulator.ts); the spec starts both itself.
      name: "live",
      testMatch: /live\.spec\.ts/,
    },
  ],
  webServer: [
    {
      command: DEMO_DEV
        ? `bunx vite dev --host 127.0.0.1 --port ${DEMO_PORT} --strictPort`
        : `node e2e/serve-ssr.mjs --port ${DEMO_PORT}`,
      url: `http://127.0.0.1:${DEMO_PORT}`,
      reuseExistingServer: !process.env["CI"] && process.env["E2E_REUSE_SERVER"] === "1",
      timeout: 120_000,
    },
  ],
});
