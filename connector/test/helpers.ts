import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  parseServerMessage,
  type FixtureFrame,
  type ServerMessage,
} from "../src/protocol";

export function tempDir(prefix = "cargo-ops-test-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A short synthetic fixture: snapshot, deltas every 50 ms, one event. Source "demo" on purpose. */
export function shortFixture(): FixtureFrame[] {
  const frames: FixtureFrame[] = [
    {
      t: 0,
      msg: {
        type: "snapshot",
        v: PROTOCOL_VERSION,
        seq: 0,
        source: "demo",
        state: {
          sim: { connected: false, paused: false, simRate: 1 },
          aircraft: { title: "Test Caravan", atcId: "N1TEST" },
          position: { lat: 35, lon: -90, altFt: 300, aglFt: 0 },
          motion: {
            iasKt: 0,
            tasKt: 0,
            gsKt: 0,
            hdgMagDeg: 90,
            hdgTrueDeg: 91,
            vsFpm: 0,
            gForce: 1,
            onGround: true,
          },
        },
      },
    },
  ];
  for (let i = 1; i <= 6; i++) {
    frames.push({
      t: i * 50,
      msg: {
        type: "delta",
        v: PROTOCOL_VERSION,
        seq: i,
        source: "demo",
        patch: { motion: { gsKt: i * 5 }, position: { lat: 35 + i * 0.001 } },
      },
    });
  }
  frames.push({
    t: 400,
    msg: {
      type: "event",
      v: PROTOCOL_VERSION,
      seq: 7,
      source: "demo",
      name: "flight.started",
      data: { origin: "KMEM" },
    },
  });
  return frames;
}

export interface TestClient {
  ws: WebSocket;
  messages: ServerMessage[];
  next(predicate?: (msg: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  closed: Promise<{ code: number; reason: string }>;
  send(value: unknown): void;
}

export function connectClient(url: string, origin?: string): Promise<TestClient> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    const messages: ServerMessage[] = [];
    let cursor = 0;
    const waiters: (() => void)[] = [];
    const closed = new Promise<{ code: number; reason: string }>((res) => {
      ws.on("close", (code, reason) => res({ code, reason: reason.toString() }));
    });
    ws.on("message", (data) => {
      const parsed = parseServerMessage(data.toString());
      if (!parsed.ok) throw new Error(`server sent an invalid message: ${parsed.error}`);
      messages.push(parsed.msg);
      for (const w of waiters.splice(0)) w();
    });
    const client: TestClient = {
      ws,
      messages,
      closed,
      send: (value) => ws.send(typeof value === "string" ? value : JSON.stringify(value)),
      next(predicate = () => true, timeoutMs = 3000) {
        return new Promise((res, rej) => {
          const timer = setTimeout(
            () => rej(new Error("timed out waiting for a message")),
            timeoutMs,
          );
          const check = () => {
            while (cursor < messages.length) {
              const msg = messages[cursor++] as ServerMessage;
              if (predicate(msg)) {
                clearTimeout(timer);
                res(msg);
                return;
              }
            }
            waiters.push(check);
          };
          check();
        });
      },
    };
    ws.once("open", () => resolve(client));
    ws.once("error", reject);
  });
}

/** Attempt an upgrade and report the HTTP status of a refusal (or 101). */
export function upgradeStatus(url: string, origin?: string): Promise<number> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, origin ? { origin } : {});
    ws.on("unexpected-response", (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      resolve(101);
      ws.close();
    });
    ws.on("error", () => resolve(-1));
  });
}

export interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

/** Raw HTTP GET that sends the path exactly as given (no client-side normalisation). */
export function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method: "GET",
        headers: { Host: `127.0.0.1:${port}`, ...headers },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

export function hello(token: string): Record<string, unknown> {
  return { type: "hello", v: PROTOCOL_VERSION, token, client: "web", wants: ["telemetry"] };
}
