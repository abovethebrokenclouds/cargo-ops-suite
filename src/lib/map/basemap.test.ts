import { describe, expect, it, vi } from "vitest";

import { chooseBasemap, hasLocalBasemap } from "./basemap";
import { LOCAL_BASEMAP_PATH, OPENFREEMAP_STYLE_URL } from "./style";

const ORIGIN = "http://127.0.0.1:4311";
const ONLINE_STYLE = { version: 8, sources: {}, layers: [] };

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** Fake fetch keyed by URL; unknown URLs reject like a network failure. */
function fakeFetch(routes: Record<string, () => Response>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes[url];
    if (!route) throw new TypeError(`network error: ${url}`);
    return route();
  }) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe("chooseBasemap", () => {
  it("uses the local archive when the connector reports one", async () => {
    const fetch = fakeFetch({
      [`${ORIGIN}/api/health`]: () => json({ ok: true, basemap: { local: true } }),
    });
    const choice = await chooseBasemap({
      servedByConnector: true,
      onlineAllowed: true,
      fetch,
      origin: ORIGIN,
    });
    expect(choice.kind).toBe("local");
    expect(fetch).not.toHaveBeenCalledWith(OPENFREEMAP_STYLE_URL, expect.anything());
  });

  it("falls back to a HEAD probe when health has no basemap field", async () => {
    const fetch = fakeFetch({
      [`${ORIGIN}/api/health`]: () => json({ ok: true }),
      [`${ORIGIN}${LOCAL_BASEMAP_PATH}`]: () => new Response(null, { status: 200 }),
    });
    expect(await hasLocalBasemap(fetch, ORIGIN)).toBe(true);
  });

  it("goes online when there is no local archive and online maps are allowed", async () => {
    const fetch = fakeFetch({
      [`${ORIGIN}/api/health`]: () => json({ ok: true, basemap: { local: false } }),
      [OPENFREEMAP_STYLE_URL]: () => json(ONLINE_STYLE),
    });
    const choice = await chooseBasemap({
      servedByConnector: true,
      onlineAllowed: true,
      fetch,
      origin: ORIGIN,
    });
    expect(choice).toEqual({ kind: "online", style: ONLINE_STYLE });
  });

  it("never asks the page origin for tiles outside the connector", async () => {
    const fetch = fakeFetch({ [OPENFREEMAP_STYLE_URL]: () => json(ONLINE_STYLE) });
    const choice = await chooseBasemap({
      servedByConnector: false,
      onlineAllowed: true,
      fetch,
      origin: "http://localhost:8080",
    });
    expect(choice.kind).toBe("online");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("stays offline (no request at all) when online maps are off", async () => {
    const fetch = fakeFetch({});
    const choice = await chooseBasemap({
      servedByConnector: false,
      onlineAllowed: false,
      fetch,
      origin: "http://localhost:8080",
    });
    expect(choice.kind).toBe("offline");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to the offline outline when the online style is unreachable or invalid", async () => {
    for (const fetch of [
      fakeFetch({}),
      fakeFetch({ [OPENFREEMAP_STYLE_URL]: () => json({}, 503) }),
      fakeFetch({ [OPENFREEMAP_STYLE_URL]: () => json({ version: 7 }) }),
    ]) {
      const choice = await chooseBasemap({
        servedByConnector: false,
        onlineAllowed: true,
        fetch,
        origin: "http://localhost:8080",
      });
      expect(choice.kind).toBe("offline");
    }
  });
});
