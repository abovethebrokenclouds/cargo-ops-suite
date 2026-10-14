// Composes the connector: data dir → config/token → storage → sim source →
// session/store → recorder → HTTP/WS server. Used by main.ts and the tests.

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { loadOrCreateConfig, saveLanSetting } from "../core/config";
import { createLogger } from "../core/logger";
import { Recorder } from "../core/recorder";
import { ConnectorSession } from "../core/session";
import { FakeSource } from "../sim/fake-source";
import { SimConnectSource } from "../sim/simconnect-source";
import type { LogFn, SimSource } from "../sim/source";
import { unverifiedSimVars } from "../sim/simvars";
import { normalizeOrigin } from "../server/security";
import { LanAccess, clearLanDevices } from "../server/lan";
import { startServer, type RunningServer } from "../server/server";
import { openStorage, type Storage } from "../storage/db";
import { FlightRepo, flightsApi } from "../storage/flights";
import { EconomyRepo } from "../storage/economy";
import { economyApi } from "../server/economy-api";
import { loadAirportsData } from "../core/economy/airports-data";
import { SimbriefService } from "../core/simbrief";
import { dataApi } from "../server/data-api";
import { WeatherService } from "../core/weather";
import { weatherApi } from "../server/weather-api";
import type { WeatherMode } from "../weather";
import { BACKUP_CHECK_INTERVAL_MS, BackupManager, DEFAULT_BACKUP_KEEP } from "../storage/backups";
import type { EconomyAirport } from "../economy";

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
  /** SimConnect over TCP at this host/port instead of the normal discovery (hidden CLI option). */
  simconnectRemote?: { host: string; port: number };
  /** Seed for a newly created company (tests; default: fixed for replays, random live). */
  economySeed?: number;
  /** Airport list override (tests). */
  airports?: EconomyAirport[];
  /** Company clock tick interval, ms (default 1000; 0 = no timer, tests tick by hand). */
  clockIntervalMs?: number;
  /** Backups kept per database (default 14); 0 turns the daily backup off and keeps all. */
  backupKeep?: number;
  /** Daily backups (default: on for the live database, off for replays). */
  dailyBackups?: boolean;
  /** Weather source (default: "online" for a live sim, "sample" for replays). */
  weather?: WeatherMode;
  /** fetch used for SimBrief and METARs (tests). */
  fetch?: typeof fetch;
  /** Clock for backups and SimBrief (tests). */
  now?: () => number;
  /**
   * LAN opt-in for this run: an address to bind ("0.0.0.0" or one interface IPv4), false to
   * force it off, undefined to follow the setting saved from /settings (off by default).
   */
  lan?: string | false;
  /** Non-loopback IPv4 addresses of this PC (tests inject addresses). */
  lanInterfaces?: () => string[];
  /** Which remote addresses count as this PC (tests; default loopback). */
  isLocalAddress?: (address: string | undefined) => boolean;
  /** Clock for pairing codes and lockouts (tests). */
  lanNow?: () => number;
}

export interface RunningConnector {
  server: RunningServer;
  session: ConnectorSession;
  storage: Storage;
  flights: FlightRepo;
  economy: EconomyRepo;
  token: string;
  logFile: string | null;
  log: LogFn;
  recorder: Recorder | null;
  backups: BackupManager;
  simbrief: SimbriefService;
  weather: WeatherService;
  lan: LanAccess;
  /** Address the LAN listener uses, or null when LAN access is off. */
  lanBind: string | null;
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
  if (options.resetToken) {
    clearLanDevices(options.dataDir);
    log("info", "Token reset: every paired LAN device was forgotten");
  }
  const lanAccess = new LanAccess({
    dataDir: options.dataDir,
    ...(options.lanNow ? { now: options.lanNow } : {}),
  });
  let lanSetting = config.lan ?? null;
  const lanBind =
    options.lan === false
      ? null
      : (options.lan ?? (lanSetting?.enabled ? lanSetting.address : null));

  const source: SimSource =
    options.source ??
    (options.sim === "fake"
      ? new FakeSource({
          fixturePath: options.fixture ?? join(connectorRoot(), "fixtures", "demo-kmem-katl.jsonl"),
          speed: options.speed ?? 1,
          loop: options.loop ?? false,
          log,
        })
      : new SimConnectSource({
          log,
          ...(options.simconnectRemote ? { remote: options.simconnectRemote } : {}),
        }));
  if (source.mode === "live") {
    log("info", `SimVars still unverified on a real sim: ${unverifiedSimVars().join(", ")}`);
  }

  // Demo/replay never touch the career database (plan §3.2).
  const storage = openStorage(options.dataDir, source.mode === "live" ? "live" : "demo");
  log("info", `Database: ${storage.path} (schema v${storage.schemaVersion()})`);

  // Flights and telemetry go to the database of this mode (demo.db for replays).
  const flights = new FlightRepo(storage, source.frameSource);
  const economy = new EconomyRepo(storage);
  let airports: EconomyAirport[] | null = options.airports ?? null;
  if (!airports) {
    try {
      const loaded = loadAirportsData();
      airports = loaded.airports;
      log("info", `Airports: ${airports.length} from ${loaded.path}`);
    } catch (err) {
      log("warn", `Job boards disabled: ${err instanceof Error ? err.message : err}`);
    }
  }
  const session = new ConnectorSession(source, log, {
    repo: flights,
    economy: {
      repo: economy,
      airports,
      replay: source.mode !== "live",
      ...(options.economySeed !== undefined ? { seed: options.economySeed } : {}),
    },
  });
  const flightRoutes = flightsApi(flights);
  const economyRoutes = economyApi({
    session,
    repo: economy,
    flights,
    database: storage.kind,
  });
  const keep = options.backupKeep ?? DEFAULT_BACKUP_KEEP;
  const backups = new BackupManager({
    db: storage.db,
    kind: storage.kind,
    dir: join(options.dataDir, "backups"),
    keep,
    ...(options.now ? { now: options.now } : {}),
  });
  const simbrief = new SimbriefService({
    storage,
    version,
    log,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  const weather = new WeatherService({
    mode: options.weather ?? (source.mode === "live" ? "online" : "sample"),
    version,
    log,
    db: storage.db,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  log("info", `Weather: ${weather.mode}`);
  // Weather bonus: missions freeze the METAR the connector already holds (no extra requests).
  session.economy?.setWeatherLookup((station) => weather.peek(station));
  const weatherRoutes = weatherApi(weather);
  const dataRoutes = dataApi({ backups, simbrief, databasePath: storage.path });
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
      lan: {
        access: lanAccess,
        bind: lanBind,
        ...(options.lanInterfaces ? { interfaces: options.lanInterfaces } : {}),
        setting: () => lanSetting,
        saveSetting: (setting) => {
          lanSetting = saveLanSetting(options.dataDir, setting).lan ?? null;
        },
      },
      ...(options.isLocalAddress ? { isLocalAddress: options.isLocalAddress } : {}),
      routes: async (req) =>
        flightRoutes(req) ?? economyRoutes(req) ?? (await dataRoutes(req)) ?? weatherRoutes(req),
      status: () => ({
        dataDir: options.dataDir,
        database: storage.path,
        recording: recorder?.path ?? null,
        weather: weather.mode,
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
  // Company clock (P4): in-game time runs with real time while the connector runs.
  const clockMs = options.clockIntervalMs ?? 1_000;
  const clock =
    clockMs > 0 && session.economy
      ? setInterval(() => {
          try {
            session.economy?.tick();
          } catch (err) {
            log("warn", `Company clock tick failed: ${err instanceof Error ? err.message : err}`);
          }
        }, clockMs)
      : null;
  clock?.unref();
  // Daily backup of the career database (plan §3.3): at start and then hourly, a
  // `VACUUM INTO backups/cargo-ops-YYYYMMDD.db` when today's file is missing.
  const daily = (options.dailyBackups ?? source.mode === "live") && keep > 0;
  const runDaily = () => {
    const r = backups.daily();
    if (!r) return;
    if (r.ok) {
      const removed = r.removed.length ? ` (rotated out ${r.removed.join(", ")})` : "";
      log("info", `Backup written: ${r.backup.name}${removed}`);
    } else log("warn", `Daily backup failed: ${r.message}`);
  };
  if (daily) runDaily();
  const backupTimer = daily ? setInterval(runDaily, BACKUP_CHECK_INTERVAL_MS) : null;
  backupTimer?.unref();

  return {
    server,
    session,
    storage,
    flights,
    economy,
    token: config.token,
    logFile: logger.file,
    log,
    recorder,
    backups,
    simbrief,
    weather,
    lan: lanAccess,
    lanBind,
    stop: async () => {
      if (clock) clearInterval(clock);
      if (backupTimer) clearInterval(backupTimer);
      await server.close();
      await session.stop();
      recorder?.close();
      storage.close();
      log("info", "Connector stopped");
    },
  };
}
