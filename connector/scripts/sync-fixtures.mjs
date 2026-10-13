#!/usr/bin/env node
// Copies the web app's synthetic demo fixture into connector/fixtures/ so the
// connector's FakeSource (`--sim fake`) replays exactly the same frames.
// The web copy (src/lib/transport/fixtures/) is the source of truth; never edit
// connector/fixtures/demo-kmem-katl.jsonl by hand. Usage: npm run fixtures:sync
import { copyFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const connectorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(connectorDir, "..");
const files = ["demo-kmem-katl.jsonl"];

mkdirSync(resolve(connectorDir, "fixtures"), { recursive: true });
for (const name of files) {
  const from = resolve(repoRoot, "src/lib/transport/fixtures", name);
  const to = resolve(connectorDir, "fixtures", name);
  copyFileSync(from, to);
  console.log(`Copied ${from} -> ${to}`);
}
