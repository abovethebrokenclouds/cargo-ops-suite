#!/usr/bin/env node
// Fails when a dependency in any package.json is not listed in docs/ASSET_INVENTORY.md.
// The first column of every inventory table may list several comma-separated names
// and may use a trailing `*` wildcard (e.g. `@radix-ui/*`).
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifests = ["package.json", "connector/package.json"].filter((p) =>
  existsSync(resolve(root, p)),
);

const inventory = readFileSync(resolve(root, "docs/ASSET_INVENTORY.md"), "utf8");
const listed = new Set();
for (const line of inventory.split("\n")) {
  if (!line.startsWith("|") || /^\|\s*-/.test(line)) continue;
  const first = line.split("|")[1] ?? "";
  for (const raw of first.split(",")) {
    const name = raw
      .replace(/[`*_]{2,}/g, "")
      .replace(/`/g, "")
      .replace(/\(.*\)/, "")
      .trim();
    if (name && name !== "Name") listed.add(name);
  }
}

function isListed(dep) {
  if (listed.has(dep)) return true;
  for (const entry of listed) {
    if (entry.endsWith("/*") && dep.startsWith(entry.slice(0, -1))) return true;
  }
  return false;
}

const missing = [];
for (const manifest of manifests) {
  const pkg = JSON.parse(readFileSync(resolve(root, manifest), "utf8"));
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (!isListed(dep)) missing.push(`${manifest} ${field}: ${dep}`);
    }
  }
}

if (missing.length) {
  console.error("Dependencies missing from docs/ASSET_INVENTORY.md:");
  for (const m of missing) console.error(`  - ${m}`);
  console.error("Add an inventory row with a verified license before adding a dependency.");
  process.exit(1);
}
console.log(`Inventory check passed (${manifests.join(", ")}).`);
