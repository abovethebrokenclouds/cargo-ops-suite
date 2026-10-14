// Data directory and the local access token.
//   Windows:  %LOCALAPPDATA%\CargoOps
//   Others:   $XDG_CONFIG_HOME/cargo-ops, else ~/.config/cargo-ops
// `--data-dir` overrides both (tests use a temp dir).

import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, win32, posix } from "node:path";
import { z } from "zod";

export interface DataDirEnv {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  home: string;
}

export function defaultDataDir(
  input: DataDirEnv = { platform: process.platform, env: process.env, home: homedir() },
): string {
  if (input.platform === "win32") {
    const base = input.env["LOCALAPPDATA"] || win32.join(input.home, "AppData", "Local");
    return win32.join(base, "CargoOps");
  }
  const xdg = input.env["XDG_CONFIG_HOME"];
  return posix.join(
    xdg && xdg.startsWith("/") ? xdg : posix.join(input.home, ".config"),
    "cargo-ops",
  );
}

/** Persisted LAN opt-in (toggled from the local /settings; applies on the next start). */
const lanSettingSchema = z.object({
  enabled: z.boolean(),
  /** "0.0.0.0" (every interface) or one IPv4 address of this PC. */
  address: z.string().default("0.0.0.0"),
});
export type LanSetting = z.infer<typeof lanSettingSchema>;

const configSchema = z.object({
  token: z.string().regex(/^[0-9a-f]{64}$/),
  createdAt: z.string(),
  lan: lanSettingSchema.optional(),
});
export type ConnectorConfig = z.infer<typeof configSchema>;

export function configPath(dataDir: string): string {
  return join(dataDir, "config.json");
}

export function generateToken(): string {
  return randomBytes(32).toString("hex");
}

/**
 * Load config.json, creating it (with a fresh 32-byte token) on first run, when it
 * is unreadable, or when `resetToken` is set.
 */
export function loadOrCreateConfig(
  dataDir: string,
  options: { resetToken?: boolean } = {},
): { config: ConnectorConfig; created: boolean } {
  mkdirSync(dataDir, { recursive: true });
  const existing = readConfig(dataDir);
  if (!options.resetToken && existing) return { config: existing, created: false };
  const config: ConnectorConfig = {
    token: generateToken(),
    createdAt: new Date().toISOString(),
    // A token reset keeps the LAN preference (paired devices are cleared separately).
    ...(existing?.lan ? { lan: existing.lan } : {}),
  };
  writeConfig(dataDir, config);
  return { config, created: true };
}

function readConfig(dataDir: string): ConnectorConfig | null {
  const path = configPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const parsed = configSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function writeConfig(dataDir: string, config: ConnectorConfig): void {
  const path = configPath(dataDir);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Not supported on every filesystem (and a no-op on Windows).
  }
}

/** Persist the LAN opt-in for the next start (the running server is not rebound). */
export function saveLanSetting(dataDir: string, lan: LanSetting): ConnectorConfig {
  const { config } = loadOrCreateConfig(dataDir);
  const next: ConnectorConfig = { ...config, lan: lanSettingSchema.parse(lan) };
  writeConfig(dataDir, next);
  return next;
}
