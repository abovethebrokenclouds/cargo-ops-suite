#!/usr/bin/env node
// Cargo Ops connector entry point. See `--help` and connector/README.md.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { defaultDataDir } from "../core/config";
import { HELP, parseArgs } from "./args";
import { connectorRoot, connectorVersion, startConnector } from "./app";

/** Open a URL in the default browser; silently does nothing if no opener exists. */
export function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", '""', url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // No browser opener available; the URL is printed anyway.
  }
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    console.error(parsed.error);
    console.error("Run with --help for usage.");
    return 2;
  }
  const options = parsed.options;
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  if (options.version) {
    console.log(connectorVersion());
    return 0;
  }
  if (options.lan) {
    console.error(
      "--lan is not implemented. The connector only listens on 127.0.0.1; LAN access is a later, explicit opt-in (plan §3.2).",
    );
    return 2;
  }

  const defaultWeb = resolve(connectorRoot(), "..", "dist", "client");
  const web = options.web ?? (existsSync(join(defaultWeb, "_shell.html")) ? defaultWeb : undefined);

  let connector;
  try {
    connector = await startConnector({
      sim: options.sim,
      dataDir: resolve(options.dataDir ?? defaultDataDir()),
      port: options.port,
      speed: options.speed,
      loop: options.loop,
      devOrigins: options.devOrigins,
      resetToken: options.resetToken,
      backupKeep: options.backupKeep,
      verbose: options.verbose,
      ...(options.fixture ? { fixture: resolve(options.fixture) } : {}),
      ...(options.record ? { record: options.record } : {}),
      ...(web ? { web } : {}),
      ...(options.basemapDir ? { basemapDir: resolve(options.basemapDir) } : {}),
      ...(options.simconnectHost !== undefined && options.simconnectPort !== undefined
        ? { simconnectRemote: { host: options.simconnectHost, port: options.simconnectPort } }
        : {}),
    });
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === "EADDRINUSE") {
      console.error(
        `Port ${options.port} on 127.0.0.1 is already in use. Is another connector running? Try --port.`,
      );
    } else {
      console.error(`Failed to start: ${error.message ?? String(err)}`);
    }
    return 1;
  }

  const url = `http://127.0.0.1:${connector.server.port}/`;
  console.log(`\nCargo Ops is running at ${url}`);
  if (connector.logFile) console.log(`Log file: ${connector.logFile}`);
  console.log("Press Ctrl+C to stop.\n");
  if (options.open) openBrowser(url);

  await new Promise<void>((resolveStop) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      connector
        .stop()
        .catch((err: unknown) => console.error(err))
        .finally(() => resolveStop());
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
  });
  return 0;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
