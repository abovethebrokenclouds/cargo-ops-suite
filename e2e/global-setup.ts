import { chromium, type FullConfig } from "@playwright/test";

// Load the heaviest routes once and wait for the app to hydrate before any test runs, so the
// tests measure the app rather than one-time warm-up: the first SSR render loads the server
// chunks, and with E2E_DEMO_DEV=1 the Vite dev server pre-bundles dependencies (MapLibre
// among them) on its first page load.
export default async function globalSetup(config: FullConfig) {
  const demo = config.projects.find((p) => p.name === "demo");
  const baseURL = demo?.use.baseURL;
  if (!baseURL) return;
  const launch = config.projects[0]?.use.launchOptions ?? {};
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage();
    for (const route of ["/", "/flight", "/map"]) {
      await page.goto(`${baseURL}${route}`, { timeout: 120_000 });
      await page
        .locator('header [role="status"][data-status="demo"]')
        .first()
        .waitFor({ timeout: 120_000 });
    }
  } finally {
    await browser.close();
  }
}
