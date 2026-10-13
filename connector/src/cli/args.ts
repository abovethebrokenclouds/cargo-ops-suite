// Command-line parsing (no dependencies). Pure: returns options or an error.

export interface CliOptions {
  sim: "simconnect" | "fake";
  fixture?: string;
  speed: number;
  loop: boolean;
  record?: string;
  port: number;
  web?: string;
  dataDir?: string;
  basemapDir?: string;
  devOrigins: string[];
  open: boolean;
  lan: boolean;
  resetToken: boolean;
  backupKeep: number;
  verbose: boolean;
  help: boolean;
  version: boolean;
}

export const HELP = `Cargo Ops connector

Usage: npm start -- [options]
       node dist/connector/src/cli/main.js [options]

Simulator
  --sim simconnect|fake   Data source (default: simconnect). "fake" replays a fixture.
  --fixture <path>        JSONL fixture for --sim fake (default: fixtures/demo-kmem-katl.jsonl)
  --speed <n>             Replay speed multiplier for --sim fake (default: 1)
  --loop                  Restart the replay when it ends
  --record <path>         Append every outgoing frame to a new JSONL fixture file

Server
  --port <n>              Port on 127.0.0.1 (default: 4311)
  --web <dir>             Serve this SPA build (default: ../dist/client if present)
  --dev-origin [origin]   Also accept this page origin (repeatable). Without a value:
                          the Vite dev server origins http://localhost:8080 and
                          http://127.0.0.1:8080
  --lan                   Not implemented; the connector only listens on 127.0.0.1

Data
  --data-dir <dir>        Config, databases and logs (default: %LOCALAPPDATA%\\CargoOps on
                          Windows, $XDG_CONFIG_HOME/cargo-ops or ~/.config/cargo-ops elsewhere)
  --basemap-dir <dir>     Local basemap folder served under /tiles/ (default: <data-dir>/basemap;
                          fill it with scripts/fetch-basemap.ps1 or .sh)
  --reset-token           Generate a new access token (open browser tabs must reload)
  --backup-keep <n>       Database backups kept in <data-dir>/backups (default: 14). A daily
                          backup of the career database runs while the connector is up;
                          0 turns the daily backup off (on-demand backups are then all kept)

Other
  --open                  Open the browser when the server is ready
  --verbose               Debug logging
  --version               Print the version
  --help                  Show this help
`;

export type ParseArgsResult = { ok: true; options: CliOptions } | { ok: false; error: string };

export function parseArgs(argv: readonly string[]): ParseArgsResult {
  const options: CliOptions = {
    sim: "simconnect",
    speed: 1,
    loop: false,
    port: 4311,
    devOrigins: [],
    open: false,
    lan: false,
    resetToken: false,
    backupKeep: 14,
    verbose: false,
    help: false,
    version: false,
  };
  const args = [...argv];
  const takeValue = (flag: string, inline: string | undefined): string | { error: string } => {
    if (inline !== undefined) return inline;
    const next = args.shift();
    if (next === undefined || next.startsWith("--")) return { error: `${flag} needs a value` };
    return next;
  };

  while (args.length > 0) {
    const raw = args.shift() as string;
    if (!raw.startsWith("--")) return { ok: false, error: `Unexpected argument: ${raw}` };
    const eq = raw.indexOf("=");
    const flag = eq >= 0 ? raw.slice(0, eq) : raw;
    const inline = eq >= 0 ? raw.slice(eq + 1) : undefined;

    switch (flag) {
      case "--help":
        options.help = true;
        break;
      case "--version":
        options.version = true;
        break;
      case "--loop":
        options.loop = true;
        break;
      case "--open":
        options.open = true;
        break;
      case "--lan":
        options.lan = true;
        break;
      case "--reset-token":
        options.resetToken = true;
        break;
      case "--verbose":
        options.verbose = true;
        break;
      case "--dev-origin": {
        const next = inline ?? (args[0] && !args[0].startsWith("--") ? args.shift() : undefined);
        if (next === undefined)
          options.devOrigins.push("http://localhost:8080", "http://127.0.0.1:8080");
        else options.devOrigins.push(next);
        break;
      }
      case "--sim":
      case "--fixture":
      case "--speed":
      case "--record":
      case "--port":
      case "--web":
      case "--data-dir":
      case "--basemap-dir":
      case "--backup-keep": {
        const value = takeValue(flag, inline);
        if (typeof value !== "string") return { ok: false, error: value.error };
        if (flag === "--sim") {
          if (value !== "simconnect" && value !== "fake") {
            return { ok: false, error: `--sim must be "simconnect" or "fake", got "${value}"` };
          }
          options.sim = value;
        } else if (flag === "--speed") {
          const speed = Number(value);
          if (!Number.isFinite(speed) || speed <= 0) {
            return { ok: false, error: "--speed must be a positive number" };
          }
          options.speed = speed;
        } else if (flag === "--port") {
          const port = Number(value);
          if (!Number.isInteger(port) || port < 0 || port > 65535) {
            return { ok: false, error: "--port must be an integer between 0 and 65535" };
          }
          options.port = port;
        } else if (flag === "--backup-keep") {
          const keep = Number(value);
          if (!Number.isInteger(keep) || keep < 0 || keep > 3650) {
            return { ok: false, error: "--backup-keep must be an integer between 0 and 3650" };
          }
          options.backupKeep = keep;
        } else if (flag === "--fixture") options.fixture = value;
        else if (flag === "--record") options.record = value;
        else if (flag === "--web") options.web = value;
        else if (flag === "--basemap-dir") options.basemapDir = value;
        else options.dataDir = value;
        break;
      }
      default:
        return { ok: false, error: `Unknown option: ${flag} (see --help)` };
    }
  }
  if (options.fixture && options.sim !== "fake") {
    return { ok: false, error: "--fixture only applies to --sim fake" };
  }
  return { ok: true, options };
}
