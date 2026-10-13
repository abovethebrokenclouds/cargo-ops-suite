// Logger: stdout plus <data-dir>/logs/connector.log. Tokens are never logged.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { LogFn, LogLevel } from "../sim/source";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  log: LogFn;
  file: string | null;
}

export function createLogger(options: {
  dataDir?: string;
  level?: LogLevel;
  quiet?: boolean;
}): Logger {
  const min = ORDER[options.level ?? "info"];
  let file: string | null = null;
  if (options.dataDir) {
    const dir = join(options.dataDir, "logs");
    mkdirSync(dir, { recursive: true });
    file = join(dir, "connector.log");
  }
  const log: LogFn = (level, message) => {
    if (ORDER[level] < min) return;
    const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${message}`;
    if (!options.quiet) {
      if (level === "error" || level === "warn") console.error(line);
      else console.log(line);
    }
    if (file) {
      try {
        appendFileSync(file, `${line}\n`);
      } catch {
        // Logging must never take the connector down.
      }
    }
  };
  return { log, file };
}
