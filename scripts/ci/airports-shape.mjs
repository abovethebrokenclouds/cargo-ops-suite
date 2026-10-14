#!/usr/bin/env node
// W-43 (PC-43 without the owner's PC): after `node scripts/refresh-airports.mjs` ran on the
// runner, compare the regenerated src/assets/data/airports-major.json with the committed copy:
// same record shape (keys and value types), unique idents, a plausible count, the airports the
// demo and replay fixtures rely on, and SOURCE.md dated today (UTC). CI never commits the
// regenerated data; the workflow restores the committed files afterwards.
//
//   node scripts/ci/airports-shape.mjs <committed.json> [regenerated.json] [SOURCE.md]

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEqual, log, repoRoot, run } from "./lib.mjs";

const [committedPath, regeneratedPath, sourcePath] = [
  process.argv[2],
  process.argv[3] ?? join(repoRoot, "src", "assets", "data", "airports-major.json"),
  process.argv[4] ?? join(repoRoot, "data", "ourairports", "SOURCE.md"),
];

/** key → type ("string" | "number" | "null"), merged over all records. */
function shape(records) {
  const out = new Map();
  for (const r of records) {
    for (const [k, v] of Object.entries(r)) {
      const t = v === null ? "null" : typeof v;
      out.set(k, new Set([...(out.get(k) ?? []), t]));
    }
  }
  return Object.fromEntries([...out].sort().map(([k, s]) => [k, [...s].sort().join("|")]));
}

run("airports-shape", async () => {
  if (!committedPath) throw new Error("usage: airports-shape.mjs <committed.json> [regenerated]");
  const committed = JSON.parse(readFileSync(committedPath, "utf8"));
  const fresh = JSON.parse(readFileSync(regeneratedPath, "utf8"));
  assert(Array.isArray(fresh), "regenerated file is a JSON array");
  log(`committed ${committed.length} airports, regenerated ${fresh.length}`);

  const want = shape(committed);
  const got = shape(fresh);
  assertEqual(Object.keys(got), Object.keys(want), "same record keys");
  for (const key of Object.keys(want)) {
    // A type may disappear (e.g. no null left) but no new type may appear.
    const allowed = new Set(want[key].split("|"));
    assert(
      got[key].split("|").every((t) => allowed.has(t)),
      `${key}: ${got[key]} within committed ${want[key]}`,
    );
  }
  for (const r of fresh) {
    if (!["large", "medium"].includes(r.type)) throw new Error(`unexpected type ${r.type}`);
    if (!(Math.abs(r.lat) <= 90 && Math.abs(r.lon) <= 180))
      throw new Error(`bad position ${r.ident}`);
  }
  assert(true, "every record is large/medium with a valid position");
  const idents = new Set(fresh.map((r) => r.ident));
  assertEqual(idents.size, fresh.length, "idents are unique");
  const ratio = fresh.length / committed.length;
  assert(
    ratio > 0.9 && ratio < 1.1,
    `count within ±10% of the committed data (${ratio.toFixed(3)})`,
  );
  for (const ident of ["KMEM", "KATL", "KLIT"]) {
    assert(idents.has(ident), `${ident} present (used by the fixtures)`);
  }

  const source = readFileSync(sourcePath, "utf8");
  const today = new Date().toISOString().slice(0, 10);
  assert(source.includes(`Fetched: ${today}`), `SOURCE.md dated ${today}`);
});
