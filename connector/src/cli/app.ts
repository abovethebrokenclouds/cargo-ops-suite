// Composes the connector: data dir → config/token → storage → sim source →
// session/store → recorder → HTTP/WS server. Used by main.ts and the tests.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadOrCreateConfig } from "../core/config";
import { createLogger } from "../core/logger";
import { Recorder } from "../core/recorder";
import { ConnectorSession } from "../core/session";
import { FakeSource } from "../sim/fake-source";
import { SimConnectSource } from "../sim/simconnect-source";
import type { LogFn, SimSource } from "../sim/source";
import { unverifiedSimVars } from "../sim/simvars";
import { normalizeOrigin } from "../server/security";
import { startServer, type RunningServer } from "../server/server";
import { openStorage, type Storage } from "../storage/db";
import { FlightRepo, flightsApi } from "../storage/flights";

/** connector/ (the folder holding package.json), found from the compiled file location. */
export function connectorRoot(start: string = __dirname): string {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      try {
        const name = (JSON.parse(readFileSync(pkg, "utf8")) as { name?: string }).name;
        if (name === "cargo-ops-connector") return dir;
      } catch {
        // keep looking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return resolve(start, "../../../..");
}

export function connectorVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(connectorRoot(), "package.json"), "utf8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface ConnectorOptions {
  sim: "simconnect" | "fake";
  dataDir: string;
  port: number;
  fixture?: string;
  speed?: number;
  loop?: boolean;
  record?: string;
  web?: string;
  /** Local basemap folder (default <dataDir>/basemap). */
  basemapDir?: string;
  devOrigins?: string[];
  resetToken?: boolean;
  verbose?: boolean;
  quiet?: boolean;
  pingIntervalMs?: number;
  /** Inject a source (tests). */
  source?: SimSource;
}

export interface RunningConnector {
  server: RunningServer;
  session: ConnectorSession;
  storage: Storage;
  flights: FlightRepo;
  token: string;
  logFile: string | null;
  log: LogFn;
  recorder: Recorder | null;
  stop(): Promise<void>;
}

export async function startConnector(options: ConnectorOptions): Promise<RunningConnector> {
  const logger = createLogger({
    dataDir: options.dataDir,
    level: options.verbose ? "debug" : "info",
    ...(options.quiet ? { quiet: true } : {}),
  });
  const log = logger.log;
  const version = connectorVersion();
  log("info", `Cargo Ops connector ${version} on Node ${process.versions.node}`);
  log("info", `Data directory: ${options.dataDir}`);

  const devOrigins = (options.devOrigins ?? []).map(normalizeOrigin);
  const { config, created } = loadOrCreateConfig(options.dataDir, {
    ...(options.resetToken ? { resetToken: true } : {}),
  });
  if (created) log("info", "Generated a new access token (config.json)");

  const source: SimSource =
    options.source ??
    (options.sim === "fake"
      ? new FakeSource({
          fixturePath: options.fixture ?? join(connectorRoot(), "fixtures", "demo-kmem-katl.jsonl"),
          speed: options.speed ?? 1,
          loop: options.loop ?? false,
          log,
        })
      : new SimConnectSource({ log }));
  if (source.mode === "live") {
    log("info", `SimVars still unverified on a real sim: ${unverifiedSimVars().join(", ")}`);
  }

  // Demo/replay never touch the career database (plan §3.2).
  const storage = openStorage(options.dataDir, source.mode === "live" ? "live" : "demo");
  log("info", `Database: ${storage.path} (schema v${storage.schemaVersion()})`);

  // Flights and telemetry go to the database of this mode (demo.db for replays).
  const flights = new FlightRepo(storage, source.frameSource);
  const session = new ConnectorSession(source, log, { repo: flights });
  const recorder = options.record ? new Recorder(resolve(options.record), session.store) : null;
  if (recorder) log("info", `Recording frames to ${recorder.path}`);

  let server: RunningServer;
  try {
    server = await startServer({
      session,
      token: config.token,
      version,
      port: options.port,
      ...(options.web ? { webDir: resolve(options.web) } : {}),
      basemapDir: resolve(options.basemapDir ?? join(options.dataDir, "basemap")),
      devOrigins,
      ...(options.pingIntervalMs ? { pingIntervalMs: options.pingIntervalMs } : {}),
      log,
      routes: flightsApi(flights),
      status: () => ({
        dataDir: options.dataDir,
        database: storage.path,
        recording: recorder?.path ?? null,
        recordedLines: recorder?.lines ?? 0,
        store: session.store.stats(),
      }),
    });
  } catch (err) {
    recorder?.close();
    storage.close();
    throw err;
  }
  session.start();
  log("info", `Listening on ${server.url} (mode ${source.mode})`);

  return {
    server,
    session,
    storage,
    flights,
    token: config.token,
    logFile: logger.file,
    log,
    recorder,
    stop: async () => {
      await server.close();
      await session.stop();
      recorder?.close();
      storage.close();
      log("info", "Connector stopped");
    },
  };
}
