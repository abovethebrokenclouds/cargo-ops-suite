#!/usr/bin/env node
// Cross-platform `rm -rf` for build output folders inside connector/.
// Usage: node scripts/clean.mjs dist [dist-test ...]
import { rmSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const connectorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
for (const arg of process.argv.slice(2)) {
  const target = resolve(connectorDir, arg);
  const rel = relative(connectorDir, target);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
    console.error(`Refusing to remove ${target}: not inside ${connectorDir}`);
    process.exit(1);
  }
  rmSync(target, { recursive: true, force: true });
}
