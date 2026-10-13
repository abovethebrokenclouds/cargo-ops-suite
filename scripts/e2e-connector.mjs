#!/usr/bin/env node
// Starts the built connector in replay mode for Playwright, with a throwaway data dir.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const port = process.argv[2] ?? "4399";
const main = join(root, "connector/dist/connector/src/cli/main.js");
const web = join(root, "dist/client");
for (const [label, path] of [
  ["connector build (cd connector && npm run build)", main],
  ["local web build (bun run build:local)", web],
]) {
  if (!existsSync(path)) {
    console.error(`Missing ${label}: ${path}`);
    process.exit(1);
  }
}
const dataDir = mkdtempSync(join(tmpdir(), "cargo-ops-e2e-"));
const child = spawn(
  process.execPath,
  [
    "--disable-warning=ExperimentalWarning",
    main,
    "--sim",
    "fake",
    "--loop",
    "--speed",
    "4",
    "--port",
    port,
    "--web",
    web,
    "--data-dir",
    dataDir,
  ],
  { stdio: "inherit", cwd: join(root, "connector") },
);
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
