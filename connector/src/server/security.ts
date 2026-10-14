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

/**
 * Own origins (127.0.0.1 and localhost on `port`), optional dev origins, and with LAN on the
 * IPv4 literals of the interfaces the server actually bound (never a hostname: a Host header
 * naming anything else is refused, which is the DNS-rebinding guard).
 */
export function buildOriginPolicy(
  port: number,
  devOrigins: readonly string[] = [],
  lanAddresses: readonly string[] = [],
): OriginPolicy {
  const own = [
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    ...lanAddresses.map((a) => `http://${a}:${port}`),
  ];
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
  // No page of the connector may be framed by another page (clickjacking), with one exception:
  // the read-only /panel route below, shown inside the simulator's toolbar panel.
  "X-Frame-Options": "DENY",
  "Content-Security-Policy": "frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// ---- In-sim toolbar panel (msfs-panel/, docs/SETUP_WINDOWS.md "Toolbar panel") ----
//
// The simulator's toolbar panel is an HTML page inside the sim (served from its own `coui:`
// scheme) that shows http://127.0.0.1:<port>/panel in an iframe. Only that exact path may be
// framed, and only by the ancestors listed here:
//  - the panel page is read-only (no buttons that change anything, no links to other routes),
//    so a framing page has nothing to trick the player into clicking (clickjacking);
//  - a framing page cannot read the frame's content (different origin), and the access token
//    still only comes from same-origin GET /api/session to a loopback client;
//  - every other path keeps X-Frame-Options: DENY and frame-ancestors 'none', and the web app
//    refuses to render any other route inside a frame (src/lib/framing.ts) in case the
//    in-frame app navigates client-side.

/** The one route that may be framed. Exact match: "/panel/x" or "/panel?…" paths differ. */
export const PANEL_PATH = "/panel";

/** Default ancestors for /panel: this connector itself and the simulator's `coui:` UI scheme. */
export const DEFAULT_PANEL_FRAME_ANCESTORS: readonly string[] = ["'self'", "coui:"];

/** `--panel-frame-ancestor any`: send no framing restriction at all for /panel. */
export const ANY_FRAME_ANCESTOR = "any";

/**
 * Validate one extra frame ancestor given on the command line: an http(s) origin, a bare
 * scheme such as `coui:`, or `any`. Anything else (paths, wildcards, quotes, `;`) is refused
 * so the value can never inject another CSP directive.
 */
export function normalizeFrameAncestor(value: string): string {
  const v = value.trim();
  if (v.toLowerCase() === ANY_FRAME_ANCESTOR) return ANY_FRAME_ANCESTOR;
  if (/^[a-z][a-z0-9+.-]*:$/i.test(v)) {
    const scheme = v.toLowerCase();
    // A bare web scheme would let every web site frame the panel; say `any` if that is meant.
    if (["http:", "https:", "ws:", "wss:", "data:", "blob:"].includes(scheme)) {
      throw new Error(`frame ancestor ${value} is too broad: give an origin, or "any"`);
    }
    return scheme;
  }
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    throw new Error(
      `frame ancestor must be an http(s) origin, a scheme like coui: or "any": ${value}`,
    );
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.origin !== v.replace(/\/$/, "").toLowerCase()
  ) {
    throw new Error(`frame ancestor must be an http(s) origin without a path: ${value}`);
  }
  return url.origin;
}

/**
 * Framing headers for a response: `null` means "keep the strict defaults" (X-Frame-Options
 * DENY, frame-ancestors 'none'). For /panel the X-Frame-Options header is dropped (it cannot
 * name an allowed ancestor) and the CSP lists the allowed ancestors, or is dropped with `any`.
 */
export function panelFramingHeaders(
  pathname: string,
  ancestors: readonly string[],
): { csp: string | null } | null {
  if (pathname !== PANEL_PATH) return null;
  if (ancestors.includes(ANY_FRAME_ANCESTOR)) return { csp: null };
  return { csp: `frame-ancestors ${[...new Set(ancestors)].join(" ")}` };
}
