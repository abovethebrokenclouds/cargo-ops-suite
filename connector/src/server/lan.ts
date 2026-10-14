// LAN opt-in (plan §3.2 "LAN access is a later explicit opt-in"): pairing codes, per-device
// LAN tokens, brute-force protection and the address helpers the server uses.
//
// Model:
//   - Off by default. With LAN on, the server also listens on a non-loopback address.
//   - The main token (config.json) only ever goes to, and is only accepted from, loopback
//     clients (this PC). `GET /api/session` never hands it to a LAN client.
//   - A LAN client pairs: the player generates a short one-time code on this PC's /settings
//     and types it on the tablet (or opens the pairing URL). The code is exchanged for a
//     separate per-device LAN token that can be revoked from /settings.
//   - Codes expire after PAIRING_CODE_TTL_MS, are single-use and are burned after
//     MAX_FAILURES_PER_CODE wrong guesses; one address is locked out after
//     MAX_FAILURES_PER_ADDRESS wrong guesses inside FAILURE_WINDOW_MS.
//   - LAN tokens are stored hashed (SHA-256) in <data-dir>/lan-devices.json.

import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isIPv4, isIPv6 } from "node:net";
import { networkInterfaces } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { LogFn } from "../sim/source";
import { tokensEqual } from "./security";

export const PAIRING_CODE_TTL_MS = 5 * 60_000;
export const MAX_FAILURES_PER_ADDRESS = 5;
export const MAX_FAILURES_PER_CODE = 10;
export const FAILURE_WINDOW_MS = 15 * 60_000;
export const LOCKOUT_MS = 15 * 60_000;
export const MAX_LAN_DEVICES = 32;
export const MAX_DEVICE_NAME = 40;
/** Unambiguous alphabet (no 0/O, 1/I/L): 31 symbols, 8 of them ≈ 2^39.6 codes. */
export const PAIRING_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;

// ---- addresses ----

/** True for 127.0.0.0/8, ::1 and their IPv4-mapped IPv6 forms. */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const a = address.toLowerCase();
  if (a === "::1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return isIPv4(v4) && v4.startsWith("127.");
}

/** Non-internal IPv4 addresses of this machine (what `0.0.0.0` actually exposes on a LAN). */
export function lanInterfaceAddresses(
  nets: ReturnType<typeof networkInterfaces> = networkInterfaces(),
): string[] {
  const out: string[] = [];
  for (const list of Object.values(nets)) {
    for (const n of list ?? []) {
      if (n.family === "IPv4" && !n.internal && !out.includes(n.address)) out.push(n.address);
    }
  }
  return out;
}

/**
 * Validate a LAN bind address (from `--lan <address>` or the saved setting): "0.0.0.0" (all
 * interfaces) or an IPv4 literal of one of this machine's non-loopback interfaces. Returns an
 * error message (without the source; callers name it) or null.
 */
export function validateLanBind(bind: string, available: readonly string[]): string | null {
  if (bind === "0.0.0.0") return null;
  if (isIPv6(bind)) return `IPv6 (${bind}) is not supported; use an IPv4 address`;
  if (!isIPv4(bind)) return `"${bind}" is not an IPv4 literal`;
  if (isLoopbackAddress(bind)) {
    return `${bind} is a loopback address (127.0.0.1 is always served without LAN access)`;
  }
  if (!available.includes(bind)) {
    return `${bind} is not an address of this PC (found: ${available.join(", ") || "none"})`;
  }
  return null;
}

/** LAN addresses a bind exposes: every interface for 0.0.0.0, else the one address. */
export function boundLanAddresses(bind: string, available: readonly string[]): string[] {
  return bind === "0.0.0.0" ? [...available] : [bind];
}

// ---- pairing codes ----

export function generatePairingCode(): string {
  let code = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  }
  return code;
}

/** "abcd-efgh " → "ABCDEFGH" (separators and case do not matter when typing the code). */
export function normalizePairingCode(input: unknown): string {
  return typeof input === "string" ? input.toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

/** "ABCDEFGH" → "ABCD-EFGH" for display. */
export function formatPairingCode(code: string): string {
  return code.length === 8 ? `${code.slice(0, 4)}-${code.slice(4)}` : code;
}

export function sanitizeDeviceName(input: unknown): string {
  const raw = typeof input === "string" ? input : "";
  // Printable characters only: control characters (Cc: C0, DEL, C1) become spaces, format
  // characters (Cf: bidi overrides and isolates, zero-width, BOM) are dropped; whitespace
  // (including line/paragraph separators) collapses to one space.
  const printable = raw.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "");
  const clean = Array.from(printable.replace(/\s+/g, " ").trim())
    .slice(0, MAX_DEVICE_NAME)
    .join("")
    .trim();
  return clean || "LAN device";
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

// ---- devices file ----

const deviceSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  tokenHash: z.string().regex(/^[0-9a-f]{64}$/),
  pairedAt: z.string(),
  pairedFrom: z.string(),
});
const devicesFileSchema = z.object({ devices: z.array(deviceSchema) });
type StoredDevice = z.infer<typeof deviceSchema>;

/** A paired device as /api/lan reports it (never the token or its hash). */
export interface LanDevice {
  id: string;
  name: string;
  pairedAt: string;
  pairedFrom: string;
  lastSeenAt: string | null;
}

export function lanDevicesPath(dataDir: string): string {
  return join(dataDir, "lan-devices.json");
}

/** Forget every paired device (used by --reset-token). */
export function clearLanDevices(dataDir: string): void {
  rmSync(lanDevicesPath(dataDir), { force: true });
}

// ---- pairing service ----

export type PairResult =
  | { ok: true; token: string; device: LanDevice }
  | {
      ok: false;
      status: 401 | 429;
      code: "invalid_code" | "pairing_locked";
      message: string;
      retryAfterSec?: number;
      /** This wrong guess cancelled the code (too many in total). */
      burned?: boolean;
    };

export interface LanAccessOptions {
  /** Where lan-devices.json lives; null keeps devices in memory (tests). */
  dataDir: string | null;
  now?: () => number;
  /** Warnings (a code cancelled by wrong guesses). */
  log?: LogFn;
}

interface ActiveCode {
  code: string;
  expiresAt: number;
  failures: number;
}

interface AddressFailures {
  times: number[];
  lockedUntil: number;
}

export class LanAccess {
  private readonly now: () => number;
  private devicesList: StoredDevice[] = [];
  private readonly lastSeen = new Map<string, number>();
  private active: ActiveCode | null = null;
  /** The last code was cancelled by too many wrong guesses (cleared by a new code). */
  private burned = false;
  private readonly failures = new Map<string, AddressFailures>();
  private readonly revokeListeners = new Set<(id: string) => void>();

  constructor(private readonly options: LanAccessOptions) {
    this.now = options.now ?? Date.now;
    this.devicesList = this.load();
  }

  // -- codes --

  /** A fresh one-time code; replaces any previous one. */
  createCode(): { code: string; expiresAt: string } {
    const code = generatePairingCode();
    this.active = { code, expiresAt: this.now() + PAIRING_CODE_TTL_MS, failures: 0 };
    this.burned = false;
    return { code, expiresAt: new Date(this.active.expiresAt).toISOString() };
  }

  /** The current code if still valid. */
  currentCode(): { code: string; expiresAt: string } | null {
    if (!this.active || this.now() >= this.active.expiresAt) {
      this.active = null;
      return null;
    }
    return { code: this.active.code, expiresAt: new Date(this.active.expiresAt).toISOString() };
  }

  /** True after wrong guesses cancelled the last code, until a new one is made. */
  codeBurned(): boolean {
    return this.burned;
  }

  cancelCode(): void {
    this.burned = false;
    this.active = null;
  }

  /** Seconds until `address` may try again, or 0. */
  lockedFor(address: string): number {
    const f = this.failures.get(address);
    const left = f ? f.lockedUntil - this.now() : 0;
    return left > 0 ? Math.ceil(left / 1000) : 0;
  }

  /** Exchange a pairing code for a new LAN token. */
  pair(codeInput: unknown, nameInput: unknown, address: string): PairResult {
    const locked = this.lockedFor(address);
    if (locked > 0) {
      return {
        ok: false,
        status: 429,
        code: "pairing_locked",
        message: `Too many wrong codes from this device. Try again in ${Math.ceil(locked / 60)} min.`,
        retryAfterSec: locked,
      };
    }
    const code = normalizePairingCode(codeInput);
    const active = this.currentCode() ? this.active : null;
    if (!active || code.length !== PAIRING_CODE_LENGTH || !tokensEqual(active.code, code)) {
      const burned = this.recordFailure(address);
      return {
        ok: false,
        status: 401,
        code: "invalid_code",
        message: "That code is wrong or expired. Generate a new one in Settings on the PC.",
        ...(burned ? { burned: true } : {}),
      };
    }
    if (this.devicesList.length >= MAX_LAN_DEVICES) {
      // Oldest pairing makes room; the player can revoke explicitly anyway.
      const dropped = this.devicesList.shift();
      if (dropped) this.emitRevoke(dropped.id);
    }
    this.active = null; // single use
    this.failures.delete(address);
    const token = randomBytes(32).toString("hex");
    const stored: StoredDevice = {
      id: randomUUID(),
      name: sanitizeDeviceName(nameInput),
      tokenHash: hashToken(token),
      pairedAt: new Date(this.now()).toISOString(),
      pairedFrom: address.startsWith("::ffff:") ? address.slice(7) : address,
    };
    this.devicesList.push(stored);
    this.save();
    return { ok: true, token, device: this.view(stored) };
  }

  /** Count a wrong guess; true when it cancelled the active code. */
  private recordFailure(address: string): boolean {
    const now = this.now();
    const f = this.failures.get(address) ?? { times: [], lockedUntil: 0 };
    f.times = f.times.filter((t) => now - t < FAILURE_WINDOW_MS);
    f.times.push(now);
    if (f.times.length >= MAX_FAILURES_PER_ADDRESS) {
      f.lockedUntil = now + LOCKOUT_MS;
      f.times = [];
    }
    this.failures.set(address, f);
    let burned = false;
    if (this.active) {
      this.active.failures++;
      // Too many guesses overall (from any address): burn the code.
      if (this.active.failures >= MAX_FAILURES_PER_CODE) {
        this.options.log?.(
          "warn",
          `LAN pairing code cancelled after ${this.active.failures} wrong attempts (last from ${address}); create a new one on the PC`,
        );
        this.active = null;
        this.burned = true;
        burned = true;
      }
    }
    // Bound the map (a LAN has few addresses; this only guards against spoofed floods).
    if (this.failures.size > 1024) {
      for (const [key, value] of this.failures) {
        if (value.lockedUntil <= now && value.times.every((t) => now - t >= FAILURE_WINDOW_MS)) {
          this.failures.delete(key);
        }
      }
    }
    return burned;
  }

  // -- devices --

  /** The paired device for a LAN token, or null (constant-time hash comparison). */
  verify(token: string | undefined | null): LanDevice | null {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
    const hash = hashToken(token);
    const device = this.devicesList.find((d) => tokensEqual(d.tokenHash, hash));
    if (!device) return null;
    this.lastSeen.set(device.id, this.now());
    return this.view(device);
  }

  devices(): LanDevice[] {
    return this.devicesList.map((d) => this.view(d));
  }

  revoke(id: string): boolean {
    const before = this.devicesList.length;
    this.devicesList = this.devicesList.filter((d) => d.id !== id);
    if (this.devicesList.length === before) return false;
    this.lastSeen.delete(id);
    this.save();
    this.emitRevoke(id);
    return true;
  }

  /** Called with the device id whenever a device is revoked (the server closes its sockets). */
  onRevoke(listener: (id: string) => void): () => void {
    this.revokeListeners.add(listener);
    return () => this.revokeListeners.delete(listener);
  }

  private emitRevoke(id: string): void {
    for (const l of this.revokeListeners) l(id);
  }

  private view(d: StoredDevice): LanDevice {
    const seen = this.lastSeen.get(d.id);
    return {
      id: d.id,
      name: d.name,
      pairedAt: d.pairedAt,
      pairedFrom: d.pairedFrom,
      lastSeenAt: seen === undefined ? null : new Date(seen).toISOString(),
    };
  }

  private load(): StoredDevice[] {
    if (!this.options.dataDir) return [];
    const path = lanDevicesPath(this.options.dataDir);
    if (!existsSync(path)) return [];
    try {
      const parsed = devicesFileSchema.safeParse(JSON.parse(readFileSync(path, "utf8")));
      return parsed.success ? parsed.data.devices : [];
    } catch {
      return [];
    }
  }

  private save(): void {
    if (!this.options.dataDir) return;
    mkdirSync(this.options.dataDir, { recursive: true });
    const path = lanDevicesPath(this.options.dataDir);
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ devices: this.devicesList }, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(tmp, path);
    try {
      chmodSync(path, 0o600);
    } catch {
      // Not supported everywhere (no-op on Windows).
    }
  }
}

// ---- local-only scope ----

/**
 * Destructive data actions, backups (their list shows paths on this PC) and LAN management
 * stay on this PC (loopback clients with the main token). A paired LAN device gets full
 * flying/company control otherwise.
 */
export function isLocalOnlyRoute(method: string, pathname: string): boolean {
  if (pathname === "/api/lan" || pathname.startsWith("/api/lan/")) return true;
  if (method === "DELETE") return true;
  if (pathname === "/api/import") return true;
  // Backups: writing one is a data action, and the list shows absolute paths on this PC.
  if (pathname === "/api/backups") return true;
  return false;
}
