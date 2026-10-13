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

  test("/diagnostics reports the replay welcome", async ({ page }) => {
    await page.goto("/diagnostics");
    await expect(page.getByTestId("diagnostics")).toContainText(/replay/i);
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
