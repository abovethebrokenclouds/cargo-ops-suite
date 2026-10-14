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

  test("/ flight operations room: front wall, lamps and loop tagged DEMO, nothing lit without a tag", async ({
    page,
  }) => {
    const external: string[] = [];
    page.on("request", (req) => {
      const host = new URL(req.url()).hostname;
      if (host !== "127.0.0.1" && host !== "localhost") external.push(req.url());
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(/Flight Operations/);
    const wall = page.getByTestId("front-wall");
    await expect(wall.locator("[data-source-tag]").first()).toHaveText("DEMO");
    await expect(page.getByTestId("readout-phase-value")).not.toHaveText("—");
    await expect(page.getByTestId("readout-met-value")).toHaveText(/^T\+\d{2}:\d{2}:\d{2}$/);
    await expect(page.getByTestId("readout-utc-value")).toHaveText(/^\d{2}:\d{2}:\d{2}Z$/);
    await expect(page.getByTestId("ops-map")).toHaveAttribute("data-ready", "true", {
      timeout: 30_000,
    });
    // The wall frames the whole route: both ends (KMEM, KATL) and the aircraft on screen.
    const frame = page.getByTestId("front-wall-map-frame");
    await expect(frame).toHaveAttribute("data-route-framed", "true", { timeout: 30_000 });
    await expect(frame.getByTestId("aircraft-marker")).toBeVisible({ timeout: 15_000 });
    // fitBounds may still be easing: poll until every marker sits inside the wall map.
    await expect
      .poll(
        async () => {
          const box = await frame.boundingBox();
          if (!box) return false;
          for (const id of ["map-origin", "map-destination", "aircraft-marker"]) {
            const m = await frame.getByTestId(id).boundingBox();
            if (!m) return false;
            const cx = m.x + m.width / 2;
            const cy = m.y + m.height / 2;
            if (cx < box.x || cx > box.x + box.width || cy < box.y || cy > box.y + box.height) {
              return false;
            }
          }
          return true;
        },
        { timeout: 15_000 },
      )
      .toBe(true);
    await expect(frame.getByTestId("map-destination")).toContainText("KATL");

    // Status board: the demo link is HOLD (never GO), and every lit lamp says where its
    // data came from (DEMO, or SAMPLE weather); NO DATA lamps carry no tag.
    const board = page.getByTestId("go-nogo-board");
    const link = board.locator('[data-lamp="link"]');
    await expect(link).toHaveAttribute("data-state", "hold");
    await expect(link.getByTestId("lamp-value")).toHaveText("DEMO");
    await expect(board.getByTestId("lamp")).toHaveCount(10);
    await expect(board.locator('[data-lamp="wx"]')).not.toHaveAttribute("data-state", "nodata");
    for (const lamp of await board.getByTestId("lamp").all()) {
      const state = await lamp.getAttribute("data-state");
      const tags = lamp.locator("[data-source-tag], [data-metar-origin]");
      if (state === "nodata") {
        await expect(lamp.getByTestId("lamp-value")).toHaveText(/NO DATA|UNKNOWN/);
        await expect(tags).toHaveCount(0);
      } else {
        await expect(tags).toHaveCount(1);
        await expect(tags).toHaveText(/^(DEMO|SAMPLE)$/);
      }
    }
    // The payload lamp has no mission in the demo: grey.
    await expect(board.locator('[data-lamp="payload"]')).toHaveAttribute("data-state", "nodata");

    // The loop shows the demo's real fixture events, each tagged DEMO.
    const line = page.getByTestId("loop-line").first();
    await expect(line).toBeVisible({ timeout: 30_000 });
    await expect(line).toHaveAttribute("data-source", "demo");
    await expect(line.getByText("DEMO")).toBeVisible();
    await expect(
      page.getByTestId("console-finance").getByTestId("dashboard-reputation"),
    ).toBeVisible();
    await expect(page.getByText(/^LIVE/)).toHaveCount(0);
    expect(external).toEqual([]);
  });

  test("/ flight operations room collapses to one column on a phone", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/");
    await expect(page.getByTestId("go-nogo-board")).toBeVisible();
    await expect(page.getByTestId("ops-map")).toHaveAttribute("data-ready", "true", {
      timeout: 30_000,
    });
    const width = await page.evaluate(() => document.documentElement.scrollWidth);
    expect(width).toBeLessThanOrEqual(390);
    // Both consoles are measured in one layout snapshot: two separate boundingBox() reads
    // can straddle a reflow while late demo data grows a console, and overlap falsely.
    const stacked = () =>
      page.evaluate(() => {
        const nav = document.querySelector('[data-testid="console-nav"]')?.getBoundingClientRect();
        const perf = document
          .querySelector('[data-testid="console-perf"]')
          ?.getBoundingClientRect();
        return Boolean(nav && perf && perf.top > nav.bottom - 1);
      });
    await expect.poll(stacked).toBe(true);
  });

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
    // Destination TAF timeline: SAMPLE, a category per period, raw text.
    const taf = weather.getByTestId("taf-timeline");
    await expect(taf).toHaveAttribute("data-station", "KATL");
    await expect(taf).toHaveAttribute("data-origin", "sample");
    await expect(taf.getByText("SAMPLE", { exact: true })).toBeVisible();
    await expect(taf.getByTestId("taf-source")).toContainText("not a real forecast");
    const periods = taf.getByTestId("taf-period");
    await expect(periods).toHaveCount(4);
    for (const p of await periods.all()) {
      await expect(p).toHaveAttribute("data-category", /^(VFR|MVFR|IFR|LIFR)$/);
    }
    await expect(taf.getByTestId("taf-segment").first()).toBeVisible();
    await taf.getByTestId("taf-raw-toggle").click();
    await expect(taf.getByTestId("taf-raw")).toHaveText(/^TAF KATL \d{6}Z \d{4}\/\d{4} /);
    expect(external).toEqual([]);
  });

  test("/map METAR badges: SAMPLE flight-category dots with a raw-METAR tooltip, no network", async ({
    page,
  }) => {
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
    await expect(page.getByTestId("map-destination")).toContainText("KATL", { timeout: 15_000 });
    // Both route ends carry a badge; the layer got one feature per badge.
    const legend = page.getByTestId("metar-legend");
    await expect(legend).toBeVisible({ timeout: 15_000 });
    await expect(legend.getByText("SAMPLE", { exact: true })).toBeVisible();
    const mem = legend.locator('[data-testid="metar-badge"][data-station="KMEM"]');
    const atl = legend.locator('[data-testid="metar-badge"][data-station="KATL"]');
    await expect(mem).toHaveAttribute("data-category", "VFR");
    await expect(atl).toHaveAttribute("data-category", "MVFR");
    await expect(legend.getByTestId("metar-badge")).toHaveCount(2);
    for (const b of await legend.getByTestId("metar-badge").all()) {
      await expect(b).toHaveAttribute("data-origin", "sample");
    }
    await expect(map).toHaveAttribute("data-metar-features", "2");
    // Tooltip: raw METAR, age and the SAMPLE tag.
    await atl.click();
    const popup = page.getByTestId("metar-popup");
    await expect(popup).toBeVisible();
    await expect(popup).toHaveAttribute("data-station", "KATL");
    await expect(popup).toContainText(/KATL \d{6}Z 24012G20KT/);
    await expect(popup.getByText("SAMPLE", { exact: true })).toBeVisible();
    await expect(popup.getByTestId("metar-popup-age")).toHaveText(
      /Observed (\d+ min ago|just now).*not real weather/,
    );
    await expect(popup.locator('[data-metar-origin="live"]')).toHaveCount(0);
    // The weather layer toggle hides badges and tooltip.
    await page.getByTestId("weather-toggle").click();
    await expect(legend).toHaveCount(0);
    await expect(popup).toHaveCount(0);
    expect(external).toEqual([]);
    expect(errors).toEqual([]);
  });

  test("/jobs job detail shows SAMPLE origin/destination weather", async ({ page }) => {
    await page.goto("/jobs");
    const card = page.getByTestId("job-card").first();
    await expect(card).toBeVisible({ timeout: 30_000 });
    const destination = await card.getAttribute("data-destination");
    await card.getByTestId("job-weather-toggle").click();
    const weather = card.getByTestId("route-weather");
    const metar = weather.getByTestId("metar-station");
    await expect(metar).toHaveCount(2);
    await expect(metar.and(page.locator('[data-station="KMEM"]'))).toHaveAttribute(
      "data-origin",
      "sample",
    );
    await expect(metar.and(page.locator(`[data-station="${destination}"]`))).toHaveAttribute(
      "data-origin",
      "sample",
    );
    const chips = metar.getByTestId("flight-category");
    await expect(chips).toHaveCount(2);
    for (const chip of await chips.all()) {
      await expect(chip).toHaveText(/^(VFR|MVFR|IFR|LIFR)$/);
    }
    await expect(metar.getByText("SAMPLE", { exact: true })).toHaveCount(2);
    // The destination's SAMPLE TAF sits under the two METARs.
    const taf = weather.getByTestId("taf-timeline");
    await expect(taf).toHaveAttribute("data-station", destination ?? "");
    await expect(taf).toHaveAttribute("data-origin", "sample");
    await expect(taf.getByText("SAMPLE", { exact: true })).toBeVisible();
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

  test("/fleet hired pilots: a DEMO pilot labelled simulated, every action disabled", async ({
    page,
  }) => {
    await page.goto("/fleet");
    await expect(page.getByTestId("fleet-card")).toHaveCount(3, { timeout: 30_000 });
    await page.getByTestId("tab-hired-pilots").click();
    await expect(page.getByTestId("pilots-disabled-note")).toBeVisible();
    const card = page.getByTestId("pilot-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("simulated-tag")).toHaveText("Hired pilot (simulated)");
    await expect(card.getByText("DEMO")).toBeVisible();
    await expect(card.getByTestId("pilot-route")).toContainText("KMEM ⇄ KBNA");
    await expect(card.getByTestId("pilot-pnl")).toBeVisible();
    await expect(page.getByTestId("hire-pilot")).toBeDisabled();
    await expect(card.getByTestId("unassign-pilot")).toBeDisabled();
    await expect(card.getByTestId("fire-pilot")).toBeDisabled();
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
      ["o", "/", /Flight Operations/],
    ];
    for (const [key, path, heading] of chords) {
      // One action for the chord, as a person types it. Two separate press() calls let the
      // runner pause between g and the letter: with tracing on, Playwright snapshots the DOM
      // after every action, and on a busy page (the dashboard just hydrated, the map) that
      // snapshot alone took over 1.5 s, so the chord rightly expired before the letter.
      await page.keyboard.type(`g${key}`);
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
