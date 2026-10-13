// Authenticated HTTP calls to the local connector's /api (same origin). The token
// comes from GET /api/session, exactly like the WebSocket transport. Browser-only:
// call from effects or event handlers, never during render.

import { fetchSession } from "./useSimConnection";

let tokenPromise: Promise<string> | null = null;

function token(fetchImpl: typeof fetch): Promise<string> {
  tokenPromise ??= fetchSession(fetchImpl)
    .then((s) => s.token)
    .catch((err: unknown) => {
      tokenPromise = null;
      throw err;
    });
  return tokenPromise;
}

/** Forget the cached token (after a 401, e.g. when the connector reset it). */
export function resetConnectorToken(): void {
  tokenPromise = null;
}

export async function connectorFetch(
  path: string,
  init: RequestInit = {},
  fetchImpl: typeof fetch = globalThis.fetch.bind(globalThis),
): Promise<Response> {
  const t = await token(fetchImpl);
  const res = await fetchImpl(path, {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${t}` },
  });
  if (res.status === 401) resetConnectorToken();
  return res;
}

export async function connectorJson<T>(path: string): Promise<T> {
  const res = await connectorFetch(path, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`${path} failed (${res.status})`);
  return (await res.json()) as T;
}

/** Download an export (CSV/GPX/JSON) through a temporary object URL. */
export async function downloadExport(path: string, fallbackName: string): Promise<void> {
  const res = await connectorFetch(path);
  if (!res.ok) throw new Error(`Export failed (${res.status})`);
  const disposition = res.headers.get("Content-Disposition") ?? "";
  const name = /filename="([^"]+)"/.exec(disposition)?.[1] ?? fallbackName;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  globalThis.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
