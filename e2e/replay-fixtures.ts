import { test as base, expect } from "@playwright/test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Replay specs get their OWN connector: one process per spec file, started on a free port
// (`--port 0`) with a fresh temporary data dir, so no spec depends on what another spec did
// to the company (cash, fleet, FBOs) or on running order. No test-only endpoint exists in
// the connector; isolation comes from separate processes. Tests inside one file share that
// file's connector (they always did), in file order.
//
// Expects `bun run build:local` and `npm run build` in connector/ (see e2e/README.md).

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAIN = join(root, "connector/dist/connector/src/cli/main.js");
const WEB = join(root, "dist/client");
// 20× plays the ~6 min synthetic flight in ~19 s; the connector times phases on the
// fixture's own clock, so the speed never changes what it computes.
const SPEED = process.env["CARGO_OPS_E2E_SPEED"] ?? "20";

export interface ReplayConnector {
  url: string;
  port: number;
  dataDir: string;
  stop(): Promise<void>;
}

export async function startReplayConnector(label: string): Promise<ReplayConnector> {
  return startConnector(label, ["--sim", "fake", "--loop", "--speed", SPEED]);
}

/**
 * Start the real connector with the given simulator arguments (`--sim fake …` for replays,
 * `--simconnect-host/--simconnect-port` against the test-only SimConnect emulator).
 */
export async function startConnector(
  label: string,
  simArgs: readonly string[],
): Promise<ReplayConnector> {
  for (const [what, path] of [
    ["connector build (cd connector && npm run build)", MAIN],
    ["local web build (bun run build:local)", WEB],
  ] as const) {
    if (!existsSync(path)) throw new Error(`Missing ${what}: ${path}`);
  }
  const dataDir = mkdtempSync(join(tmpdir(), `cargo-ops-e2e-${label}-`));
  const child: ChildProcess = spawn(
    process.execPath,
    [
      "--disable-warning=ExperimentalWarning",
      MAIN,
      ...simArgs,
      "--port",
      "0",
      "--web",
      WEB,
      "--data-dir",
      dataDir,
    ],
    { cwd: join(root, "connector"), stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  const url = await new Promise<string>((resolveUrl, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`connector did not start in 30 s:\n${output}`)),
      30_000,
    );
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      const m = /Cargo Ops is running at (http:\/\/127\.0\.0\.1:\d+)\//.exec(output);
      if (m) {
        clearTimeout(timer);
        resolveUrl(m[1] as string);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`connector exited (${code}) before it was ready:\n${output}`));
    });
  });
  // Keep draining the pipes so the child never blocks on a full buffer.
  child.stdout?.resume();
  child.stderr?.resume();
  return {
    url,
    port: Number(new URL(url).port),
    dataDir,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = new Promise<void>((r) => child.once("exit", () => r()));
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      }
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** One connector per spec file per worker; the previous file's connector is stopped. */
class ConnectorPool {
  private current: { file: string; connector: Promise<ReplayConnector> } | null = null;

  async forFile(file: string): Promise<ReplayConnector> {
    if (this.current?.file !== file) {
      await this.stopAll();
      const label = basename(file).replace(/\.replay\.spec\.ts$/, "");
      this.current = { file, connector: startReplayConnector(label) };
    }
    return this.current.connector;
  }

  async stopAll(): Promise<void> {
    const c = this.current;
    this.current = null;
    if (c) await (await c.connector.catch(() => null))?.stop();
  }
}

export const test = base.extend<{ connector: ReplayConnector }, { connectorPool: ConnectorPool }>({
  connectorPool: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, provide) => {
      const pool = new ConnectorPool();
      await provide(pool);
      await pool.stopAll();
    },
    { scope: "worker" },
  ],
  connector: async ({ connectorPool }, provide, testInfo) => {
    await provide(await connectorPool.forFile(testInfo.file));
  },
  baseURL: async ({ connector }, provide) => {
    await provide(connector.url);
  },
  // E2E_CPU_THROTTLE=6 slows the page's CPU like a loaded CI runner (Chromium's own
  // throttling), as in demo.spec.ts, to reproduce replay timing problems locally.
  page: async ({ page }, provide) => {
    const throttle = Number(process.env["E2E_CPU_THROTTLE"] ?? 1);
    if (throttle > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    await provide(page);
  },
});

export { expect };
