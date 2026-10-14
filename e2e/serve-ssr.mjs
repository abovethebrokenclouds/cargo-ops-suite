// Serves the production SSR build (`bun run build` → .output, Nitro's cloudflare-module
// preset) on 127.0.0.1 with plain Node: the worker's own `fetch` handler renders pages, and
// a minimal stand-in for the Cloudflare `ASSETS` binding serves .output/public. No Wrangler,
// no new dependency. The e2e demo project runs against this: it is the bundled, minified
// build Lovable publishes, so tests measure the app, not the Vite dev server.
//
//   node e2e/serve-ssr.mjs [--port 5180]     (or E2E_PORT)
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const OUTPUT = join(root, ".output");
const PUBLIC = join(OUTPUT, "public");
const ENTRY = join(OUTPUT, "server/index.mjs");

const portArg = process.argv.indexOf("--port");
const port = Number(portArg > 0 ? process.argv[portArg + 1] : (process.env["E2E_PORT"] ?? 5180));
if (!existsSync(ENTRY)) {
  console.error(`Missing the SSR build (${ENTRY}). Run \`bun run build\` first.`);
  process.exit(1);
}

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".pbf": "application/x-protobuf",
  ".txt": "text/plain; charset=utf-8",
};

/** The Cloudflare ASSETS binding, reduced to what the worker calls: fetch(request). */
const ASSETS = {
  async fetch(request) {
    const { pathname } = new URL(request.url);
    const file = normalize(join(PUBLIC, decodeURIComponent(pathname)));
    if (!file.startsWith(PUBLIC + sep) || !existsSync(file) || !statSync(file).isFile()) {
      return new Response("Not found", { status: 404 });
    }
    const headers = { "content-type": TYPES[extname(file)] ?? "application/octet-stream" };
    if (pathname.startsWith("/assets/"))
      headers["cache-control"] = "public, max-age=31536000, immutable";
    return new Response(Readable.toWeb(createReadStream(file)), { headers });
  },
};

const worker = (await import(pathToFileURL(ENTRY).href)).default;
const env = { ASSETS };

const server = createServer(async (req, res) => {
  try {
    const url = `http://${req.headers.host ?? `127.0.0.1:${port}`}${req.url}`;
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const request = new Request(url, {
      method: req.method,
      headers: req.headers,
      ...(hasBody ? { body: Readable.toWeb(req), duplex: "half" } : {}),
    });
    const pending = [];
    const context = { waitUntil: (p) => pending.push(p), passThroughOnException() {} };
    const response = await worker.fetch(request, env, context);
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body && req.method !== "HEAD") {
      for await (const chunk of response.body) res.write(chunk);
    }
    res.end();
    await Promise.allSettled(pending);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal error");
  }
});
server.listen(port, "127.0.0.1", () => {
  console.log(`SSR build at http://127.0.0.1:${port}/`);
});
