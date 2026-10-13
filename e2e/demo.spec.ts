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

test.describe("demo mode (no connector)", () => {
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
});
