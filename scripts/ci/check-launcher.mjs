#!/usr/bin/env node
// W-01 (PC-01 without MSFS): checks a connector that scripts\start-cargo-ops.cmd started.
// The workflow runs the launcher in the background with `-NoOpen --sim fake --loop`; this
// script waits for http://127.0.0.1:<port> to serve the SPA, then checks that the WebSocket
// sends a welcome announcing mode "replay" (sim not connected) and that every frame after it
// is labelled source "replay".
//
//   node scripts/ci/check-launcher.mjs [--port 4311] [--timeout-ms 900000]
//                                      [--pid <launcher pid>] [--log <launcher output file>]
// --pid / --log make the wait fail fast when the launcher exits or reports a failure.

import { existsSync, readFileSync } from "node:fs";
import { assert, assertEqual, log, run, sessionToken, waitFor, wsSession } from "./lib.mjs";

const FAILURE =
  /Cargo Ops stopped with exit code|failed \(exit code|Node\.js was not found|is too old for Cargo Ops|Failed to start:/;

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

run("check-launcher", async () => {
  const port = Number(arg("--port", "4311"));
  // The launcher installs dependencies and builds the web app first: allow a long wait.
  const timeoutMs = Number(arg("--timeout-ms", "900000"));
  const base = `http://127.0.0.1:${port}`;
  log(`waiting up to ${timeoutMs / 1000} s for ${base}/api/health`);
  const pid = arg("--pid", undefined);
  const logFile = arg("--log", undefined);
  await waitFor(
    async () => {
      if (pid && !alive(Number(pid))) throw new Error(`launcher (pid ${pid}) exited early`);
      if (logFile && existsSync(logFile)) {
        const failure = FAILURE.exec(readFileSync(logFile, "utf8"));
        if (failure) throw new Error(`launcher exited early: output says "${failure[0]}"`);
      }
      return (await fetch(`${base}/api/health`).catch(() => null))?.ok === true;
    },
    timeoutMs,
    `${base}/api/health`,
    2_000,
  );

  const health = await (await fetch(`${base}/api/health`)).json();
  assertEqual(health.ok, true, "/api/health ok");
  assertEqual(health.mode, "replay", "/api/health mode is replay (--sim fake)");

  const page = await fetch(`${base}/`);
  assertEqual(page.status, 200, "GET / answers 200");
  assert((page.headers.get("content-type") ?? "").startsWith("text/html"), "GET / is text/html");
  const html = await page.text();
  assert(html.includes('rel="manifest"'), "the SPA shell links the web manifest");
  assert(/<script[^>]+type="module"/.test(html), "the SPA shell loads a module script");
  const deep = await fetch(`${base}/map`);
  assertEqual(deep.status, 200, "client-side route /map falls back to the SPA shell");

  const token = await sessionToken(base);
  assert(/^[0-9a-f]{64}$/.test(token), "/api/session hands out a 64-hex token");
  const { welcome, frames } = await wsSession(base, token, { frames: 4 });
  assertEqual(welcome.type, "welcome", "first WebSocket message is a welcome");
  assertEqual(welcome.mode, "replay", "welcome announces mode replay");
  assertEqual(welcome.sim?.connected, false, "welcome says no simulator is connected");
  assertEqual(frames[0]?.type, "snapshot", "a snapshot follows the welcome");
  for (const frame of frames) {
    if (["snapshot", "delta", "event"].includes(frame.type)) {
      assertEqual(frame.source, "replay", `${frame.type} seq ${frame.seq} labelled replay`);
    }
  }
});
