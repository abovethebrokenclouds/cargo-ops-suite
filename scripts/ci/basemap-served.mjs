#!/usr/bin/env node
// W-41 (PC-41 without the owner's PC): after scripts\fetch-basemap.ps1 wrote
// <data-dir>\basemap\basemap.pmtiles (CI uses a small -MaxZoom so it downloads quickly), start
// the REAL connector build and check it serves that file the way the map's PMTiles client
// reads it: /api/health reports a local basemap (what the /map badge reads), HEAD gives the
// size, a byte range returns 206 with a PMTiles v3 header whose max zoom matches the extract.
// The data directory is NOT wiped (the basemap was just downloaded into it).
//
//   node scripts/ci/basemap-served.mjs [--max-zoom 2] [--port 4324] [--data-dir <dir>]
// Without --data-dir: %LOCALAPPDATA%\CargoOps on Windows (fetch-basemap.ps1's default target).

import { statSync } from "node:fs";
import { join } from "node:path";
import { assert, assertEqual, ciDataDir, isWindows, run, startConnector } from "./lib.mjs";

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

run("basemap-served", async () => {
  const maxZoom = Number(arg("--max-zoom", "2"));
  const override = arg("--data-dir", undefined);
  if (!override && !isWindows) throw new Error("--data-dir is required outside Windows");
  const dataDir = ciDataDir("basemap", { wipe: false, ...(override ? { dir: override } : {}) });
  const file = join(dataDir.dir, "basemap", "basemap.pmtiles");
  const size = statSync(file).size;
  assert(size > 127, `${file} exists (${(size / 1024).toFixed(0)} KiB)`);

  const c = await startConnector({
    name: "basemap",
    port: Number(arg("--port", "4324")),
    dataDir,
    args: ["--sim", "fake", "--loop"],
  });
  try {
    const health = await (await fetch(`${c.base}/api/health`)).json();
    assertEqual(health.basemap?.local, true, "/api/health reports a local basemap");

    const head = await fetch(`${c.base}/tiles/basemap.pmtiles`, { method: "HEAD" });
    assertEqual(head.status, 200, "HEAD /tiles/basemap.pmtiles");
    assertEqual(Number(head.headers.get("content-length")), size, "HEAD reports the file size");
    assertEqual(head.headers.get("accept-ranges"), "bytes", "byte ranges are advertised");
    assertEqual(head.headers.get("content-type"), "application/vnd.pmtiles", "PMTiles type");

    const res = await fetch(`${c.base}/tiles/basemap.pmtiles`, {
      headers: { Range: "bytes=0-126" },
    });
    assertEqual(res.status, 206, "a byte range answers 206");
    assertEqual(res.headers.get("content-range"), `bytes 0-126/${size}`, "Content-Range");
    const header = Buffer.from(await res.arrayBuffer());
    assertEqual(header.length, 127, "the 127-byte PMTiles header arrives");
    assertEqual(header.subarray(0, 7).toString("latin1"), "PMTiles", "PMTiles magic");
    assertEqual(header[7], 3, "PMTiles spec version 3");
    assertEqual(header[100], 0, "min zoom 0 (world extract)");
    assertEqual(header[101], maxZoom, `max zoom ${maxZoom} as extracted`);

    const tail = await fetch(`${c.base}/tiles/basemap.pmtiles`, {
      headers: { Range: "bytes=-16" },
    });
    assertEqual(tail.status, 206, "a suffix range (last 16 bytes) answers 206");
    assertEqual((await tail.arrayBuffer()).byteLength, 16, "suffix range length");
  } finally {
    await c.stop();
  }
});
