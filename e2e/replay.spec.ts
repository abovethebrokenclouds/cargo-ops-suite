import { expect, test } from "./replay-fixtures";

test.describe("replay mode against the local connector (--sim fake)", () => {
  test("chip reads REPLAY after the connector welcome", async ({ page }) => {
    await page.goto("/");
    const chip = page.locator('header [role="status"]').first();
    await expect(chip).toHaveAttribute("data-status", "replay");
    await expect(chip).toHaveText(/REPLAY/);
  });

  test("/flight binds replayed frames and tags them REPLAY", async ({ page }) => {
    const external: string[] = [];
    page.on("request", (req) => {
      const host = new URL(req.url()).hostname;
      if (host !== "127.0.0.1" && host !== "localhost") external.push(req.url());
    });
    await page.goto("/flight");
    await expect(page.getByTestId("aircraft-title")).not.toHaveText("No aircraft loaded");
    await expect(page.getByTestId("live-flight").getByText("REPLAY").first()).toBeVisible();
    await expect(page.getByTestId("live-flight").getByText("DEMO")).toHaveCount(0);
    expect(external).toEqual([]);
  });

  test("/flight weather in a replay comes from the connector as SAMPLE, never live", async ({
    page,
  }) => {
    const weatherCalls: string[] = [];
    page.on("request", (req) => {
      if (req.url().includes("/api/weather/")) weatherCalls.push(req.url());
    });
    await page.goto("/flight");
    const weather = page.getByTestId("route-weather");
    const origin = weather.locator('[data-testid="metar-station"][data-station="KMEM"]');
    await expect(origin).toHaveAttribute("data-origin", "sample", { timeout: 15_000 });
    await expect(origin.getByTestId("flight-category")).toHaveText("VFR");
    await expect(weather.getByTestId("weather-status")).toHaveAttribute(
      "data-weather-mode",
      "sample",
    );
    await expect(weather.locator('[data-metar-origin="live"]')).toHaveCount(0);
    expect(weatherCalls.some((u) => u.includes("/api/weather/metar?ids=KMEM"))).toBe(true);
    // The destination TAF also comes from the connector, as SAMPLE.
    const taf = weather.getByTestId("taf-timeline");
    await expect(taf).toHaveAttribute("data-origin", "sample", { timeout: 15_000 });
    await expect(taf.getByTestId("taf-period").first()).toBeVisible();
    expect(weatherCalls.some((u) => u.includes("/api/weather/taf?ids=KATL"))).toBe(true);
  });

  test("/flight shows connector-computed phases and a graded landing", async ({ page }) => {
    // The connector recomputes phases and the touchdown from raw telemetry (FakeSource
    // strips the fixture's authored ones). At 20× a pass lasts ~19 s.
    test.setTimeout(75_000);
    await page.goto("/flight");
    const phase = page.getByTestId("phase-label");
    // Check the tracked-flight summary while airborne: about a second after the landing the
    // replay arrives and loops, and the new session clears the flight domain (the landing
    // card stays until the next takeoff), so checking it after the grade is a race.
    await expect(phase).toHaveText(/Takeoff|Climb|Cruise|Descent|Approach/, { timeout: 30_000 });
    await expect(page.getByTestId("flight-summary")).toBeVisible();
    // The landing card only exists from the touchdown to the next pass's takeoff (~4.7 s of
    // replay at 20×): the next flight.started resets it to "Awaiting touchdown" by design.
    // Grade, source and the absence of "Provisional" are therefore asserted in ONE locator,
    // so they are read from the same render: separate assertions after the grade could land
    // after that takeoff on a slow runner (CI run 38499677204; E2E_CPU_THROTTLE=6 locally:
    // card gone, phase already Climb).
    const gradedCard = page
      .getByTestId("landing-card")
      .filter({
        has: page.getByTestId("landing-grade").filter({ hasText: /^(A\+|A|B|C|D|E|F)$/ }),
      })
      .filter({
        has: page.getByTestId("landing-source").filter({ hasText: "Graded by the connector" }),
      })
      .filter({ hasNotText: /Provisional/ });
    await expect(gradedCard).toBeVisible({ timeout: 60_000 });
  });

  test("/diagnostics reports the replay welcome", async ({ page }) => {
    await page.goto("/diagnostics");
    await expect(page.getByTestId("diagnostics")).toContainText(/replay/i);
  });

  test("nav marks the current route active in the local SPA build", async ({ page }) => {
    for (const [route, label] of [
      ["/flight", "Live Flight"],
      ["/logbook", "Logbook"],
      ["/", "Ops"],
    ] as const) {
      await page.goto(route);
      const active = page.locator('nav[aria-label="Primary"] a[data-status="active"]');
      await expect(active.first()).toHaveText(label);
      await expect(active).toHaveText([label, label]);
    }
  });

  test("deep link to a client route is served by the SPA shell", async ({ request }) => {
    const res = await request.get("/logbook");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("text/html");
  });

  test("session endpoint refuses a foreign origin and traversal is rejected", async ({
    request,
  }) => {
    const foreign = await request.get("/api/session", {
      headers: { Origin: "http://evil.example" },
    });
    expect(foreign.status()).toBe(403);
    const traversal = await request.get("/%2e%2e/%2e%2e/package.json");
    expect([400, 404]).toContain(traversal.status());
  });

  test("/map without a local basemap falls back to the outline and tags REPLAY", async ({
    page,
  }) => {
    const external: string[] = [];
    page.on("request", (req) => {
      const host = new URL(req.url()).hostname;
      if (host !== "127.0.0.1" && host !== "localhost") external.push(req.url());
    });
    await page.addInitScript(() => window.localStorage.setItem("cargo-ops.map.online", "off"));
    await page.goto("/map");
    await expect(page.getByTestId("ops-map")).toHaveAttribute("data-ready", "true", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("basemap-badge")).toHaveText("Offline outline");
    await expect(page.getByTestId("aircraft-marker")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("map-flight-panel").getByText("REPLAY")).toBeVisible();
    expect(external).toEqual([]);
  });

  test("health reports the basemap and /tiles refuses bad names", async ({ request }) => {
    const health = await request.get("/api/health");
    expect((await health.json()).basemap).toEqual({ local: false });
    expect((await request.get("/tiles/basemap.pmtiles")).status()).toBe(404);
    expect((await request.get("/tiles/Bad_Name.pmtiles")).status()).toBe(400);
  });
});
