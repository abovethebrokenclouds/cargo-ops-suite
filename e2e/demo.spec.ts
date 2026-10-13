import { expect, test } from "@playwright/test";

const ROUTES = [
  "/",
  "/flight",
  "/map",
  "/jobs",
  "/fleet",
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
    const toggle = page.getByTestId("online-maps-switch");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    const stored = await page.evaluate((key) => window.localStorage.getItem(key), ONLINE_MAPS_KEY);
    expect(stored).toBe("on");
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

  test("/logbook in demo mode has no flights and exports are disabled", async ({ page }) => {
    await page.goto("/logbook");
    await expect(page.getByTestId("export-disabled-note")).toBeVisible();
    await expect(page.getByTestId("export-csv")).toBeDisabled();
    await expect(page.getByTestId("export-json")).toBeDisabled();
    await expect(page.getByTestId("logbook-row")).toHaveCount(0);
  });
});
