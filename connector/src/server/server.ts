// HTTP + WebSocket server on 127.0.0.1 (plan §3, §3.2).
//
//   GET  /api/health   no token: { ok, version, mode, sim, basemap: { local } }
//   GET  /api/session  same-origin only: { token, wsUrl } for the web app
//   *    /api/*        Authorization: Bearer <token>
//   GET  /ws           WebSocket; allowed Origin AND token (query `token` or first `hello`)
//   GET  /tiles/<name>.pmtiles  local basemap with byte ranges (see tiles.ts)
//   GET  /*            static SPA build with fallback to the shell

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket, type RawData } from "ws";
import {
  PROTOCOL_VERSION,
  encode,
  parseClientMessage,
  type Command,
  type ServerMessage,
} from "../protocol";
import type { ConnectorSession } from "../core/session";
import type { LogFn } from "../sim/source";
import {
  SECURITY_HEADERS,
  bearerToken,
  buildOriginPolicy,
  isAllowedHost,
  isAllowedOptionalOrigin,
  isAllowedRequiredOrigin,
  tokensEqual,
  type OriginPolicy,
} from "./security";
import { sendText, serveStatic, webRootUsable } from "./static";
import { TILES_PREFIX, hasLocalBasemap, serveTiles } from "./tiles";

export const DEFAULT_PORT = 4311;
export const HOST = "127.0.0.1";
export const PING_INTERVAL_MS = 15_000;
const HELLO_TIMEOUT_MS = 5_000;
const MAX_MESSAGE_BYTES = 64 * 1024;
/** Largest accepted /api request body (career import), bytes. */
export const MAX_API_BODY_BYTES = 32 * 1024 * 1024;

/** An authenticated /api request as the route handlers see it. */
export interface ApiRequest {
  method: string;
  pathname: string;
  query: URLSearchParams;
  /** Parsed JSON body (POST/PUT/PATCH); undefined without one. */
  body: unknown;
}

/** JSON response, or a text download (CSV, GPX, …). */
export type ApiResult =
  | { status: number; body: unknown }
  | { status: number; text: string; contentType: string; filename?: string };

/** WebSocket close codes used by the connector (4000-4999 are application codes). */
export const CLOSE = {
  badMessage: 4400,
  unauthorized: 4401,
  helloTimeout: 4408,
  shuttingDown: 1001,
} as const;

export interface ServerOptions {
  session: ConnectorSession;
  token: string;
  version: string;
  port?: number;
  webDir?: string;
  /** Folder holding basemap.pmtiles (and other archives) served under /tiles/. */
  basemapDir?: string;
  devOrigins?: string[];
  pingIntervalMs?: number;
  log: LogFn;
  /** Extra fields for the authenticated /api/status response. */
  status?: () => Record<string, unknown>;
  /** Extra authenticated /api routes (flights, jobs, exports …); null = not handled here. */
  routes?: (req: ApiRequest) => ApiResult | null;
}

interface Client {
  ws: WebSocket;
  id: number;
  authed: boolean;
  lastPongAt: number;
  rttMs?: number;
}

export interface RunningServer {
  port: number;
  url: string;
  clients(): number;
  close(): Promise<void>;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`,
  );
  socket.destroy();
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const { session, token, log } = options;
  const clients = new Set<Client>();
  let nextClientId = 1;
  let policy: OriginPolicy = buildOriginPolicy(options.port ?? DEFAULT_PORT, options.devOrigins);
  const webDir = webRootUsable(options.webDir) ? options.webDir : undefined;
  if (options.webDir && !webDir) {
    log("warn", `No web build found in ${options.webDir}; only the API is served`);
  }

  const health = () => ({
    ok: true,
    version: options.version,
    mode: session.source.mode,
    sim: session.welcome().sim,
    basemap: { local: hasLocalBasemap(options.basemapDir) },
  });

  const server: Server = createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (!isAllowedHost(policy, req.headers.host)) {
      sendText(res, 421, "Misdirected request");
      return;
    }
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://connector.invalid").pathname;
    } catch {
      sendText(res, 400, "Bad request");
      return;
    }
    if (pathname === "/api" || pathname.startsWith("/api/")) {
      handleApi(req, res, pathname).catch((err: unknown) => {
        log("warn", `API ${pathname} failed: ${err instanceof Error ? err.message : err}`);
        if (!res.headersSent) json(res, 500, { error: "internal_error" });
      });
      return;
    }
    if (pathname.startsWith(TILES_PREFIX)) {
      serveTiles(options.basemapDir, req, res, pathname);
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendText(res, 405, "Method not allowed");
      return;
    }
    if (!webDir) {
      sendText(
        res,
        404,
        "Cargo Ops connector is running, but no web build was found. Run `bun run build:local` and start with --web dist/client.",
      );
      return;
    }
    serveStatic(webDir, req, res, pathname);
  });

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const origin = req.headers.origin;
    if (pathname === "/api/health" && req.method === "GET") {
      json(res, 200, health());
      return;
    }
    if (pathname === "/api/session" && req.method === "GET") {
      // Same-origin only: the token goes to pages served by this connector (or the dev origin).
      if (!isAllowedOptionalOrigin(policy, origin)) {
        log("warn", `Refused /api/session for origin ${origin}`);
        json(res, 403, { error: "forbidden_origin" });
        return;
      }
      json(res, 200, { token, wsUrl: "/ws" });
      return;
    }
    if (!isAllowedOptionalOrigin(policy, origin)) {
      json(res, 403, { error: "forbidden_origin" });
      return;
    }
    if (!tokensEqual(token, bearerToken(req.headers.authorization))) {
      res.setHeader("WWW-Authenticate", "Bearer");
      json(res, 401, { error: "unauthorized" });
      return;
    }
    if (pathname === "/api/status" && req.method === "GET") {
      json(res, 200, {
        ...health(),
        session: session.id,
        seq: session.store.currentSeq,
        clients: clients.size,
        ...(options.status?.() ?? {}),
      });
      return;
    }
    if (!options.routes) {
      json(res, 404, { error: "not_found" });
      return;
    }
    const method = req.method ?? "GET";
    let body: unknown = undefined;
    if (method === "POST" || method === "PUT" || method === "PATCH") {
      const read = await readBody(req, MAX_API_BODY_BYTES);
      if (read === null) {
        json(res, 413, { error: "payload_too_large" });
        return;
      }
      if (read.length > 0) {
        try {
          body = JSON.parse(read);
        } catch {
          json(res, 400, { error: "invalid_json" });
          return;
        }
      }
    }
    const query = new URL(req.url ?? "/", "http://connector.invalid").searchParams;
    const routed = options.routes({ method, pathname, query, body });
    if (!routed) {
      json(res, 404, { error: "not_found" });
      return;
    }
    if ("text" in routed) {
      res.statusCode = routed.status;
      res.setHeader("Content-Type", routed.contentType);
      res.setHeader("Cache-Control", "no-store");
      if (routed.filename) {
        res.setHeader("Content-Disposition", `attachment; filename="${routed.filename}"`);
      }
      res.end(routed.text);
      return;
    }
    json(res, routed.status, routed.body);
  }

  // ---- WebSocket ----

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  server.on("upgrade", (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? "/", "http://connector.invalid");
    } catch {
      rejectUpgrade(socket, 400, "Bad Request");
      return;
    }
    if (url.pathname !== "/ws") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }
    if (!isAllowedHost(policy, req.headers.host)) {
      rejectUpgrade(socket, 421, "Misdirected Request");
      return;
    }
    if (!isAllowedRequiredOrigin(policy, req.headers.origin)) {
      log("warn", `Refused WebSocket from origin ${req.headers.origin ?? "(none)"}`);
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const queryToken = url.searchParams.get("token");
    if (queryToken !== null && !tokensEqual(token, queryToken)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function send(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(encode(msg));
  }

  function welcomeAndSnapshot(client: Client): void {
    send(client, session.welcome());
    send(client, session.store.snapshot());
  }

  function onConnection(ws: WebSocket): void {
    const client: Client = { ws, id: nextClientId++, authed: false, lastPongAt: Date.now() };
    clients.add(client);
    log("info", `Client ${client.id} connected (${clients.size} open)`);
    const helloTimer = setTimeout(() => {
      if (!client.authed) ws.close(CLOSE.helloTimeout, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    ws.on("message", (data: RawData, isBinary: boolean) => {
      if (isBinary) {
        ws.close(CLOSE.badMessage, "binary frames are not supported");
        return;
      }
      const parsed = parseClientMessage(rawToString(data));
      if (!parsed.ok) {
        log("warn", `Client ${client.id} sent an invalid message: ${parsed.error}`);
        if (!client.authed) ws.close(CLOSE.badMessage, "invalid message");
        return;
      }
      const msg = parsed.msg;
      if (!client.authed) {
        // The first message must be a hello carrying the token (also when the
        // query token was already checked, so the session starts the same way).
        if (msg.type !== "hello" || !tokensEqual(token, msg.token)) {
          log("warn", `Client ${client.id} failed authentication`);
          ws.close(CLOSE.unauthorized, "unauthorized");
          return;
        }
        client.authed = true;
        clearTimeout(helloTimer);
        welcomeAndSnapshot(client);
        return;
      }
      switch (msg.type) {
        case "hello":
          // A repeated hello restarts the session view for this client.
          if (!tokensEqual(token, msg.token)) {
            ws.close(CLOSE.unauthorized, "unauthorized");
            return;
          }
          welcomeAndSnapshot(client);
          return;
        case "resync":
          send(client, session.store.snapshot());
          return;
        case "ping":
          send(client, { type: "pong", v: PROTOCOL_VERSION, t: msg.t });
          return;
        case "pong":
          client.lastPongAt = Date.now();
          client.rttMs = Math.max(0, Date.now() - msg.t);
          return;
        case "command":
          send(client, session.command(msg));
          return;
      }
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      clients.delete(client);
      log("info", `Client ${client.id} disconnected (${clients.size} open)`);
    });
    ws.on("error", (err) => log("warn", `Client ${client.id} socket error: ${err.message}`));
  }

  // Broadcast every store frame to authenticated clients.
  const unsubscribeStore = session.store.subscribe((frame) => {
    const text = encode(frame);
    for (const client of clients) {
      if (client.authed && client.ws.readyState === client.ws.OPEN) client.ws.send(text);
    }
  });
  // Simulator link changed: give every client a fresh welcome + snapshot.
  const unsubscribeLink = session.onLinkChange(() => {
    for (const client of clients) if (client.authed) welcomeAndSnapshot(client);
  });

  const pingMs = options.pingIntervalMs ?? PING_INTERVAL_MS;
  const pingTimer = setInterval(() => {
    const now = Date.now();
    for (const client of clients) {
      if (!client.authed) continue;
      if (now - client.lastPongAt > pingMs * 3) {
        log("warn", `Client ${client.id} stopped answering pings; closing`);
        client.ws.terminate();
        continue;
      }
      send(client, { type: "ping", v: PROTOCOL_VERSION, t: now });
    }
  }, pingMs);
  pingTimer.unref();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? DEFAULT_PORT, HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : (options.port ?? 0);
  policy = buildOriginPolicy(port, options.devOrigins);

  return {
    port,
    url: `http://${HOST}:${port}`,
    clients: () => clients.size,
    close: async () => {
      clearInterval(pingTimer);
      unsubscribeStore();
      unsubscribeLink();
      for (const client of clients) client.ws.close(CLOSE.shuttingDown, "connector stopping");
      wss.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}

/** Read a request body as UTF-8, or null when it exceeds `limit` bytes. */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(tooLarge ? null : Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function rawToString(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

/** Honest refusal for a command this connector does not implement. */
export function commandResult(cmd: Command): ServerMessage {
  return {
    type: "result",
    v: PROTOCOL_VERSION,
    id: cmd.id,
    ok: false,
    error: {
      code: "not_implemented",
      message: `Command ${cmd.name} is not implemented in this connector version`,
    },
  };
}
