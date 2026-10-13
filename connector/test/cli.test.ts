import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseArgs } from "../src/cli/args";
import { configPath, defaultDataDir, loadOrCreateConfig } from "../src/core/config";
import { tempDir } from "./helpers";

const MAIN = join(__dirname, "..", "src", "cli", "main.js");

describe("parseArgs", () => {
  it("has safe defaults", () => {
    const r = parseArgs([]);
    assert.ok(r.ok);
    if (!r.ok) return;
    assert.equal(r.options.sim, "simconnect");
    assert.equal(r.options.port, 4311);
    assert.equal(r.options.speed, 1);
    assert.equal(r.options.loop, false);
    assert.deepEqual(r.options.devOrigins, []);
  });

  it("parses every flag", () => {
    const r = parseArgs([
      "--sim",
      "fake",
      "--fixture=f.jsonl",
      "--speed",
      "4",
      "--loop",
      "--record",
      "out.jsonl",
      "--port",
      "0",
      "--web",
      "../dist/client",
      "--data-dir",
      "/tmp/x",
      "--dev-origin",
      "--dev-origin",
      "http://localhost:3000",
      "--open",
      "--reset-token",
      "--verbose",
    ]);
    assert.ok(r.ok, r.ok ? "" : r.error);
    if (!r.ok) return;
    assert.equal(r.options.sim, "fake");
    assert.equal(r.options.fixture, "f.jsonl");
    assert.equal(r.options.speed, 4);
    assert.equal(r.options.loop, true);
    assert.equal(r.options.record, "out.jsonl");
    assert.equal(r.options.port, 0);
    assert.equal(r.options.web, "../dist/client");
    assert.equal(r.options.dataDir, "/tmp/x");
    assert.deepEqual(r.options.devOrigins, [
      "http://localhost:8080",
      "http://127.0.0.1:8080",
      "http://localhost:3000",
    ]);
    assert.equal(r.options.open, true);
    assert.equal(r.options.resetToken, true);
  });

  it("rejects bad input", () => {
    assert.equal(parseArgs(["--sim", "xplane"]).ok, false);
    assert.equal(parseArgs(["--speed", "0"]).ok, false);
    assert.equal(parseArgs(["--port", "70000"]).ok, false);
    assert.equal(parseArgs(["--port"]).ok, false);
    assert.equal(parseArgs(["--bogus"]).ok, false);
    assert.equal(parseArgs(["stray"]).ok, false);
    assert.equal(parseArgs(["--fixture", "x.jsonl"]).ok, false, "--fixture needs --sim fake");
  });
});

describe("data dir and token", () => {
  it("uses %LOCALAPPDATA%\\CargoOps on Windows and XDG/~/.config elsewhere", () => {
    assert.equal(
      defaultDataDir({
        platform: "win32",
        env: { LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local" },
        home: "C:\\Users\\me",
      }),
      "C:\\Users\\me\\AppData\\Local\\CargoOps",
    );
    assert.equal(
      defaultDataDir({ platform: "win32", env: {}, home: "C:\\Users\\me" }),
      "C:\\Users\\me\\AppData\\Local\\CargoOps",
    );
    assert.equal(
      defaultDataDir({ platform: "linux", env: { XDG_CONFIG_HOME: "/xdg" }, home: "/home/me" }),
      "/xdg/cargo-ops",
    );
    assert.equal(
      defaultDataDir({ platform: "linux", env: {}, home: "/home/me" }),
      "/home/me/.config/cargo-ops",
    );
  });

  it("generates a 32-byte hex token once and keeps it", () => {
    const tmp = tempDir();
    try {
      const first = loadOrCreateConfig(tmp.dir);
      assert.equal(first.created, true);
      assert.match(first.config.token, /^[0-9a-f]{64}$/);
      const second = loadOrCreateConfig(tmp.dir);
      assert.equal(second.created, false);
      assert.equal(second.config.token, first.config.token);
      const reset = loadOrCreateConfig(tmp.dir, { resetToken: true });
      assert.notEqual(reset.config.token, first.config.token);
      const onDisk = JSON.parse(readFileSync(configPath(tmp.dir), "utf8")) as { token: string };
      assert.equal(onDisk.token, reset.config.token);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("main entry point", () => {
  it("prints help", () => {
    const r = spawnSync(process.execPath, [MAIN, "--help"], { encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /--sim simconnect\|fake/);
    assert.match(r.stdout, /--record <path>/);
  });

  it("refuses --lan", () => {
    const r = spawnSync(process.execPath, [MAIN, "--lan"], { encoding: "utf8" });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /not implemented/);
  });

  it("rejects unknown flags with exit code 2", () => {
    const r = spawnSync(process.execPath, [MAIN, "--nope"], { encoding: "utf8" });
    assert.equal(r.status, 2);
  });
});
