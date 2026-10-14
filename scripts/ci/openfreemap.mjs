#!/usr/bin/env node
// W-42 (PC-42 network part, from a GitHub-hosted Windows runner, not the owner's PC): the
// online fallback basemap is reachable without a key. Fetches the style URL the app uses
// (OPENFREEMAP_STYLE_URL, read from src/lib/map/style.ts so it cannot drift), each vector
// source's TileJSON, one z0 tile, and the sprite index when the style has one. Checks the
// attribution the map shows (© OpenStreetMap · © OpenMapTiles) arrives with the sources.
// The /map badge and on-screen attribution are covered by the e2e/vitest suites.
//
//   node scripts/ci/openfreemap.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEqual, log, repoRoot, run } from "./lib.mjs";

async function get(url, what) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "CargoOps-CI (github.com actions; reachability check)" },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return res;
      lastError = new Error(`${what}: HTTP ${res.status} for ${url}`);
    } catch (err) {
      lastError = err;
    }
    log(`${what}: attempt ${attempt} failed (${lastError.message}); retrying`);
    await new Promise((r) => setTimeout(r, attempt * 2_000));
  }
  throw lastError;
}

run("openfreemap", async () => {
  const styleTs = readFileSync(join(repoRoot, "src", "lib", "map", "style.ts"), "utf8");
  const match = /OPENFREEMAP_STYLE_URL\s*=\s*"([^"]+)"/.exec(styleTs);
  assert(match !== null, "OPENFREEMAP_STYLE_URL found in src/lib/map/style.ts");
  const styleUrl = match[1];
  log(`style: ${styleUrl}`);

  const style = await (await get(styleUrl, "style")).json();
  assertEqual(style.version, 8, "a MapLibre style (version 8)");
  assert(Array.isArray(style.layers) && style.layers.length > 0, `${style.layers.length} layers`);
  const vector = Object.entries(style.sources ?? {}).filter(([, s]) => s.type === "vector");
  assert(vector.length > 0, `vector sources: ${vector.map(([k]) => k).join(", ")}`);

  const attributions = [];
  for (const [name, source] of vector) {
    let tiles = source.tiles;
    if (source.attribution) attributions.push(source.attribution);
    if (!tiles && source.url) {
      const tilejson = await (await get(source.url, `${name} TileJSON`)).json();
      tiles = tilejson.tiles;
      if (tilejson.attribution) attributions.push(tilejson.attribution);
    }
    assert(Array.isArray(tiles) && tiles.length > 0, `${name}: tile URL template present`);
    const tileUrl = tiles[0].replace("{z}", "0").replace("{x}", "0").replace("{y}", "0");
    const tile = await get(tileUrl, `${name} z0 tile`);
    const bytes = (await tile.arrayBuffer()).byteLength;
    assert(bytes > 0, `${name}: z0/0/0 tile downloaded (${bytes} bytes)`);
  }
  const text = attributions.join(" ");
  assert(/OpenStreetMap/i.test(text), "attribution names OpenStreetMap");
  assert(/OpenMapTiles/i.test(text), "attribution names OpenMapTiles");

  if (typeof style.sprite === "string") {
    const sprite = await get(`${style.sprite}.json`, "sprite index");
    assert((await sprite.json()) !== null, "sprite index reachable");
  }
});
