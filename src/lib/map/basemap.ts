// Basemap selection (plan §8), in order:
//   1. local PMTiles from the connector, when the page is served by it and it reports one
//   2. OpenFreeMap online style, unless the user turned online maps off
//   3. the offline world-atlas floor (always available, also the floor under 1 and 2)

import { LOCAL_BASEMAP_PATH, OPENFREEMAP_STYLE_URL, type BasemapKind } from "./style";

export type BasemapChoice =
  { kind: "local" } | { kind: "online"; style: Record<string, unknown> } | { kind: "offline" };

export interface ChooseBasemapOptions {
  servedByConnector: boolean;
  onlineAllowed: boolean;
  fetch: typeof fetch;
  /** Page origin, for the connector's same-origin endpoints. */
  origin: string;
  timeoutMs?: number;
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    return await fetchImpl(url, controller ? { ...init, signal: controller.signal } : init);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Does the connector serving this page have a local basemap? */
export async function hasLocalBasemap(
  fetchImpl: typeof fetch,
  origin: string,
  timeoutMs = 4000,
): Promise<boolean> {
  try {
    const res = await fetchWithTimeout(
      fetchImpl,
      `${origin}/api/health`,
      { headers: { Accept: "application/json" } },
      timeoutMs,
    );
    if (res.ok) {
      const body = (await res.json()) as { basemap?: { local?: unknown } };
      if (typeof body.basemap?.local === "boolean") return body.basemap.local;
    }
  } catch {
    // fall through to the HEAD probe
  }
  try {
    const head = await fetchWithTimeout(
      fetchImpl,
      `${origin}${LOCAL_BASEMAP_PATH}`,
      { method: "HEAD" },
      timeoutMs,
    );
    return head.ok;
  } catch {
    return false;
  }
}

/** Fetch the OpenFreeMap style; null when offline, blocked or malformed. */
export async function fetchOnlineStyle(
  fetchImpl: typeof fetch,
  timeoutMs = 6000,
): Promise<Record<string, unknown> | null> {
  try {
    const res = await fetchWithTimeout(fetchImpl, OPENFREEMAP_STYLE_URL, {}, timeoutMs);
    if (!res.ok) return null;
    const style = (await res.json()) as Record<string, unknown>;
    return style["version"] === 8 && Array.isArray(style["layers"]) ? style : null;
  } catch {
    return null;
  }
}

export async function chooseBasemap(options: ChooseBasemapOptions): Promise<BasemapChoice> {
  const timeout = options.timeoutMs;
  if (
    options.servedByConnector &&
    (await hasLocalBasemap(options.fetch, options.origin, timeout))
  ) {
    return { kind: "local" };
  }
  if (options.onlineAllowed) {
    const style = await fetchOnlineStyle(options.fetch, timeout);
    if (style) return { kind: "online", style };
  }
  return { kind: "offline" };
}

export type { BasemapKind };
