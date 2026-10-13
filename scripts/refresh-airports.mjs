#!/usr/bin/env node
// Refresh the bundled airport subset from OurAirports (public domain, Unlicense).
//
//   node scripts/refresh-airports.mjs            download CSVs, then regenerate the JSON
//   node scripts/refresh-airports.mjs --offline  regenerate from data/ourairports/*.csv only
//
// Full CSVs land in data/ourairports/ (ignored by git). The committed output is
// src/assets/data/airports-major.json: large_airport + medium_airport rows only, with
// the longest open runway joined from runways.csv. data/ourairports/SOURCE.md records
// the fetch date and source URL.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dataDir = join(root, "data/ourairports");
const outFile = join(root, "src/assets/data/airports-major.json");
const sourceFile = join(dataDir, "SOURCE.md");
const FILES = ["airports.csv", "runways.csv"];
const MIRRORS = [
  "https://davidmegginson.github.io/ourairports-data/",
  "https://raw.githubusercontent.com/davidmegginson/ourairports-data/main/",
];
const TYPES = new Set(["large_airport", "medium_airport"]);
/** Soft size budget; above it only airports with scheduled service are kept. */
const MAX_BYTES = 1_500_000;

/** RFC 4180 CSV parser (quoted fields, doubled quotes, CRLF). Returns rows of strings. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function records(text) {
  const [header, ...rows] = parseCsv(text);
  if (!header) return [];
  return rows
    .filter((r) => r.length >= header.length)
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

async function download(name) {
  const errors = [];
  for (const base of MIRRORS) {
    const url = base + name;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "CargoOps/refresh-airports" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      writeFileSync(join(dataDir, name), text);
      console.log(`Downloaded ${url} (${(text.length / 1e6).toFixed(1)} MB)`);
      return url;
    } catch (err) {
      errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`Could not download ${name}:\n  ${errors.join("\n  ")}`);
}

const round = (n, digits) => Number(n.toFixed(digits));

function build(airportsCsv, runwaysCsv, scheduledOnly) {
  const longest = new Map();
  for (const r of records(runwaysCsv)) {
    if (r["closed"] === "1") continue;
    const len = Number(r["length_ft"]);
    if (!Number.isFinite(len) || len <= 0) continue;
    const prev = longest.get(r["airport_ident"]);
    if (!prev || len > prev.len) longest.set(r["airport_ident"], { len, surface: r["surface"] });
  }
  const out = [];
  for (const a of records(airportsCsv)) {
    if (!TYPES.has(a["type"])) continue;
    if (scheduledOnly && a["scheduled_service"] !== "yes") continue;
    const lat = Number(a["latitude_deg"]);
    const lon = Number(a["longitude_deg"]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
    const elev = Number(a["elevation_ft"]);
    const rwy = longest.get(a["ident"]);
    const row = {
      ident: a["ident"],
      ...(a["iata_code"] ? { iata: a["iata_code"] } : {}),
      name: a["name"],
      type: a["type"] === "large_airport" ? "large" : "medium",
      lat: round(lat, 4),
      lon: round(lon, 4),
      ...(a["elevation_ft"] !== "" && Number.isFinite(elev) ? { elevFt: Math.round(elev) } : {}),
      country: a["iso_country"],
      region: a["iso_region"],
      ...(a["municipality"] ? { municipality: a["municipality"] } : {}),
      ...(rwy ? { longestRwyFt: Math.round(rwy.len) } : {}),
      ...(rwy?.surface ? { surface: rwy.surface } : {}),
    };
    out.push(row);
  }
  out.sort((x, y) => (x.ident < y.ident ? -1 : x.ident > y.ident ? 1 : 0));
  return out;
}

async function main() {
  const offline = process.argv.includes("--offline");
  mkdirSync(dataDir, { recursive: true });
  const urls = {};
  if (!offline) {
    for (const name of FILES) urls[name] = await download(name);
  }
  for (const name of FILES) {
    if (!existsSync(join(dataDir, name))) {
      throw new Error(`Missing ${join(dataDir, name)}; run without --offline first.`);
    }
  }
  const airportsCsv = readFileSync(join(dataDir, "airports.csv"), "utf8");
  const runwaysCsv = readFileSync(join(dataDir, "runways.csv"), "utf8");

  let scheduledOnly = false;
  let airports = build(airportsCsv, runwaysCsv, false);
  let json = JSON.stringify(airports);
  if (json.length > MAX_BYTES) {
    scheduledOnly = true;
    airports = build(airportsCsv, runwaysCsv, true);
    json = JSON.stringify(airports);
  }
  mkdirSync(dirname(outFile), { recursive: true });
  writeFileSync(outFile, json + "\n");
  const large = airports.filter((a) => a.type === "large").length;
  console.log(
    `Wrote ${outFile}: ${airports.length} airports (${large} large, ${airports.length - large} medium), ${(statSync(outFile).size / 1024).toFixed(0)} KiB${scheduledOnly ? ", scheduled service only" : ""}`,
  );

  if (!offline) {
    const date = new Date().toISOString().slice(0, 10);
    writeFileSync(
      sourceFile,
      `# OurAirports snapshot

- Fetched: ${date}
- Source: ${Object.values(urls).join(", ")}
- Project: https://github.com/davidmegginson/ourairports-data (data documentation: https://ourairports.com/data/)
- License: public domain (the repository's LICENSE is the Unlicense). Credit to OurAirports is appreciated and given here and in the app.

The CSVs in this folder are ignored by git. \`scripts/refresh-airports.mjs\` regenerates
\`src/assets/data/airports-major.json\` (committed): \`large_airport\` and \`medium_airport\` rows
only (${airports.length} airports${scheduledOnly ? ", cut to scheduled_service=yes to stay under 1.5 MB" : ""}), with the longest open runway and its surface
joined from \`runways.csv\`. Coordinates are rounded to 4 decimals (about 11 m).
`,
    );
    console.log(`Updated ${sourceFile}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
