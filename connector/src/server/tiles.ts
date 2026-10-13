// Local basemap: GET/HEAD /tiles/<name>.pmtiles from the basemap directory
// (default <data-dir>/basemap, or --basemap-dir) with single HTTP byte ranges, which
// is all the PMTiles client needs. Names are restricted to [a-z0-9-] (no traversal).

import { createReadStream, statSync, type Stats } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { sendText } from "./static";

export const TILES_PREFIX = "/tiles/";
export const BASEMAP_FILE = "basemap.pmtiles";
const NAME_RE = /^[a-z0-9-]+$/;

export type ByteRange = { start: number; end: number };

/**
 * Parse a Range header for a file of `size` bytes.
 *   null       → no Range header (serve the whole file)
 *   ByteRange  → one satisfiable range, inclusive end
 *   "invalid"  → malformed, multiple or unsatisfiable (416)
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "invalid" | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return "invalid";
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return "invalid";
  if (first === "") {
    // Suffix range: the last N bytes.
    const n = Number(last);
    if (!Number.isSafeInteger(n) || n <= 0 || size === 0) return "invalid";
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) return "invalid";
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

/** Absolute path of /tiles/<name>.pmtiles inside `dir`, or null when the name is not allowed. */
export function tileFilePath(dir: string, pathname: string): string | null {
  if (!pathname.startsWith(TILES_PREFIX)) return null;
  const file = pathname.slice(TILES_PREFIX.length);
  if (!file.endsWith(".pmtiles")) return null;
  const name = file.slice(0, -".pmtiles".length);
  if (!NAME_RE.test(name)) return null;
  return join(dir, `${name}.pmtiles`);
}

function fileStats(path: string): Stats | null {
  try {
    const stats = statSync(path);
    return stats.isFile() ? stats : null;
  } catch {
    return null;
  }
}

/** True when `<dir>/basemap.pmtiles` exists. */
export function hasLocalBasemap(dir: string | undefined): boolean {
  return dir !== undefined && fileStats(join(dir, BASEMAP_FILE)) !== null;
}

export function serveTiles(
  dir: string | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): void {
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    sendText(res, 405, "Method not allowed");
    return;
  }
  const path = dir ? tileFilePath(dir, pathname) : null;
  if (!path) {
    sendText(res, dir ? 400 : 404, dir ? "Bad tile archive name" : "No basemap directory");
    return;
  }
  const stats = fileStats(path);
  if (!stats) {
    sendText(res, 404, "Basemap not found. Run scripts/fetch-basemap to download one.");
    return;
  }
  const size = stats.size;
  const etag = `"${size.toString(16)}-${Math.floor(stats.mtimeMs).toString(16)}"`;
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", "application/vnd.pmtiles");
  // Archives are replaced rarely; revalidate daily, ETag keeps conditional requests cheap.
  res.setHeader("Cache-Control", "public, max-age=86400");
  res.setHeader("ETag", etag);
  res.setHeader("Last-Modified", stats.mtime.toUTCString());

  const ifRange = req.headers["if-range"];
  const rangeHeader = ifRange && ifRange !== etag ? undefined : req.headers.range;
  if (!rangeHeader && req.headers["if-none-match"] === etag) {
    res.statusCode = 304;
    res.end();
    return;
  }
  const range = parseRange(rangeHeader, size);
  if (range === "invalid") {
    res.statusCode = 416;
    res.setHeader("Content-Range", `bytes */${size}`);
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Range not satisfiable");
    return;
  }
  const start = range?.start ?? 0;
  const end = range?.end ?? size - 1;
  res.statusCode = range ? 206 : 200;
  if (range) res.setHeader("Content-Range", `bytes ${start}-${end}/${size}`);
  res.setHeader("Content-Length", String(size === 0 ? 0 : end - start + 1));
  if (req.method === "HEAD" || size === 0) {
    res.end();
    return;
  }
  const stream = createReadStream(path, { start, end });
  stream.on("error", () => {
    if (!res.headersSent) sendText(res, 500, "Read error");
    else res.destroy();
  });
  stream.pipe(res);
}
