#!/usr/bin/env node
// Live check of the aviationweather.gov METAR and TAF endpoints through the connector's OWN
// fetch and mapping code (connector/dist, built by `cd connector && npm run build`).
//
//   node scripts/ci/metar-live.mjs                      # live METAR + TAF: KMEM,KATL,EGLL,KJFK
//   node scripts/ci/metar-live.mjs --ids KMEM,KSEA      # other stations
//   node scripts/ci/metar-live.mjs --product metar --file connector/fixtures/awc-metar.handmade.json
//   node scripts/ci/metar-live.mjs --product taf --file connector/fixtures/awc-taf.handmade.json
//
// Prints the raw JSON response of every request (so the CI log doubles as a recorded
// response), then checks every requested station maps to a valid report.
//   METAR: station id, a recent observation time, a VFR/MVFR/IFR/LIFR category, wind/
//          visibility/ceiling either parsed or explicitly absent from the raw text. Our
//          parser's category from rawOb is compared with AWC's fltCat.
//   TAF:   station id, a recent issue time, a validity window that has not ended, at least
//          one period starting with the initial forecast, every period inside the validity
//          with a category, FM periods in time order. Our period count is compared with the
//          length of AWC's `fcsts` array.
// Disagreements with AWC's own decoding are reported (GitHub warning), not failed. Transient
// network errors (no connection, timeout, HTTP 429/5xx) are retried twice with backoff;
// schema or mapping mismatches fail at once. Exit codes: 0 ok, 1 mismatch, 2 network still
// failing, 3 usage.

import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = resolve(root, "connector", "dist");
const require = createRequire(import.meta.url);

function usage(msg) {
  console.error(
    `${msg}\nUsage: node scripts/ci/metar-live.mjs [--ids A,B,…] [--product metar|taf|both] [--file response.json]`,
  );
  process.exit(3);
}

const args = process.argv.slice(2);
let ids = ["KMEM", "KATL", "EGLL", "KJFK"];
let file = null;
let product = "both";
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "--ids") ids = (args[++i] ?? "").split(",").filter(Boolean);
  else if (a === "--file") file = args[++i] ?? usage("--file needs a path");
  else if (a === "--product") product = args[++i] ?? usage("--product needs a value");
  else usage(`Unknown argument: ${a}`);
}
if (!["metar", "taf", "both"].includes(product)) usage(`Unknown product: ${product}`);
if (file && product === "both") usage("--file needs --product metar or --product taf");

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
const warn = (m) =>
  console.log(inCi ? `::warning title=Weather live check::${m}` : `WARNING: ${m}`);
const errorLine = (m) =>
  console.log(inCi ? `::error title=Weather live check::${m}` : `ERROR: ${m}`);

// ---- fixture file: the API array, or the hand-made wrapper { _comment, request, response } ----

let fileBody = null;
let fileNow = null;
if (file) {
  const parsed = JSON.parse(readFileSync(resolve(file), "utf8"));
  fileBody = Array.isArray(parsed) ? parsed : parsed.response;
  // Judge recency against the fixture's own clock: 10 min after its newest time.
  const times = (Array.isArray(fileBody) ? fileBody : [])
    .map((o) => {
      if (!o || typeof o !== "object") return NaN;
      if (typeof o.obsTime === "number") return o.obsTime * 1000;
      if (typeof o.issueTime === "string") return Date.parse(o.issueTime);
      return NaN;
    })
    .filter(Number.isFinite);
  fileNow = times.length ? Math.max(...times) + 10 * 60_000 : Date.now();
}

// ---- one attempt through WeatherService, capturing the raw body ----

async function attempt(kind) {
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
  const response = kind === "metar" ? await service.metar(ids, true) : await service.taf(ids, true);
  return { response, rawText, status, url };
}

const TRANSIENT = /Could not reach|did not answer in time|closed the connection|HTTP (429|5\d\d)/;

async function fetchWithRetries(kind) {
  let result;
  for (let n = 1; n <= 3; n++) {
    result = await attempt(kind);
    const notes = result.response.stations.filter((s) => !s.report).map((s) => s.note ?? "");
    const transient = notes.some((t) => TRANSIENT.test(t));
    if (!transient) break;
    if (n === 3) {
      errorLine(
        `aviationweather.gov (${kind}) still failing after 3 attempts: ${notes.join(" | ")}`,
      );
      process.exit(2);
    }
    const wait = 5_000 * 2 ** (n - 1);
    console.log(`Transient failure (${notes[0]}); retry ${n}/2 in ${wait / 1000} s`);
    await new Promise((r) => setTimeout(r, wait));
  }
  const { rawText, status, url } = result;
  console.log(`\n===== ${kind.toUpperCase()} =====`);
  console.log(`Request: ${url}`);
  console.log(`HTTP status: ${status}`);
  console.log(
    `----- BEGIN RAW ${kind.toUpperCase()} RESPONSE (${file ? `file ${file}` : "live"}) -----`,
  );
  console.log(rawText);
  console.log(`----- END RAW ${kind.toUpperCase()} RESPONSE -----`);
  return result;
}

function rawArray(rawText, rawField, fail) {
  let body;
  try {
    body = JSON.parse(rawText ?? "");
  } catch {
    body = null;
  }
  if (!Array.isArray(body)) fail("response body is not a JSON array");
  const byId = new Map();
  for (const item of Array.isArray(body) ? body : []) {
    if (!item || typeof item !== "object") {
      fail("array element is not an object");
      continue;
    }
    if (typeof item.icaoId !== "string" || typeof item[rawField] !== "string") {
      fail(`element without string icaoId/${rawField}: ${JSON.stringify(item).slice(0, 120)}`);
      continue;
    }
    if (!byId.has(item.icaoId)) byId.set(item.icaoId, item);
  }
  return byId;
}

const now = fileNow ?? Date.now();

// ---- METAR checks ----

async function checkMetar() {
  const { response, rawText } = await fetchWithRetries("metar");
  const failures = [];
  const fail = (m) => failures.push(`METAR ${m}`);
  const MAX_AGE_MS = 6 * 3600_000;
  const rawById = rawArray(rawText, "rawOb", fail);

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
    if (!W.isFlightCategory(r.category))
      fail(`${id}: category ${r.category} not VFR/MVFR/IFR/LIFR`);
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
  return failures;
}

// ---- TAF checks ----

async function checkTaf() {
  const { response, rawText } = await fetchWithRetries("taf");
  const failures = [];
  const fail = (m) => failures.push(`TAF ${m}`);
  const MAX_AGE_MS = 12 * 3600_000;
  const rawById = rawArray(rawText, "rawTAF", fail);
  const rows = [];
  const periodRows = [];

  for (const id of ids) {
    const st = response.stations.find((s) => s.station === id);
    const r = st?.report;
    if (!r) {
      fail(`${id}: no TAF (${st?.note ?? "missing from the mapped response"})`);
      continue;
    }
    if (r.station !== id) fail(`${id}: mapped station is ${r.station}`);
    if (r.origin !== "live") fail(`${id}: origin ${r.origin}, expected live`);
    const item = rawById.get(id);
    if (!item) fail(`${id}: not present in the raw JSON`);
    const issued = r.issuedAt ? Date.parse(r.issuedAt) : NaN;
    if (!Number.isFinite(issued)) fail(`${id}: no issue time`);
    else if (now - issued > MAX_AGE_MS) fail(`${id}: issued ${r.issuedAt}, older than 12 h`);
    else if (issued - now > 60 * 60_000) fail(`${id}: issue time ${r.issuedAt} is in the future`);
    const from = r.validFrom ? Date.parse(r.validFrom) : NaN;
    const to = r.validTo ? Date.parse(r.validTo) : NaN;
    if (!Number.isFinite(from) || !Number.isFinite(to)) fail(`${id}: no validity window`);
    else {
      if (to <= now) fail(`${id}: validity ended ${r.validTo}`);
      if (to - from > 36 * 3600_000 || to <= from)
        fail(`${id}: odd validity ${r.validFrom} – ${r.validTo}`);
    }
    if (r.periods.length === 0) fail(`${id}: no forecast periods`);
    if (r.periods[0] && r.periods[0].kind !== "BASE")
      fail(`${id}: first period is ${r.periods[0].kind}, expected the initial forecast`);
    let lastFm = -Infinity;
    for (const p of r.periods) {
      const pf = Date.parse(p.from);
      const pt = Date.parse(p.to);
      if (!Number.isFinite(pf) || !Number.isFinite(pt) || pt <= pf)
        fail(`${id}: bad period times ${p.from} – ${p.to} (${p.text})`);
      if (Number.isFinite(from) && Number.isFinite(to) && (pf < from || pt > to))
        fail(`${id}: period outside validity (${p.text})`);
      if (!W.isFlightCategory(p.category)) fail(`${id}: period without category (${p.text})`);
      if (p.kind === "BASE" || p.kind === "FM") {
        if (pf < lastFm) fail(`${id}: FM periods out of order (${p.text})`);
        lastFm = pf;
      }
      periodRows.push({
        station: id,
        period: W.tafPeriodLabel(p),
        from: W.formatTafTime(p.from),
        to: W.formatTafTime(p.to),
        category: p.category ?? "—",
        text: p.text.length > 60 ? `${p.text.slice(0, 57)}…` : p.text,
      });
    }
    const fcsts = Array.isArray(item?.fcsts) ? item.fcsts : null;
    if (fcsts && fcsts.length !== r.periods.length) {
      warn(
        `${id}: ${r.periods.length} periods parsed, AWC fcsts has ${fcsts.length} — rawTAF: ${r.rawText}`,
      );
    }
    if (!fcsts) warn(`${id}: no fcsts array in the AWC JSON (shape changed?)`);
    if (item && typeof item.issueTime !== "string")
      warn(`${id}: issueTime is ${typeof item.issueTime}, documented as an ISO string`);
    if (item && typeof item.validTimeFrom !== "number")
      warn(`${id}: validTimeFrom is ${typeof item.validTimeFrom}, documented as unix seconds`);
    const at = W.tafAt(r, Math.max(now, Number.isFinite(from) ? from : now));
    rows.push({
      station: id,
      issued: r.issuedAt,
      valid: `${W.formatTafTime(r.validFrom)}–${W.formatTafTime(r.validTo)}`,
      periods: r.periods.length,
      awcFcsts: fcsts ? fcsts.length : "—",
      nowCategory: at.category ?? "—",
      nowWorst: at.worst ?? "—",
      amended: r.amended,
    });
  }
  console.table(rows);
  console.table(periodRows);
  return failures;
}

const failures = [];
if (product === "metar" || product === "both") failures.push(...(await checkMetar()));
if (product === "taf" || product === "both") failures.push(...(await checkTaf()));

const what = product === "both" ? "METAR + TAF" : product.toUpperCase();
if (failures.length) {
  for (const f of failures) errorLine(f);
  console.log(`${what} check FAILED: ${failures.length} mismatch(es)`);
  process.exit(1);
}
console.log(`${what} check passed for ${ids.join(", ")} (${file ? "file" : "live"})`);
