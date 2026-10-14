#!/usr/bin/env node
// W-06 (PC-06 LOGIC ONLY, no MSFS): SimConnect discovery without SimConnect.xml/.cfg.
//
// node-simconnect (LGPL, used unmodified) finds the simulator in this order: SimConnect.cfg in
// the working folder or the home folder, the named pipe
// \\.\pipe\Microsoft Flight Simulator\SimConnect, then the TCP port MSFS writes to
// HKCU\Software\Microsoft\Microsoft Games\Flight Simulator\SimConnect_Port_IPv4 (fallback
// 2048). On Windows this script:
//
//   1. writes SimConnect_Port_IPv4 under HKCU the way MSFS does (REG_SZ, then REG_DWORD) and
//      asserts the library's autodetection returns that port
//   2. creates the MSFS named pipe and asserts the pipe wins
//   3. removes the value and asserts the 2048 fallback
//   4. end to end: writes the value again, listens on that port with a stand-in TCP server and
//      asserts the REAL connector build (`--sim simconnect`) dials it. The stand-in speaks no
//      SimConnect; this proves discovery, not a handshake (PC-03 remains a PC check).
//
// The previous registry value (if any) is restored at the end. On Linux only the fallback and
// the `reg query` output parser are checked; the registry steps are skipped and say so.
//
//   node scripts/ci/simconnect-discovery.mjs [--port 4323]

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assert,
  assertEqual,
  ciDataDir,
  connectorRequire,
  isWindows,
  log,
  run,
  startConnector,
  waitFor,
} from "./lib.mjs";

const KEY = "HKCU\\Software\\Microsoft\\Microsoft Games\\Flight Simulator";
const VALUE = "SimConnect_Port_IPv4";
const PIPE = "\\\\.\\pipe\\Microsoft Flight Simulator\\SimConnect";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

/** node-simconnect's own modules, loaded by file path (the package exports only its index). */
function library(file) {
  const index = connectorRequire.resolve("node-simconnect");
  return connectorRequire(join(dirname(index), file));
}

const reg = (...args) =>
  execFileSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "reg.exe"), args, {
    encoding: "utf8",
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

function readValue() {
  try {
    const out = reg("query", KEY, "/v", VALUE);
    const line = out.split(/\r?\n/).find((l) => l.trim().startsWith(VALUE));
    if (!line) return null;
    const [, type, data] = line.trim().split(/\s{4,}/);
    return { type, data };
  } catch {
    return null;
  }
}

function writeValue(type, data) {
  reg("add", KEY, "/v", VALUE, "/t", type, "/d", data, "/f");
}

function deleteValue() {
  try {
    reg("delete", KEY, "/v", VALUE, "/f");
  } catch {
    // Already absent.
  }
}

function listen(options) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(options, () => resolve(server));
  });
}

const close = (server) => new Promise((r) => server.close(() => r()));

run("simconnect-discovery", async () => {
  const { autodetectServerAddress } = library("connectionParameters.js");
  const { parseRegQueryOutput } = library(join("utils", "registry.js"));

  // No SimConnect.cfg may short-circuit discovery: run from an empty folder, none in home.
  process.chdir(mkdtempSync(join(tmpdir(), "cargo-ops-discovery-")));
  assert(!existsSync(join(homedir(), "SimConnect.cfg")), "no SimConnect.cfg in the home folder");

  // `reg query` output as Windows prints it (REG_SZ as written by MSFS, REG_DWORD in hex).
  const sample = (type, data) =>
    `\r\n${KEY.replace("HKCU", "HKEY_CURRENT_USER")}\r\n    ${VALUE}    ${type}    ${data}\r\n\r\n`;
  assertEqual(parseRegQueryOutput(sample("REG_SZ", "500"), VALUE), "500", "parses REG_SZ");
  assertEqual(
    parseRegQueryOutput(sample("REG_DWORD", "0x1f4"), VALUE),
    "500",
    "parses REG_DWORD (hex → decimal)",
  );

  if (!isWindows) {
    assertEqual(
      await autodetectServerAddress(),
      { type: "ipv4", host: "localhost", port: 2048 },
      "no registry on this OS: falls back to localhost:2048",
    );
    log("SKIPPED on non-Windows: registry write, named pipe and connector dial checks");
    return;
  }

  const previous = readValue();
  log(`previous ${VALUE}: ${previous ? `${previous.type} ${previous.data}` : "(none)"}`);
  try {
    writeValue("REG_SZ", "50123");
    assertEqual(readValue(), { type: "REG_SZ", data: "50123" }, "REG_SZ value written under HKCU");
    assertEqual(
      await autodetectServerAddress(),
      { type: "ipv4", host: "localhost", port: 50123 },
      "autodetection reads the REG_SZ port",
    );
    writeValue("REG_DWORD", "50124");
    assertEqual(
      await autodetectServerAddress(),
      { type: "ipv4", host: "localhost", port: 50124 },
      "autodetection reads the REG_DWORD port",
    );

    const pipe = await listen({ path: PIPE });
    try {
      assertEqual(
        await autodetectServerAddress(),
        { type: "pipe", address: PIPE },
        "the MSFS named pipe wins over the registry port",
      );
    } finally {
      await close(pipe);
    }

    deleteValue();
    assertEqual(
      await autodetectServerAddress(),
      { type: "ipv4", host: "localhost", port: 2048 },
      "no value: falls back to localhost:2048",
    );

    // End to end: the real connector dials the port from the registry.
    const port = 50125;
    writeValue("REG_SZ", String(port));
    let dialled = 0;
    const servers = [];
    for (const host of ["127.0.0.1", "::1"]) {
      try {
        const s = await listen({ host, port });
        s.on("connection", (socket) => {
          dialled++;
          socket.destroy();
        });
        servers.push(s);
      } catch (err) {
        log(`could not listen on [${host}]:${port} (${err.message}); continuing`);
      }
    }
    assert(servers.length > 0, `stand-in listening on port ${port}`);
    const dataDir = ciDataDir("discovery");
    const c = await startConnector({
      name: "discovery",
      port: Number(arg("--port", "4323")),
      dataDir,
      args: ["--sim", "simconnect", "--verbose"],
    });
    try {
      await waitFor(async () => dialled > 0, 30_000, `the connector to dial port ${port}`);
      assert(dialled > 0, `the connector dialled the registry port ${port} (${dialled}×)`);
    } finally {
      await c.stop();
      for (const s of servers) await close(s);
    }
  } finally {
    deleteValue();
    // reg add takes REG_DWORD data as printed by reg query (0x… hex) as well as decimal.
    if (previous) writeValue(previous.type, previous.data);
    log(`restored ${VALUE}: ${previous ? "previous value" : "(removed)"}`);
  }
});
