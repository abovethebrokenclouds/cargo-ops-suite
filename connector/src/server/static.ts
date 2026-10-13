// Static serving of the SPA build (`dist/client` from `bun run build:local`).
// Paths are decoded, normalised and confined to the web root; dotfiles, NUL,
// backslashes and drive letters are refused. Unknown extension-less paths fall
// back to the SPA shell so client-side routes like /flight load.

import { createReadStream, existsSync, statSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, posix, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export type ResolvedPath =
  | { kind: "file"; path: string }
  | { kind: "shell"; path: string }
  | { kind: "not-found" }
  | { kind: "bad-request" };

const SHELL_CANDIDATES = ["_shell.html", "index.html"];

/** Map a URL pathname to a file inside `root`, or decide it is a SPA route. Pure apart from fs.stat. */
export function resolveStaticPath(root: string, pathname: string): ResolvedPath {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return { kind: "bad-request" };
  }
  if (decoded.includes("\0") || decoded.includes("\\") || decoded.includes(":")) {
    return { kind: "bad-request" };
  }
  const segments = decoded.split("/").filter(Boolean);
  if (segments.some((s) => s === ".." || s === ".")) return { kind: "bad-request" };
  if (segments.some((s) => s.startsWith("."))) return { kind: "not-found" };

  const base = resolve(root);
  const normalized = posix.normalize(`/${segments.join("/")}`);
  const target = resolve(base, `.${normalized}`);
  if (target !== base && !target.startsWith(base + sep)) return { kind: "bad-request" };

  if (target !== base && isFile(target)) return { kind: "file", path: target };

  // Directory or missing: SPA route when the last segment has no extension.
  const last = segments[segments.length - 1] ?? "";
  if (last === "" || extname(last) === "" || extname(last) === ".html") {
    for (const name of SHELL_CANDIDATES) {
      const shell = resolve(base, name);
      if (isFile(shell)) return { kind: "shell", path: shell };
    }
  }
  return { kind: "not-found" };
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function webRootUsable(root: string | undefined): boolean {
  if (!root || !existsSync(root)) return false;
  return SHELL_CANDIDATES.some((name) => isFile(resolve(root, name)));
}

export function serveStatic(
  root: string,
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string,
): void {
  const resolved = resolveStaticPath(root, pathname);
  if (resolved.kind === "bad-request") {
    sendText(res, 400, "Bad request");
    return;
  }
  if (resolved.kind === "not-found") {
    sendText(res, 404, "Not found");
    return;
  }
  const isAsset = resolved.kind === "file" && pathname.startsWith("/assets/");
  res.statusCode = 200;
  res.setHeader("Content-Type", contentTypeFor(resolved.path));
  res.setHeader("Cache-Control", isAsset ? "public, max-age=31536000, immutable" : "no-cache");
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  const stream = createReadStream(resolved.path);
  stream.on("error", () => {
    if (!res.headersSent) sendText(res, 500, "Read error");
    else res.destroy();
  });
  stream.pipe(res);
}

export function sendText(res: ServerResponse, status: number, text: string): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(text);
}
