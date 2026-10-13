// Loads the bundled OurAirports subset (public domain; large + medium airports with
// the longest runway and its surface). `npm run build` copies it from
// src/assets/data/airports-major.json into dist/data/ (scripts/copy-data.mjs), so a
// built connector needs nothing outside connector/. When running from a checkout
// without that copy, the repository file is used directly.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EconomyAirport } from "../../economy";

const BUILD_COPY = join("data", "airports-major.json");
const REPO_FILE = join("src", "assets", "data", "airports-major.json");

/** Candidate paths, nearest first: <dist>/data/… then <repo>/src/assets/data/…. */
export function airportsDataCandidates(start: string = __dirname): string[] {
  const out: string[] = [];
  let dir = start;
  for (let i = 0; i < 10; i++) {
    out.push(join(dir, BUILD_COPY), join(dir, REPO_FILE));
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

function isAirport(value: unknown): value is EconomyAirport {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v["ident"] === "string" &&
    typeof v["name"] === "string" &&
    typeof v["lat"] === "number" &&
    typeof v["lon"] === "number" &&
    (v["type"] === "large" || v["type"] === "medium" || v["type"] === "small")
  );
}

export function loadAirportsData(path?: string): { path: string; airports: EconomyAirport[] } {
  const file = path ?? airportsDataCandidates().find((p) => existsSync(p));
  if (!file) {
    throw new Error(
      "Airport data not found: run `npm run build` in connector/ (copies src/assets/data/airports-major.json)",
    );
  }
  const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(parsed)) throw new Error(`${file} is not an airport list`);
  return { path: file, airports: parsed.filter(isAirport) };
}
