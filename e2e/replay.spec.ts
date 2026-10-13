import { expect, test } from "@playwright/test";

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

  test("/flight shows connector-computed phases and a graded landing", async ({ page }) => {
    // The connector recomputes phases and the touchdown from raw telemetry (FakeSource
    // strips the fixture's authored ones). At 20× a pass lasts ~19 s.
    test.setTimeout(75_000);
    await page.goto("/flight");
    const phase = page.getByTestId("phase-label");
    await expect(phase).toHaveText(
      /Taxi Out|Takeoff|Climb|Cruise|Descent|Approach|Landing|Taxi In|Arrived/,
      {
        timeout: 30_000,
      },
    );
    const grade = page.getByTestId("landing-grade");
    await expect(grade).toHaveText(/^(A\+|A|B|C|D|E|F)$/, { timeout: 60_000 });
    const card = page.getByTestId("landing-card");
    await expect(card.getByTestId("landing-source")).toContainText("Graded by the connector");
    await expect(card.getByText(/Provisional/)).toHaveCount(0);
    await expect(page.getByTestId("flight-summary")).toBeVisible();
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
});
