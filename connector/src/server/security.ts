// Origin, Host and token checks (plan §3.2 security).

import { timingSafeEqual } from "node:crypto";

/** Default Vite dev server origins for this repo (Lovable's config uses port 8080). */
export const VITE_DEV_ORIGINS = ["http://localhost:8080", "http://127.0.0.1:8080"];

export interface OriginPolicy {
  /** Exact origins whose pages may use the session/WebSocket endpoints. */
  origins: Set<string>;
  /** Host header values this server answers to (DNS-rebinding guard). */
  hosts: Set<string>;
}

export function buildOriginPolicy(port: number, devOrigins: readonly string[] = []): OriginPolicy {
  const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`];
  const origins = new Set<string>([...own, ...devOrigins.map(normalizeOrigin)]);
  const hosts = new Set<string>();
  for (const origin of origins) {
    try {
      hosts.add(new URL(origin).host);
    } catch {
      // Ignore malformed dev origins (normalizeOrigin already validated them).
    }
  }
  return { origins, hosts };
}

/** Validate and canonicalise an origin given on the command line. */
export function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`dev origin must be http(s): ${value}`);
  }
  return url.origin;
}

/** Host header must name this server (rejects DNS rebinding). */
export function isAllowedHost(policy: OriginPolicy, host: string | undefined): boolean {
  return host !== undefined && policy.hosts.has(host.toLowerCase());
}

/** An Origin header is allowed when absent (same-origin GET) or an exact allowed origin. */
export function isAllowedOptionalOrigin(policy: OriginPolicy, origin: string | undefined): boolean {
  return origin === undefined || policy.origins.has(origin);
}

/** WebSocket upgrades must carry an allowed Origin (browsers always send one). */
export function isAllowedRequiredOrigin(policy: OriginPolicy, origin: string | undefined): boolean {
  return origin !== undefined && policy.origins.has(origin);
}

export function tokensEqual(expected: string, given: string | undefined | null): boolean {
  if (typeof given !== "string") return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match?.[1];
}

export const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
