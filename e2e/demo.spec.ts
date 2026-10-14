import { expect, test } from "@playwright/test";

const ROUTES = [
  "/",
  "/flight",
  "/map",
  "/jobs",
  "/fleet",
  "/fbo",
  "/company",
  "/logbook",
  "/settings",
  "/diagnostics",
];

// Online maps (OpenFreeMap) are turned off so the map uses only bundled data and the
// "no external requests" rule holds for every route, /map included.
const ONLINE_MAPS_KEY = "cargo-ops.map.online";

test.describe("demo mode (no connector)", () => {
  test.beforeEach(async ({ page }) => {
    // E2E_CPU_THROTTLE=6 slows the page's CPU like a loaded CI runner (Chromium's own
    // throttling), to reproduce timing problems locally.
    const throttle = Number(process.env["E2E_CPU_THROTTLE"] ?? 1);
    if (throttle > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    await page.addInitScript((key) => {
      try {
        window.localStorage.setItem(key, "off");
      } catch {
        // storage blocked: the map then tries online and the external-request check fails loudly
      }
    }, ONLINE_MAPS_KEY);
  });

  for (const route of ROUTES) {
    test(`${route} renders with the DEMO DATA chip and no external requests`, async ({ page }) => {
      const external: string[] = [];
      const errors: string[] = [];
      page.on("request", (req) => {
        const host = new URL(req.url()).hostname;
        if (host !== "127.0.0.1" && host !== "localhost") external.push(req.url());
      });
      page.on("pageerror", (err) => errors.push(String(err)));
      await page.goto(route);
      const chip = page.locator('header [role="status"]').first();
      await expect(chip).toHaveAttribute("data-status", "demo");
      await expect(chip).toHaveText(/DEMO DATA/);
      expect(external).toEqual([]);
      expect(errors).toEqual([]);
    });
  }

  test("/flight shows replayed demo values tagged DEMO, never LIVE", async ({ page }) => {
    await page.goto("/flight");
    await expect(page.getByTestId("aircraft-title")).not.toHaveText("No aircraft loaded");
    await expect(page.getByTestId("live-flight").getByText("DEMO").first()).toBeVisible();
    await expect(page.getByText(/^LIVE/)).toHaveCount(0);
  });

  test("/map draws the offline outline, the demo aircraft and attribution", async ({ page }) => {
    const external: string[] = [];
    const errors: string[] = [];
    page.on("request", (req) => {
      const host = new URL(req.url()).hostname;
      if (host !== "127.0.0.1" && host !== "localhost") external.push(req.url());
    });
    page.on("pageerror", (err) => errors.push(String(err)));
    await page.goto("/map");
    const map = page.getByTestId("ops-map");
    await expect(map).toHaveAttribute("data-ready", "true", { timeout: 30_000 });
    await expect(map.locator("canvas.maplibregl-canvas")).toBeVisible();
    await expect(page.getByTestId("basemap-badge")).toHaveText("Offline outline");
    await expect(page.getByTestId("aircraft-marker")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByTestId("map-destination")).toContainText("KATL");
    // P5 part 2: the demo FBO pin (and the pins toggle hides it).
    await expect(page.getByTestId("map-fbo-pin")).toHaveCount(1, { timeout: 30_000 });
    await expect(page.getByTestId("map-fbo-pin")).toContainText("KLIT");
    await page.getByTestId("pins-toggle").click();
    await expect(page.getByTestId("map-fbo-pin")).toHaveCount(0);
    await expect(page.getByTestId("map-flight-panel").getByText("DEMO")).toBeVisible();
    const attribution = page.locator(".maplibregl-ctrl-attrib");
    await expect(attribution).toContainText("Natural Earth");
    await expect(attribution).toContainText("OurAirports");
    await expect(page.getByText("Waiting for position")).toHaveCount(0);
    // A real WebGL context, not a blank canvas.
    const webgl = await map
      .locator("canvas.maplibregl-canvas")
      .evaluate((c: HTMLCanvasElement) => !!(c.getContext("webgl2") ?? c.getContext("webgl")));
    expect(webgl).toBe(true);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("/settings toggles online maps in this browser", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.locator('header [role="status"]').first()).toHaveAttribute(
      "data-status",
      "demo",
    );
    const toggle = page.getByTestId("online-maps-switch");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), ONLINE_MAPS_KEY);
    expect(stored).toBe("on");
  });

  test("/flight weather: SAMPLE METARs with category chips, raw text and age, no network", async ({
    page,
  }) => {
    const external: string[] = [];
    page.on("request", (req) => {
      const host = new URL(req.url()).hostname;
      if (host !== "127.0.0.1" && host !== "localhost") external.push(req.url());
    });
    await page.goto("/flight");
    const weather = page.getByTestId("route-weather");
    const origin = weather.locator('[data-testid="metar-station"][data-station="KMEM"]');
    const dest = weather.locator('[data-testid="metar-station"][data-station="KATL"]');
    await expect(origin).toHaveAttribute("data-origin", "sample");
    await expect(dest).toHaveAttribute("data-origin", "sample");
    await expect(origin.getByText("SAMPLE", { exact: true })).toBeVisible();
    await expect(dest.getByText("SAMPLE", { exact: true })).toBeVisible();
    await expect(origin.getByTestId("flight-category")).toHaveText("VFR");
    await expect(dest.getByTestId("flight-category")).toHaveText("MVFR");
    await expect(origin.getByTestId("metar-age")).toHaveText(/Observed (\d+ min ago|just now)/);
    await expect(weather.getByTestId("weather-status")).toContainText("not real weather");
    // Raw METAR toggle.
    await expect(origin.getByTestId("metar-raw")).toHaveCount(0);
    await origin.getByTestId("metar-raw-toggle").click();
    await expect(origin.getByTestId("metar-raw")).toHaveText(/^KMEM \d{6}Z 20009KT 10SM/);
    await origin.getByTestId("metar-raw-toggle").click();
    await expect(origin.getByTestId("metar-raw")).toHaveCount(0);
    // Sample weather is never presented as live.
    await expect(weather.locator('[data-metar-origin="live"]')).toHaveCount(0);
    expect(external).toEqual([]);
  });

  test("/jobs job detail shows SAMPLE origin/destination weather", async ({ page }) => {
    await page.goto("/jobs");
    const card = page.getByTestId("job-card").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const destination = await card.getAttribute("data-destination");
    await card.getByTestId("job-weather-toggle").click();
    const weather = card.getByTestId("route-weather");
    await expect(weather.getByTestId("metar-station")).toHaveCount(2);
    await expect(weather.locator('[data-station="KMEM"]')).toHaveAttribute("data-origin", "sample");
    await expect(weather.locator(`[data-station="${destination}"]`)).toHaveAttribute(
      "data-origin",
      "sample",
    );
    await expect(weather.getByTestId("flight-category")).toHaveCount(2);
    for (const chip of await weather.getByTestId("flight-category").all()) {
      await expect(chip).toHaveText(/^(VFR|MVFR|IFR|LIFR)$/);
    }
    await expect(weather.getByText("SAMPLE", { exact: true })).toHaveCount(2);
  });

  test("/settings online weather switch is stored per browser", async ({ page }) => {
    await page.goto("/settings");
    await expect(page.getByTestId("weather-mode")).toHaveText(/Sample METARs \(demo/);
    const toggle = page.getByTestId("online-weather-switch");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    const stored = await page.evaluate(() =>
      window.localStorage.getItem("cargo-ops.weather.online"),
    );
    expect(stored).toBe("off");
  });

  test("/jobs shows DEMO-tagged generated jobs with accept disabled", async ({ page }) => {
    await page.goto("/jobs");
    await expect(page.getByTestId("demo-board-note")).toBeVisible();
    const cards = page.getByTestId("job-card");
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });
    expect(await cards.count()).toBeGreaterThan(3);
    await expect(cards.first()).toContainText("KMEM");
    await expect(cards.first().getByText("DEMO")).toBeVisible();
    const accept = cards.first().getByTestId("accept-job");
    await expect(accept).toBeDisabled();
    await expect(accept).toHaveAttribute("title", /need the local connector/);
    await expect(page.getByTestId("accept-disabled-note")).toBeVisible();
    await expect(page.getByTestId("refresh-board")).toBeDisabled();
    await expect(page.getByTestId("route-finder")).toBeVisible();
  });

  test("/company shows the DEMO company with loans disabled", async ({ page }) => {
    await page.goto("/company");
    await expect(page.getByTestId("demo-company-note")).toBeVisible();
    const cash = page.locator('[data-metric="Cash"]');
    await expect(cash).toHaveAttribute("data-source", "demo", { timeout: 30_000 });
    await expect(cash.getByText("DEMO")).toBeVisible();
    await expect(cash.getByTestId("metric-value")).toHaveText(/^\$\d/);
    await expect(page.getByTestId("ledger-table")).toBeVisible();
    await expect(page.getByTestId("pnl-chart")).toBeVisible();
    await expect(page.getByTestId("dti-gauge")).toBeVisible();
    await expect(page.getByTestId("active-loans")).toContainText("Jetwash Credit");
    await expect(page.getByTestId("take-loan")).toBeDisabled();
    await expect(page.getByTestId("loan-disabled-note")).toBeVisible();
    await expect(page.getByTestId("calc-payment")).toHaveText(/^\$[\d,]+\.\d\d$/);
  });

  test("/fleet shows the DEMO fleet and market with actions disabled", async ({ page }) => {
    await page.goto("/fleet");
    await expect(page.getByTestId("demo-fleet-note")).toBeVisible();
    const cards = page.getByTestId("fleet-card");
    await expect(cards).toHaveCount(3, { timeout: 30_000 });
    await expect(cards.first().getByText("DEMO")).toBeVisible();
    await expect(cards.first().getByTestId("financed-badge")).toBeVisible();
    await expect(cards.nth(1).getByTestId("lease-badge")).toHaveText("Dry lease");
    await expect(cards.first().getByTestId("repair-aircraft")).toBeDisabled();
    await expect(page.getByTestId("fleet-disabled-note")).toBeVisible();
    await page.getByTestId("tab-new-aircraft").click();
    const market = page.getByTestId("market-type");
    expect(await market.count()).toBeGreaterThan(8);
    await expect(market.first().getByTestId("buy-aircraft")).toBeDisabled();
    await expect(market.first().getByTestId("lease-aircraft")).toBeDisabled();
  });

  test("/fleet used market: DEMO-tagged listings, systems and maintenance, actions disabled", async ({
    page,
  }) => {
    await page.goto("/fleet");
    await expect(page.getByTestId("fleet-card")).toHaveCount(3, { timeout: 30_000 });
    // Hangar: the used PC-6 bought in the demo is in the shop with an ETA.
    await expect(page.getByTestId("maintenance-order").first()).toBeVisible();
    await expect(page.getByTestId("maintenance-eta").first()).toContainText("ETA Month");
    await page.getByTestId("show-systems").nth(2).click();
    const systems = page.getByTestId("systems-panel");
    await expect(systems.getByRole("meter")).toHaveCount(10);
    await expect(systems.getByTestId("severity-badge").first()).toBeVisible();
    await expect(systems.getByTestId("repair-all")).toBeDisabled();
    // Used market tab.
    await page.getByTestId("tab-used-market").click();
    await expect(page.getByTestId("market-disabled-note")).toBeVisible();
    const listings = page.getByTestId("listing-card");
    await expect(listings).toHaveCount(12);
    await expect(listings.first().getByText("DEMO")).toBeVisible();
    await expect(listings.first().getByTestId("asking-price")).toHaveText(/^\$[\d,]+$/);
    await expect(listings.first().getByTestId("buy-listing")).toBeDisabled();
    await expect(page.getByTestId("inspect-listing").first()).toBeDisabled();
    await expect(page.getByTestId("market-refresh")).toBeDisabled();
  });

  test("/fbo shows the DEMO FBO with modules, chart and P&L; every action disabled", async ({
    page,
  }) => {
    await page.goto("/fbo");
    await expect(page.getByTestId("demo-fbo-note")).toBeVisible();
    const card = page.getByTestId("fbo-card");
    await expect(card).toHaveCount(1, { timeout: 30_000 });
    await expect(card).toContainText("KLIT");
    await expect(page.getByTestId("fbo-list").getByText("DEMO").first()).toBeVisible();
    await expect(page.getByTestId("fbo-module")).toHaveCount(5);
    await expect(page.getByTestId("fbo-income-chart")).toBeVisible();
    await expect(page.getByTestId("fbo-pnl")).toBeVisible();
    await expect(page.getByTestId("fbo-occupancy")).toContainText("bays");
    for (const b of await page.getByTestId("fbo-module-action").all())
      await expect(b).toBeDisabled();
    await expect(page.getByTestId("fbo-pricing-apply")).toBeDisabled();
    await page.getByTestId("fbo-search").fill("KATL");
    await page.getByTestId("fbo-search-results").getByRole("button").first().click();
    await expect(page.getByTestId("fbo-quote")).toContainText("$774,000");
    await expect(page.getByTestId("fbo-buy")).toBeDisabled();
    await expect(page.getByTestId("fbo-build")).toBeDisabled();
    // Milestones with dates on /company; active events on /jobs.
    await page.goto("/company");
    await expect(page.locator('[data-testid="milestone"][data-reached="true"]')).toHaveCount(3, {
      timeout: 30_000,
    });
    await expect(page.getByTestId("fbo-pnl-lines")).toContainText("KLIT");
  });

  test("/logbook in demo mode has no flights and exports are disabled", async ({ page }) => {
    await page.goto("/logbook");
    await expect(page.getByTestId("export-disabled-note")).toBeVisible();
    await expect(page.getByTestId("export-csv")).toBeDisabled();
    await expect(page.getByTestId("export-json")).toBeDisabled();
    await expect(page.getByTestId("logbook-row")).toHaveCount(0);
  });

  test("keyboard shortcuts: g + letter navigates, ? opens the list, typing is ignored", async ({
    page,
  }) => {
    // Eleven route renders (one of them the map, on software WebGL): allow for a slow runner.
    test.setTimeout(120_000);
    await page.goto("/");
    await expect(page.locator('header [role="status"]').first()).toHaveAttribute(
      "data-status",
      "demo",
    );
    const chords: Array<[string, string, RegExp]> = [
      ["j", "/jobs", /Cargo Jobs/],
      ["e", "/fleet", /Fleet/],
      ["b", "/fbo", /FBOs/],
      ["c", "/company", /Company/],
      ["l", "/logbook", /Every leg/],
      ["m", "/map", /Ops map/],
      ["f", "/flight", /./],
      ["d", "/diagnostics", /Under the hood/],
      ["s", "/settings", /Configure/],
      ["o", "/", /Move the world/],
    ];
    for (const [key, path, heading] of chords) {
      await page.keyboard.press("g");
      await page.keyboard.press(key);
      await expect(page).toHaveURL(new RegExp(`${path === "/" ? "/$" : path}$`));
      // No waiting for the page to settle before the next chord: a route still rendering
      // (the map initialising on software WebGL) must not expire a `g` (see shortcuts.ts).
      await expect(page.getByRole("heading", { level: 1 }).first()).toHaveText(heading);
    }
    await page.keyboard.press("?");
    const dialog = page.getByRole("dialog", { name: "Keyboard shortcuts" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Diagnostics");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // Typing in a field never navigates. Type only after hydration, or React resets the field.
    await page.goto("/jobs");
    await expect(page.locator('header [role="status"]').first()).toHaveAttribute(
      "data-status",
      "demo",
    );
    const field = page.getByLabel("Board airport");
    await field.click();
    await page.keyboard.type("gm");
    await expect(field).toHaveValue("gm");
    await expect(page).toHaveURL(/\/jobs$/);
  });

  test("/settings in demo mode: units stored per browser, data actions need the connector", async ({
    page,
  }) => {
    await page.goto("/settings");
    // Interact only after hydration (the chip turns DEMO from an effect), or clicks are lost.
    await expect(page.locator('header [role="status"]').first()).toHaveAttribute(
      "data-status",
      "demo",
    );
    await expect(page.getByTestId("demo-mode")).toHaveText(/On/);
    await expect(page.getByTestId("token-masked")).toHaveText("none in demo mode");
    await expect(page.getByTestId("backup-now")).toBeDisabled();
    await expect(page.getByTestId("career-export")).toBeDisabled();
    await expect(page.getByTestId("simbrief-import")).toBeDisabled();
    await page.getByTestId("units-panel").getByText("kg", { exact: true }).click();
    await page.getByTestId("units-panel").getByText("m", { exact: true }).click();
    const stored = await page.evaluate(() => window.localStorage.getItem("cargo-ops.units"));
    expect(JSON.parse(stored ?? "{}")).toEqual({ weight: "kg", altitude: "m", speed: "kt" });
    await page.goto("/flight");
    await expect(page.locator('[data-metric="Altitude"]')).toContainText("m");
    await expect(page.locator('[data-metric="Fuel on board"]')).toContainText("kg");
  });
});
