// Shared helpers for the Windows CI checks in scripts/ci/ (see .github/workflows/windows.yml).
// Every check drives the REAL connector build (connector/dist) as a child process, the way the
// launcher does, and talks to it over HTTP/WebSocket only. They run on Linux too (local runs),
// where the data directory is a temp folder instead of %LOCALAPPDATA%\CargoOps.

import { spawn } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const connectorDir = join(repoRoot, "connector");
export const connectorMain = join(connectorDir, "dist", "connector", "src", "cli", "main.js");
const dist = join(connectorDir, "dist", "connector", "src");
/** require() rooted in connector/, for its own dependencies (ws) and compiled modules. */
export const connectorRequire = createRequire(join(connectorDir, "package.json"));
export const isWindows = process.platform === "win32";

/** Load a compiled connector module, e.g. distModule("storage/migrations"). */
export function distModule(path) {
  const file = join(dist, `${path}.js`);
  if (!existsSync(file)) throw new Error(`${file} is missing: run \`npm run build\` in connector/`);
  return connectorRequire(file);
}

export function log(message) {
  console.log(`[ci] ${message}`);
}

export function assert(condition, message) {
  if (!condition) throw new Error(`Assertion failed: ${message}`);
  log(`ok - ${message}`);
}

export function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`Assertion failed: ${message}\n  expected ${e}\n  actual   ${a}`);
  log(`ok - ${message} (${a.length > 80 ? `${a.slice(0, 77)}...` : a})`);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * The data directory the check uses. On Windows it is the connector's real default
 * (%LOCALAPPDATA%\CargoOps, resolved by the compiled config module, and the connector is
 * started WITHOUT --data-dir so its own default resolution is exercised). Elsewhere a temp
 * folder. Wiped at the start so each check begins from a clean install.
 */
export function ciDataDir(label, { wipe: clean = true, dir: override } = {}) {
  if (override) {
    if (clean) rmSync(override, { recursive: true, force: true });
    mkdirSync(override, { recursive: true });
    return { dir: override, explicit: true };
  }
  if (isWindows) {
    const { defaultDataDir } = distModule("core/config");
    const dir = defaultDataDir();
    const local = process.env.LOCALAPPDATA ?? "";
    assert(
      local !== "" && dir.toLowerCase() === join(local, "CargoOps").toLowerCase(),
      `data directory is %LOCALAPPDATA%\\CargoOps (${dir})`,
    );
    if (clean) rmSync(dir, { recursive: true, force: true });
    return { dir, explicit: false };
  }
  return { dir: mkdtempSync(join(tmpdir(), `cargo-ops-ci-${label}-`)), explicit: true };
}

export function wipe(dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

/** Folder for connector stdout/stderr logs (uploaded as a CI artifact on failure). */
export function logsDir() {
  const dir = process.env.CARGO_OPS_CI_LOGS ?? join(repoRoot, "ci-logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

let runCounter = 0;

/**
 * Start `node connector/dist/.../main.js` with `args`. Resolves once /api/health answers.
 * `dataDir` from ciDataDir(): passed as --data-dir only when it is not the platform default.
 */
export async function startConnector({ name, port, dataDir, args = [], timeoutMs = 60_000 }) {
  const fullArgs = ["--disable-warning=ExperimentalWarning", connectorMain, "--port", String(port)];
  if (dataDir.explicit) fullArgs.push("--data-dir", dataDir.dir);
  fullArgs.push(...args);
  const logFile = join(logsDir(), `${name}-${++runCounter}.log`);
  const out = createWriteStream(logFile);
  log(`start connector (${name}): node ${fullArgs.slice(1).join(" ")}`);
  const child = spawn(process.execPath, fullArgs, {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  child.stdout.pipe(out);
  child.stderr.pipe(out);
  const exited = new Promise((r) => child.once("exit", (code, signal) => r({ code, signal })));
  let exitInfo = null;
  void exited.then((info) => (exitInfo = info));
  const base = `http://127.0.0.1:${port}`;
  await waitFor(
    async () => {
      if (exitInfo)
        throw new Error(`connector exited early ${JSON.stringify(exitInfo)}; see ${logFile}`);
      const res = await fetch(`${base}/api/health`).catch(() => null);
      return res?.ok === true;
    },
    timeoutMs,
    `connector /api/health on ${base}`,
  );
  return {
    base,
    child,
    logFile,
    /** Stop like closing the window: the process is terminated (no graceful checkpoint). */
    async stop() {
      if (exitInfo) return exitInfo;
      child.kill();
      const info = await exited;
      out.end();
      return info;
    },
  };
}

export async function waitFor(check, timeoutMs, what, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await check()) return;
    } catch (err) {
      lastError = err;
      if (String(err?.message ?? err).includes("exited early")) throw err;
    }
    await sleep(intervalMs);
  }
  throw new Error(
    `Timed out after ${timeoutMs} ms waiting for ${what}${lastError ? `: ${lastError.message}` : ""}`,
  );
}

/** The access token, fetched the way the web app gets it (same-origin GET, no Origin header). */
export async function sessionToken(base) {
  const res = await fetch(`${base}/api/session`);
  if (!res.ok) throw new Error(`/api/session answered ${res.status}`);
  const body = await res.json();
  return body.token;
}

/** Authenticated JSON API call; returns { status, body }. */
export async function api(base, token, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let parsed = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not JSON; keep the text.
  }
  return { status: res.status, body: parsed };
}

/** Run a check's main() and turn the result into an exit code. */
export function run(name, main) {
  main().then(
    () => {
      log(`${name}: PASS`);
      process.exit(0);
    },
    (err) => {
      console.error(`[ci] ${name}: FAIL`);
      console.error(err?.stack ?? err);
      process.exit(1);
    },
  );
}

/**
 * Open the WebSocket like the web app (Origin = the page's origin), send hello and collect the
 * welcome plus the next `frames` server frames. Resolves { welcome, frames }.
 */
export function wsSession(base, token, { frames = 4, timeoutMs = 30_000 } = {}) {
  const WebSocket = connectorRequire("ws");
  const url = `${base.replace(/^http/, "ws")}/ws`;
  return new Promise((resolvePromise, reject) => {
    const ws = new WebSocket(url, { headers: { Origin: base } });
    const got = [];
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`WebSocket: only ${got.length} messages after ${timeoutMs} ms`));
    }, timeoutMs);
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", v: 1, token, client: "web", wants: ["telemetry"] }));
    });
    ws.on("message", (data) => {
      got.push(JSON.parse(String(data)));
      if (got.length >= frames + 1) {
        clearTimeout(timer);
        ws.close();
        resolvePromise({ welcome: got[0], frames: got.slice(1) });
      }
    });
    ws.on("close", (code, reason) => {
      if (got.length < frames + 1) {
        clearTimeout(timer);
        reject(new Error(`WebSocket closed early (${code} ${reason})`));
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}
