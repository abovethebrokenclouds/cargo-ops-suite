import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "./replay-fixtures";

// P6 against the real connector (own instance, fresh data dir): the /settings Data section
// (backup created and listed through the API and the page, token masked), the PWA manifest
// and icons served same-origin with the right content types, SimBrief off by default, and
// `f` toggling map follow. No request ever goes to simbrief.com here.

async function token(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/session");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

test("settings data section: backup now lists the backup; the token is masked", async ({
  page,
  request,
}) => {
  const tok = await token(request);
  const auth = { Authorization: `Bearer ${tok}` };
  await page.goto("/settings");
  await expect(page.locator('header [role="status"]').first()).toHaveAttribute(
    "data-status",
    "replay",
  );
  await expect(page.getByTestId("demo-mode")).toHaveText(/Off/);
  await expect(page.getByTestId("connector-status")).toHaveText(/Replay/);

  // Masked: only the last 4 characters, never the whole token anywhere in the page.
  const masked = page.getByTestId("token-masked");
  await expect(masked).toHaveText(new RegExp(`•+${tok.slice(-4)}$`));
  expect(await page.content()).not.toContain(tok);

  // No backups yet for a replay (daily backups are for the career database only).
  const before = (await (await request.get("/api/backups", { headers: auth })).json()) as {
    backups: unknown[];
    database: string;
    keep: number;
  };
  expect(before.backups).toEqual([]);
  expect(before.database).toBe("demo");
  expect(before.keep).toBe(14);

  await page.getByTestId("backup-now").click();
  await expect(page.getByTestId("data-panel")).toContainText(
    /Backup written: demo-\d{8}-\d{6}\.db/,
  );
  const row = page.getByTestId("backup-row").first();
  await expect(row).toBeVisible();
  const name = await row.getAttribute("data-name");
  expect(name).toMatch(/^demo-\d{8}-\d{6}\.db$/);

  const after = (await (await request.get("/api/backups", { headers: auth })).json()) as {
    backups: Array<{ name: string; kind: string; sizeBytes: number }>;
  };
  expect(after.backups.map((b) => b.name)).toEqual([name]);
  expect(after.backups[0]?.kind).toBe("manual");
  expect(after.backups[0]?.sizeBytes).toBeGreaterThan(0);
  await page.getByText("Restore a backup").click();
  await expect(page.getByTestId("restore-steps")).toContainText("Stop the connector");

  // Without the token the API refuses.
  expect((await request.get("/api/backups")).status()).toBe(401);
  expect((await request.post("/api/backups")).status()).toBe(401);
});

test("SimBrief import is off by default and needs the player's own account", async ({
  page,
  request,
}) => {
  const tok = await token(request);
  const sb = (await (
    await request.get("/api/simbrief", { headers: { Authorization: `Bearer ${tok}` } })
  ).json()) as { settings: { enabled: boolean; username: string | null }; plan: unknown };
  expect(sb.settings).toEqual({ enabled: false, username: null, userId: null });
  expect(sb.plan).toBeNull();
  await page.goto("/settings");
  const panel = page.getByTestId("simbrief-panel");
  await expect(panel).toContainText("your own free SimBrief account");
  await expect(panel).toContainText("sends your SimBrief username");
  await expect(page.getByTestId("simbrief-enabled")).toHaveAttribute("aria-checked", "false");
  await expect(page.getByTestId("simbrief-import")).toBeDisabled();
  // Refused server-side too, without any network request.
  const refused = await request.post("/api/simbrief/import", {
    headers: { Authorization: `Bearer ${tok}` },
  });
  expect(refused.status()).toBe(409);
  expect(((await refused.json()) as { error: string }).error).toBe("simbrief_disabled");
});

test("PWA: manifest and icons served same-origin with the right content types", async ({
  page,
  request,
}) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.status()).toBe(200);
  expect(manifest.headers()["content-type"]).toBe("application/manifest+json; charset=utf-8");
  const body = (await manifest.json()) as {
    display: string;
    start_url: string;
    icons: Array<{ src: string; type: string }>;
  };
  expect(body.display).toBe("standalone");
  expect(body.start_url).toBe("/");
  for (const icon of body.icons) {
    const res = await request.get(icon.src);
    expect(res.status(), icon.src).toBe(200);
    expect(res.headers()["content-type"]).toBe(icon.type);
  }
  await page.goto("/");
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
  await expect(page.locator('meta[name="theme-color"]')).toHaveAttribute("content", "#030713");
});

test("f toggles map follow on /map; g + letter navigates the local build", async ({ page }) => {
  await page.goto("/map");
  const follow = page.getByTestId("follow-toggle");
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("f");
  await expect(follow).toHaveAttribute("aria-pressed", "false");
  await page.keyboard.press("f");
  await expect(follow).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("g");
  await page.keyboard.press("s");
  await expect(page).toHaveURL(/\/settings$/);
});
