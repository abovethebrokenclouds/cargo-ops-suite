#!/usr/bin/env node
// Copies the bundled OurAirports subset (public domain) from the web app into a
// connector build folder, so the compiled connector is self-contained:
//   src/assets/data/airports-major.json -> connector/<outDir>/data/airports-major.json
// Runs as part of `npm run build` (dist) and `npm test` (dist-test). The web copy is
// the source of truth (regenerate it with scripts/refresh-airports.mjs).
// Usage: node scripts/copy-data.mjs dist
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const connectorDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(connectorDir, "..");
const outDir = resolve(connectorDir, process.argv[2] ?? "dist");
const rel = relative(connectorDir, outDir);
if (!rel || rel.startsWith("..") || isAbsolute(rel)) {
  console.error(`Refusing to write outside ${connectorDir}: ${outDir}`);
  process.exit(1);
}
const from = resolve(repoRoot, "src/assets/data/airports-major.json");
if (!existsSync(from)) {
  console.error(`Missing ${from}; run scripts/refresh-airports.mjs from the repository root`);
  process.exit(1);
}
const to = resolve(outDir, "data/airports-major.json");
mkdirSync(dirname(to), { recursive: true });
copyFileSync(from, to);
console.log(`Copied airports data -> ${relative(connectorDir, to)}`);
