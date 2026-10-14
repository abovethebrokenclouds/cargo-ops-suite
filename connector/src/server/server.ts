// HTTP + WebSocket server on 127.0.0.1 (plan §3, §3.2), plus the LAN opt-in (lan.ts).
//
//   GET  /api/health   no token: { ok, version, mode, sim, basemap: { local } }
//   GET  /api/session  same-origin only: { token, wsUrl, scope } for the web app. The main
//                      token goes to loopback clients only; a LAN client gets 403
//                      pairing_required, or its own LAN token back when it sends a valid one
//   POST /api/lan/pair LAN on only, no token: { code, name } → { token, wsUrl, device }
//   *    /api/*        Authorization: Bearer <token> (main token from loopback, or a LAN token)
//   *    /api/lan…     LAN status, pairing code, devices, setting: this PC only (main token)
//   GET  /ws           WebSocket; allowed Origin AND token (query `token` or first `hello`)
//   GET  /tiles/<name>.pmtiles  local basemap with byte ranges (see tiles.ts)
//   GET  /*            static SPA build with fallback to the shell

import {
  createServer,
  type IncomingMessage,
  type RequestListener,
  type Server,
  type ServerResponse,
} from "node:http";
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
import type { LanSetting } from "../core/config";
import {
  PAIRING_CODE_TTL_MS,
  boundLanAddresses,
  formatPairingCode,
  isLocalOnlyRoute,
  isLoopbackAddress,
  lanInterfaceAddresses,
  validateLanBind,
  type LanAccess,
  type LanDevice,
} from "./lan";
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
/** Largest unauthenticated pairing request body, bytes. */
const MAX_PAIR_BODY_BYTES = 4 * 1024;
/** How often a failed Host check may re-read the interface list (DHCP changes), ms. */
const INTERFACE_REFRESH_MS = 5_000;

/** Who a request or socket acts for: this PC (main token) or a paired LAN device. */
export type AuthScope = { scope: "local" } | { scope: "lan"; device: LanDevice };

/** LAN opt-in wiring (see lan.ts). */
export interface LanServerOptions {
  access: LanAccess;
  /** Listen address when LAN is on ("0.0.0.0" or one interface IPv4); null = LAN off. */
  bind: string | null;
  /** Non-loopback IPv4 addresses of this PC (default: os.networkInterfaces()). */
  interfaces?: () => string[];
  /** Persisted setting (next start) and its setter, for /api/lan/settings. */
  setting?: () => LanSetting | null;
  saveSetting?: (setting: LanSetting) => void;
}

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
  routes?: (req: ApiRequest) => ApiResult | null | Promise<ApiResult | null>;
  /** LAN opt-in; absent = loopback only, no pairing. */
  lan?: LanServerOptions;
  /**
   * Whether a remote address is this PC. Default: loopback. Tests inject `() => false` to
   * play a LAN client over 127.0.0.1.
   */
  isLocalAddress?: (address: string | undefined) => boolean;
}

interface Client {
  ws: WebSocket;
  id: number;
  authed: boolean;
  /** Remote address is this PC (the main token is only accepted then). */
  local: boolean;
  /** Paired LAN device this socket authenticated as. */
  deviceId?: string;
  lastPongAt: number;
  rttMs?: number;
}

export interface RunningServer {
  port: number;
  url: string;
  /** LAN URLs (http://<address>:<port>/) when LAN is on; empty otherwise. */
  lanUrls(): string[];
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
  const lan = options.lan;
  const lanBind = lan?.bind ?? null;
  const interfaces = lan?.interfaces ?? (() => lanInterfaceAddresses());
  const isLocalAddress = options.isLocalAddress ?? isLoopbackAddress;
  if (lanBind !== null) {
    const problem = validateLanBind(lanBind, interfaces());
    if (problem) throw new Error(problem);
  }
  let listenPort = options.port ?? DEFAULT_PORT;
  let lanAddresses: string[] = lanBind === null ? [] : boundLanAddresses(lanBind, interfaces());
  let policy: OriginPolicy = buildOriginPolicy(listenPort, options.devOrigins, lanAddresses);
  let lastInterfaceRefresh = Date.now();
  const webDir = webRootUsable(options.webDir) ? options.webDir : undefined;
  if (options.webDir && !webDir) {
    log("warn", `No web build found in ${options.webDir}; only the API is served`);
  }

  /** Host check; with LAN on 0.0.0.0, re-read the interfaces now and then (DHCP renewals). */
  const hostAllowed = (host: string | undefined): boolean => {
    if (isAllowedHost(policy, host)) return true;
    if (lanBind !== "0.0.0.0" || Date.now() - lastInterfaceRefresh < INTERFACE_REFRESH_MS) {
      return false;
    }
    lastInterfaceRefresh = Date.now();
    lanAddresses = boundLanAddresses(lanBind, interfaces());
    policy = buildOriginPolicy(listenPort, options.devOrigins, lanAddresses);
    return isAllowedHost(policy, host);
  };

  /** Main token from this PC, or a paired LAN device's token (LAN on only). */
  const authenticate = (given: string | undefined | null, local: boolean): AuthScope | null => {
    if (local && tokensEqual(token, given)) return { scope: "local" };
    if (lan && lanBind !== null) {
      const device = lan.access.verify(given);
      if (device) return { scope: "lan", device };
    }
    return null;
  };

  const lanUrls = () => lanAddresses.map((a) => `http://${a}:${listenPort}/`);

  const health = () => ({
    ok: true,
    version: options.version,
    mode: session.source.mode,
    sim: session.welcome().sim,
    basemap: { local: hasLocalBasemap(options.basemapDir) },
  });

  const handler: RequestListener = (req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    if (!hostAllowed(req.headers.host)) {
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
  };

  async function handleApi(
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<void> {
    const origin = req.headers.origin;
    const remote = req.socket.remoteAddress ?? "";
    const local = isLocalAddress(remote);
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
      if (local) {
        json(res, 200, { token, wsUrl: "/ws", scope: "local" });
        return;
      }
      // A LAN client never receives the main token. A paired device gets its own back.
      const given = bearerToken(req.headers.authorization);
      const auth = given ? authenticate(given, false) : null;
      if (auth?.scope === "lan") {
        json(res, 200, { token: given, wsUrl: "/ws", scope: "lan", device: auth.device });
        return;
      }
      json(res, 403, {
        error: "pairing_required",
        message: "Pair this device: open Settings on the PC running Cargo Ops and use the code.",
      });
      return;
    }
    if (pathname === "/api/lan/pair") {
      await handlePair(req, res, remote);
      return;
    }
    if (!isAllowedOptionalOrigin(policy, origin)) {
      json(res, 403, { error: "forbidden_origin" });
      return;
    }
    const auth = authenticate(bearerToken(req.headers.authorization), local);
    if (!auth) {
      res.setHeader("WWW-Authenticate", "Bearer");
      json(res, 401, { error: "unauthorized" });
      return;
    }
    const method = req.method ?? "GET";
    if (auth.scope === "lan" && isLocalOnlyRoute(method, pathname)) {
      json(res, 403, {
        error: "local_only",
        message:
          "Career import, backups, deleting data and LAN settings are only available on the PC running Cargo Ops.",
      });
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
    if (pathname === "/api/lan" || pathname.startsWith("/api/lan/")) {
      const r = lanRoute(method, pathname, body);
      json(res, r.status, r.body);
      return;
    }
    if (!options.routes) {
      json(res, 404, { error: "not_found" });
      return;
    }
    const query = new URL(req.url ?? "/", "http://connector.invalid").searchParams;
    const routed = await options.routes({ method, pathname, query, body });
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

  // ---- LAN pairing and management ----

  async function handlePair(
    req: IncomingMessage,
    res: ServerResponse,
    remote: string,
  ): Promise<void> {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      json(res, 405, { error: "method_not_allowed" });
      return;
    }
    // A pairing code only travels from a page this connector served (never a foreign site).
    if (!isAllowedRequiredOrigin(policy, req.headers.origin)) {
      json(res, 403, { error: "forbidden_origin" });
      return;
    }
    if (!lan || lanBind === null) {
      json(res, 404, { error: "lan_off", message: "LAN access is off on this connector." });
      return;
    }
    const read = await readBody(req, MAX_PAIR_BODY_BYTES);
    if (read === null) {
      json(res, 413, { error: "payload_too_large" });
      return;
    }
    let body: { code?: unknown; name?: unknown } | null = null;
    try {
      body = read ? (JSON.parse(read) as typeof body) : {};
    } catch {
      json(res, 400, { error: "invalid_json" });
      return;
    }
    const r = lan.access.pair(body?.code, body?.name, remote);
    if (!r.ok) {
      log("warn", `LAN pairing refused for ${remote}: ${r.code}`);
      if (r.retryAfterSec !== undefined) res.setHeader("Retry-After", String(r.retryAfterSec));
      json(res, r.status, {
        error: r.code,
        message: r.message,
        ...(r.retryAfterSec !== undefined ? { retryAfterSec: r.retryAfterSec } : {}),
      });
      return;
    }
    log("info", `LAN device paired: "${r.device.name}" from ${r.device.pairedFrom}`);
    json(res, 200, { token: r.token, wsUrl: "/ws", scope: "lan", device: r.device });
  }

  function lanView() {
    const code = lan?.access.currentCode() ?? null;
    const setting = lan?.setting?.() ?? null;
    const active = lanBind !== null;
    const urls = lanUrls();
    return {
      active,
      bind: lanBind,
      port: listenPort,
      urls,
      interfaces: interfaces(),
      setting,
      // The persisted choice differs from what this process is doing: restart to apply.
      restartRequired:
        setting !== null &&
        (setting.enabled !== active || (setting.enabled && setting.address !== lanBind)),
      code: code
        ? {
            code: code.code,
            display: formatPairingCode(code.code),
            expiresAt: code.expiresAt,
            ttlSec: PAIRING_CODE_TTL_MS / 1000,
            pairUrls: urls.map((u) => `${u}settings#pair=${code.code}`),
          }
        : null,
      devices: lan?.access.devices() ?? [],
    };
  }

  function lanRoute(
    method: string,
    pathname: string,
    body: unknown,
  ): { status: number; body: unknown } {
    if (!lan) return { status: 404, body: { error: "not_found" } };
    const notAllowed = { status: 405, body: { error: "method_not_allowed" } };
    if (pathname === "/api/lan") {
      return method === "GET" ? { status: 200, body: lanView() } : notAllowed;
    }
    if (pathname === "/api/lan/code") {
      if (method === "POST") {
        if (lanBind === null) {
          return {
            status: 409,
            body: {
              error: "lan_off",
              message: "Turn LAN access on and restart the connector first.",
            },
          };
        }
        lan.access.createCode();
        log("info", "LAN pairing code generated (valid 5 min)");
        return { status: 201, body: lanView() };
      }
      if (method === "DELETE") {
        lan.access.cancelCode();
        return { status: 200, body: lanView() };
      }
      return notAllowed;
    }
    if (pathname === "/api/lan/settings") {
      if (method !== "PUT") return notAllowed;
      const b = (body ?? {}) as { enabled?: unknown; address?: unknown };
      if (typeof b.enabled !== "boolean") {
        return {
          status: 400,
          body: { error: "bad_request", message: "enabled must be true or false" },
        };
      }
      const address = b.address === undefined || b.address === null ? "0.0.0.0" : b.address;
      if (typeof address !== "string") {
        return { status: 400, body: { error: "bad_request", message: "address must be a string" } };
      }
      const problem = b.enabled ? validateLanBind(address, interfaces()) : null;
      if (problem) return { status: 400, body: { error: "bad_address", message: problem } };
      if (!lan.saveSetting) {
        return { status: 501, body: { error: "not_implemented", message: "No config to save" } };
      }
      lan.saveSetting({ enabled: b.enabled, address });
      log(
        "info",
        `LAN access ${b.enabled ? `on (${address})` : "off"} saved; applies after a restart`,
      );
      return { status: 200, body: lanView() };
    }
    const device = /^\/api\/lan\/devices\/([^/]+)$/.exec(pathname);
    if (device) {
      if (method !== "DELETE") return notAllowed;
      let id: string;
      try {
        id = decodeURIComponent(device[1] as string);
      } catch {
        return { status: 400, body: { error: "bad_request" } };
      }
      if (!lan.access.revoke(id)) return { status: 404, body: { error: "unknown_device" } };
      log("info", `LAN device ${id} revoked`);
      return { status: 200, body: lanView() };
    }
    return { status: 404, body: { error: "not_found" } };
  }

  // ---- WebSocket ----

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

  const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
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
    if (!hostAllowed(req.headers.host)) {
      rejectUpgrade(socket, 421, "Misdirected Request");
      return;
    }
    if (!isAllowedRequiredOrigin(policy, req.headers.origin)) {
      log("warn", `Refused WebSocket from origin ${req.headers.origin ?? "(none)"}`);
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    const local = isLocalAddress(req.socket.remoteAddress);
    const queryToken = url.searchParams.get("token");
    if (queryToken !== null && !authenticate(queryToken, local)) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, local));
  };

  function send(client: Client, msg: ServerMessage): void {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(encode(msg));
  }

  function welcomeAndSnapshot(client: Client): void {
    send(client, session.welcome());
    send(client, session.store.snapshot());
  }

  function onConnection(ws: WebSocket, local: boolean): void {
    const client: Client = {
      ws,
      id: nextClientId++,
      authed: false,
      local,
      lastPongAt: Date.now(),
    };
    clients.add(client);
    log("info", `Client ${client.id} connected (${clients.size} open)`);
    const helloTimer = setTimeout(() => {
      if (!client.authed) ws.close(CLOSE.helloTimeout, "hello timeout");
    }, HELLO_TIMEOUT_MS);

    /** The hello token must authenticate, and a repeated hello must be the same identity. */
    const checkHello = (given: string): boolean => {
      const auth = authenticate(given, client.local);
      if (!auth) return false;
      const deviceId = auth.scope === "lan" ? auth.device.id : undefined;
      if (client.authed && deviceId !== client.deviceId) return false;
      if (deviceId !== undefined) client.deviceId = deviceId;
      return true;
    };

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
        if (msg.type !== "hello" || !checkHello(msg.token)) {
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
          if (!checkHello(msg.token)) {
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

  // A revoked device loses its open sockets at once.
  const unsubscribeRevoke =
    lan?.access.onRevoke((id) => {
      for (const client of clients) {
        if (client.deviceId === id) client.ws.close(CLOSE.unauthorized, "device revoked");
      }
    }) ?? (() => {});

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

  // Listeners: 127.0.0.1 always. With LAN on, either 0.0.0.0 (which includes loopback) or
  // 127.0.0.1 plus the one chosen interface address, on the same port.
  const servers: Server[] = [];
  const listen = (host: string, port: number): Promise<Server> => {
    const server = createServer(handler);
    server.on("upgrade", onUpgrade);
    return new Promise<Server>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.off("error", reject);
        servers.push(server);
        resolve(server);
      });
    });
  };
  const closeServers = async () => {
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            server.close(() => resolve());
            server.closeAllConnections();
          }),
      ),
    );
  };
  try {
    const first = await listen(lanBind === "0.0.0.0" ? lanBind : HOST, listenPort);
    const address = first.address();
    listenPort = typeof address === "object" && address ? address.port : listenPort;
    if (lanBind !== null && lanBind !== "0.0.0.0") await listen(lanBind, listenPort);
  } catch (err) {
    clearInterval(pingTimer);
    unsubscribeRevoke();
    unsubscribeStore();
    unsubscribeLink();
    await closeServers();
    throw err;
  }
  lanAddresses = lanBind === null ? [] : boundLanAddresses(lanBind, interfaces());
  policy = buildOriginPolicy(listenPort, options.devOrigins, lanAddresses);
  if (lanBind !== null) {
    log("warn", `LAN access is ON (${lanBind}): ${lanUrls().join(" ") || "no LAN address found"}`);
  }

  return {
    port: listenPort,
    url: `http://${HOST}:${listenPort}`,
    lanUrls,
    clients: () => clients.size,
    close: async () => {
      clearInterval(pingTimer);
      unsubscribeRevoke();
      unsubscribeStore();
      unsubscribeLink();
      for (const client of clients) client.ws.close(CLOSE.shuttingDown, "connector stopping");
      wss.close();
      await closeServers();
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
