#!/usr/bin/env node
// Live check of the aviationweather.gov METAR endpoint through the connector's OWN fetch and
// mapping code (connector/dist, built by `cd connector && npm run build`).
//
//   node scripts/ci/metar-live.mjs                     # live: KMEM,KATL,EGLL,KJFK
//   node scripts/ci/metar-live.mjs --ids KMEM,KSEA     # other stations
//   node scripts/ci/metar-live.mjs --file connector/fixtures/awc-metar.handmade.json
//
// Prints the raw JSON response (so the CI log doubles as a recorded response), then checks
// every requested station maps to a valid report: station id, a recent observation time,
// a VFR/MVFR/IFR/LIFR category, wind/visibility/ceiling either parsed or explicitly absent
// from the raw text. Our parser's category from rawOb is compared with AWC's fltCat; any
// disagreement is reported (GitHub warning), not failed. Transient network errors (no
// connection, timeout, HTTP 429/5xx) are retried twice with backoff; schema or mapping
// mismatches fail at once. Exit codes: 0 ok, 1 mismatch, 2 network still failing, 3 usage.

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = resolve(root, "connector", "dist");
const require = createRequire(import.meta.url);

function usage(msg) {
  console.error(
    `${msg}\nUsage: node scripts/ci/metar-live.mjs [--ids A,B,…] [--file response.json]`,
  );
  process.exit(3);
}

const args = process.argv.slice(2);
let ids = ["KMEM", "KATL", "EGLL", "KJFK"];
let file = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--ids") ids = (args[++i] ?? "").split(",").filter(Boolean);
  else if (a === "--file") file = args[++i] ?? usage("--file needs a path");
  else usage(`Unknown argument: ${a}`);
}

const serviceJs = resolve(dist, "connector/src/core/weather.js");
const weatherJs = resolve(dist, "packages/weather/src/index.js");
if (!existsSync(serviceJs) || !existsSync(weatherJs)) {
  usage(`Connector build missing (${serviceJs}). Run: cd connector && npm ci && npm run build`);
}
const { WeatherService } = require(serviceJs);
const W = require(weatherJs);
ids = W.normalizeStations(ids);
if (ids.length === 0) usage("No valid station ids");

const inCi = !!process.env["GITHUB_ACTIONS"];
const warn = (m) => console.log(inCi ? `::warning title=METAR live check::${m}` : `WARNING: ${m}`);
const errorLine = (m) => console.log(inCi ? `::error title=METAR live check::${m}` : `ERROR: ${m}`);

// ---- one attempt through WeatherService, capturing the raw body ----

let fileBody = null;
let fileNow = null;
if (file) {
  const parsed = JSON.parse(readFileSync(resolve(file), "utf8"));
  // The hand-made fixture wraps the API array as { _comment, request, response }.
  fileBody = Array.isArray(parsed) ? parsed : parsed.response;
  // Judge recency against the fixture's own clock: 10 min after its newest observation.
  const times = (Array.isArray(fileBody) ? fileBody : [])
    .map((o) => (o && typeof o.obsTime === "number" ? o.obsTime * 1000 : NaN))
    .filter(Number.isFinite);
  fileNow = times.length ? Math.max(...times) + 10 * 60_000 : Date.now();
}

async function attempt() {
  let rawText = null;
  let status = null;
  let url = null;
  const service = new WeatherService({
    mode: "online",
    version: "ci-live-check",
    log: (level, msg) => console.log(`[connector ${level}] ${msg}`),
    db: null,
    ...(fileNow !== null ? { now: () => fileNow } : {}),
    fetch: async (input, init) => {
      url = String(input);
      if (fileBody !== null) {
        rawText = JSON.stringify(fileBody);
        status = 200;
        return new Response(rawText, {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const res = await fetch(input, init);
      status = res.status;
      rawText = await res.clone().text();
      return res;
    },
  });
  const response = await service.metar(ids, true);
  return { response, rawText, status, url };
}

const TRANSIENT = /Could not reach|did not answer in time|closed the connection|HTTP (429|5\d\d)/;

let result;
for (let n = 1; n <= 3; n++) {
  result = await attempt();
  const notes = result.response.stations.filter((s) => !s.report).map((s) => s.note ?? "");
  const transient = notes.some((t) => TRANSIENT.test(t));
  if (!transient) break;
  if (n === 3) {
    errorLine(`aviationweather.gov still failing after 3 attempts: ${notes.join(" | ")}`);
    process.exit(2);
  }
  const wait = 5_000 * 2 ** (n - 1);
  console.log(`Transient failure (${notes[0]}); retry ${n}/2 in ${wait / 1000} s`);
  await new Promise((r) => setTimeout(r, wait));
}

const { response, rawText, status, url } = result;
console.log(`Request: ${url}`);
console.log(`HTTP status: ${status}`);
console.log(`----- BEGIN RAW RESPONSE (${file ? `file ${file}` : "live"}) -----`);
console.log(rawText);
console.log("----- END RAW RESPONSE -----");

// ---- checks ----

const failures = [];
const fail = (m) => failures.push(m);
const now = fileNow ?? Date.now();
const MAX_AGE_MS = 6 * 3600_000;

let body;
try {
  body = JSON.parse(rawText ?? "");
} catch {
  body = null;
}
if (!Array.isArray(body)) fail("response body is not a JSON array");
const rawById = new Map();
for (const item of Array.isArray(body) ? body : []) {
  if (!item || typeof item !== "object") {
    fail("array element is not an object");
    continue;
  }
  if (typeof item.icaoId !== "string" || typeof item.rawOb !== "string") {
    fail(`element without string icaoId/rawOb: ${JSON.stringify(item).slice(0, 120)}`);
    continue;
  }
  if (!rawById.has(item.icaoId)) rawById.set(item.icaoId, item);
}

const WIND_RE = /\s(\d{3}|VRB)\d{2,3}(G\d{2,3})?(KT|MPS|KMH)(\s|$)/;
const VIS_RE = /\s(P|M)?\d+(\/\d+)?SM(\s|$)|\s\d{4}(NDV)?(\s|$)|\sCAVOK(\s|$)/;
const SKY_RE = /\s(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)|\s(CLR|SKC|NSC|NCD|CAVOK)(\s|$)/;
const rows = [];

for (const id of ids) {
  const st = response.stations.find((s) => s.station === id);
  const r = st?.report;
  if (!r) {
    fail(`${id}: no report (${st?.note ?? "missing from the mapped response"})`);
    continue;
  }
  const raw = ` ${r.rawText.split(" RMK ")[0]} `;
  if (r.station !== id) fail(`${id}: mapped station is ${r.station}`);
  if (r.origin !== "live") fail(`${id}: origin ${r.origin}, expected live`);
  if (!rawById.has(id)) fail(`${id}: not present in the raw JSON`);
  const t = r.observedAt ? Date.parse(r.observedAt) : NaN;
  if (!Number.isFinite(t)) fail(`${id}: no observation time`);
  else if (now - t > MAX_AGE_MS) fail(`${id}: observation ${r.observedAt} older than 6 h`);
  else if (t - now > 10 * 60_000) fail(`${id}: observation ${r.observedAt} is in the future`);
  if (!W.isFlightCategory(r.category)) fail(`${id}: category ${r.category} not VFR/MVFR/IFR/LIFR`);
  if (r.wind) {
    if (typeof r.wind.speedKt !== "number" || r.wind.speedKt < 0)
      fail(`${id}: bad wind ${JSON.stringify(r.wind)}`);
  } else if (WIND_RE.test(raw)) fail(`${id}: wind group in rawOb but not mapped`);
  if (r.visibilitySm !== null) {
    if (typeof r.visibilitySm !== "number" || r.visibilitySm < 0)
      fail(`${id}: bad visibility ${r.visibilitySm}`);
  } else if (VIS_RE.test(raw)) fail(`${id}: visibility group in rawOb but not mapped`);
  if (r.clouds === null && SKY_RE.test(raw))
    fail(`${id}: sky groups in rawOb but clouds not mapped`);
  if (r.ceilingFt !== null && (typeof r.ceilingFt !== "number" || r.ceilingFt < 0)) {
    fail(`${id}: bad ceiling ${r.ceilingFt}`);
  }

  // Cross-check: our parser on rawOb vs AWC's own fltCat.
  const awcCat = rawById.get(id)?.fltCat ?? null;
  const parsed = W.parseMetar(r.rawText, new Date(now));
  const ours = parsed?.category ?? null;
  if (W.isFlightCategory(awcCat) && ours && awcCat !== ours) {
    warn(
      `${id}: parser category ${ours} disagrees with AWC fltCat ${awcCat} — rawOb: ${r.rawText}`,
    );
  }
  rows.push({
    station: id,
    observed: r.observedAt,
    category: r.category,
    awcFltCat: awcCat ?? "—",
    parserCat: ours ?? "—",
    wind: W.formatWind(r.wind),
    vis: W.formatVisibility(r.visibilitySm, r.visibilityPlus),
    ceiling: W.formatCeiling(r.ceilingFt, r.clouds !== null),
    decodedBy: r.decodedBy,
  });
}

console.table(rows);
if (failures.length) {
  for (const f of failures) errorLine(f);
  console.log(`METAR check FAILED: ${failures.length} mismatch(es)`);
  process.exit(1);
}
console.log(`METAR check passed for ${ids.join(", ")} (${file ? "file" : "live"})`);
