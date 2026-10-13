import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { startConnector, type RunningConnector } from "../src/cli/app";
import { SimbriefService } from "../src/core/simbrief";
import { mapSimbriefOfp, simbriefFetchUrl } from "../src/protocol";
import { FakeSource } from "../src/sim/fake-source";
import { shortFixture, tempDir } from "./helpers";

// HAND-MADE sample (see its _comment): not a recorded SimBrief response.
const SAMPLE = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "..", "fixtures", "simbrief-ofp.handmade.json"), "utf8"),
) as Record<string, unknown>;

function memoryStorage() {
  const map = new Map<string, unknown>();
  return {
    getSetting: <T>(key: string) => map.get(key) as T | undefined,
    setSetting: (key: string, value: unknown) => void map.set(key, value),
  };
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("SimBrief OFP mapping (hand-made sample)", () => {
  it("maps origin, destination, route, fuel and payload (lbs → kg)", () => {
    const r = mapSimbriefOfp(SAMPLE, "2026-10-13T00:00:00.000Z");
    assert.ok(r.ok);
    assert.equal(r.plan.origin, "KMEM");
    assert.equal(r.plan.destination, "KATL");
    assert.equal(r.plan.alternate, "KPDK");
    assert.equal(r.plan.route, "MEM J42 RQZ HONIE2");
    assert.equal(r.plan.units, "lb");
    assert.equal(r.plan.plannedFuelKg, 657.7); // 1450 lb
    assert.equal(r.plan.payloadKg, 840.1); // 1852 lb
    assert.equal(r.plan.eteMin, 111);
    assert.equal(r.plan.distanceNm, 297);
    assert.equal(r.plan.flightNumber, "CGO208");
    assert.equal(r.plan.aircraftIcao, "C208");
  });

  it("builds the documented fetch URL, user ID first", () => {
    assert.equal(
      simbriefFetchUrl({ enabled: true, username: "pilot_1", userId: null }),
      "https://www.simbrief.com/api/xml.fetcher.php?username=pilot_1&json=1",
    );
    assert.equal(
      simbriefFetchUrl({ enabled: true, username: "pilot_1", userId: "123456" }),
      "https://www.simbrief.com/api/xml.fetcher.php?userid=123456&json=1",
    );
    assert.equal(simbriefFetchUrl({ enabled: true, username: null, userId: null }), null);
  });
});

describe("SimbriefService", () => {
  const base = { version: "0.1.0", log: () => {} };

  it("is off by default and needs a user", async () => {
    const svc = new SimbriefService({
      ...base,
      storage: memoryStorage(),
      fetch: async () => {
        throw new Error("must not fetch");
      },
    });
    assert.deepEqual(svc.settings(), { enabled: false, username: null, userId: null });
    const off = await svc.import();
    assert.ok(!off.ok && off.code === "simbrief_disabled");
    svc.update({ enabled: true });
    const noUser = await svc.import();
    assert.ok(!noUser.ok && noUser.code === "simbrief_no_user");
  });

  it("imports, stores the plan, sends a User-Agent, then rate-limits", async () => {
    let now = 1_000_000;
    const calls: Array<{ url: string; ua: string | null }> = [];
    const svc = new SimbriefService({
      ...base,
      storage: memoryStorage(),
      now: () => now,
      fetch: async (url, init) => {
        calls.push({ url: String(url), ua: new Headers(init?.headers).get("User-Agent") });
        return jsonResponse(SAMPLE);
      },
    });
    svc.update({ enabled: true, username: "pilot_1" });
    const r = await svc.import();
    assert.ok(r.ok);
    assert.equal(svc.plan()?.destination, "KATL");
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]?.url,
      "https://www.simbrief.com/api/xml.fetcher.php?username=pilot_1&json=1",
    );
    assert.equal(calls[0]?.ua, "CargoOps/0.1.0 (private use)");
    now += 5_000;
    const limited = await svc.import();
    assert.ok(!limited.ok && limited.code === "rate_limited" && limited.retryAfterSec === 25);
    assert.equal(calls.length, 1, "no request while rate limited");
    now += 26_000;
    assert.ok((await svc.import()).ok);
    svc.clearPlan();
    assert.equal(svc.plan(), null);
  });

  it("fails gracefully: SimBrief error body, non-JSON, unreachable, timeout", async () => {
    let now = 0;
    let mode: "error" | "html" | "throw" | "hang" = "error";
    const svc = new SimbriefService({
      ...base,
      storage: memoryStorage(),
      now: () => now,
      timeoutMs: 50,
      fetch: (_url, init) => {
        if (mode === "error")
          return Promise.resolve(jsonResponse({ fetch: { status: "Error: Unknown UserID" } }, 400));
        if (mode === "html") return Promise.resolve(new Response("<html>", { status: 503 }));
        if (mode === "throw") return Promise.reject(new TypeError("fetch failed"));
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        );
      },
    });
    svc.update({ enabled: true, userId: "42" });
    const err = await svc.import();
    assert.ok(!err.ok && err.code === "simbrief_error" && err.message.includes("Unknown UserID"));
    now += 31_000;
    mode = "html";
    const html = await svc.import();
    assert.ok(!html.ok && html.code === "simbrief_error");
    now += 31_000;
    mode = "throw";
    const down = await svc.import();
    assert.ok(!down.ok && down.code === "simbrief_unreachable" && down.status === 502);
    now += 31_000;
    mode = "hang";
    const slow = await svc.import();
    assert.ok(!slow.ok && slow.code === "simbrief_timeout" && slow.status === 504);
    assert.equal(svc.plan(), null, "nothing stored after failures");
  });
});

describe("/api/simbrief through the connector", () => {
  it("GET/PUT settings, validation, import and clear, all behind the token", async () => {
    const tmp = tempDir();
    let fetched = 0;
    const c: RunningConnector = await startConnector({
      sim: "fake",
      dataDir: tmp.dir,
      port: 0,
      quiet: true,
      clockIntervalMs: 0,
      fetch: async () => {
        fetched++;
        return jsonResponse(SAMPLE);
      },
      source: new FakeSource({ frames: shortFixture(), speed: 1, loop: false }),
    });
    const api = (path: string, init: RequestInit = {}) =>
      fetch(`${c.server.url}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${c.token}`,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    try {
      assert.equal((await fetch(`${c.server.url}/api/simbrief`)).status, 401);
      const initial = (await (await api("/api/simbrief")).json()) as {
        settings: { enabled: boolean };
        plan: unknown;
        verified: boolean;
      };
      assert.equal(initial.settings.enabled, false);
      assert.equal(initial.plan, null);
      assert.equal(initial.verified, false);
      const bad = await api("/api/simbrief", {
        method: "PUT",
        body: JSON.stringify({ username: "bad name; drop" }),
      });
      assert.equal(bad.status, 400);
      assert.equal(
        (await api("/api/simbrief", { method: "PUT", body: JSON.stringify({ token: "x" }) }))
          .status,
        400,
        "unknown fields are refused",
      );
      assert.equal((await api("/api/simbrief/import", { method: "POST" })).status, 409);
      assert.equal(fetched, 0);
      const put = await api("/api/simbrief", {
        method: "PUT",
        body: JSON.stringify({ enabled: true, username: "pilot_1" }),
      });
      assert.equal(put.status, 200);
      const imported = await api("/api/simbrief/import", { method: "POST" });
      assert.equal(imported.status, 200);
      const plan = ((await imported.json()) as { plan: { origin: string } }).plan;
      assert.equal(plan.origin, "KMEM");
      assert.equal(fetched, 1);
      const again = await api("/api/simbrief/import", { method: "POST" });
      assert.equal(again.status, 429);
      const after = (await (await api("/api/simbrief")).json()) as {
        settings: { username: string };
        plan: { destination: string };
      };
      assert.equal(after.settings.username, "pilot_1");
      assert.equal(after.plan.destination, "KATL");
      assert.equal((await api("/api/simbrief/plan", { method: "DELETE" })).status, 200);
      const cleared = (await (await api("/api/simbrief")).json()) as { plan: unknown };
      assert.equal(cleared.plan, null);
    } finally {
      await c.stop();
      tmp.cleanup();
    }
  });
});
