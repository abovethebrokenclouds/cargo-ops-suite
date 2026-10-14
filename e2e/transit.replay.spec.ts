import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "./replay-fixtures";

// Transit cargo (docs/ECONOMY.md "Transit cargo") through the UI and the real connector:
// a KMEM → KRDU job is loaded on a leg to KATL ("Leg to"), flown by the replayed (synthetic)
// KMEM → KATL fixture, and must then wait at KATL in transit, unpaid, with its location and
// company-clock deadline on /jobs and a transit pin on /map. The replay only ever flies
// KMEM → KATL, so the onward leg is covered by the connector's two-leg replay test
// (connector/test/transit.test.ts), not here.

interface MissionLite {
  id: string;
  status: string;
  destination: string;
  jobIds: string[];
  transitJobIds?: string[];
  payout?: { total: number };
}

interface JobLite {
  id: string;
  status: string;
  destination: string;
  transit?: { location: string; deadlineGameMs: number; legs: unknown[] };
}

async function token(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/session");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

test("a KRDU job flown to KATL waits there in transit: /jobs and /map show it", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await page.goto("/jobs");
  await expect(page.locator('header [role="status"]').first()).toHaveAttribute(
    "data-status",
    "replay",
  );
  await page.getByLabel("Board airport").fill("KMEM");
  await page.getByLabel("Jobs to (optional)").fill("KRDU");
  await page.getByTestId("refresh-board").click();
  await expect(page.getByTestId("command-message")).toHaveText("Board refreshed");
  const card = page.locator('[data-testid="job-card"][data-destination="KRDU"]').first();
  await expect(card).toBeVisible();
  const jobId = await card.getAttribute("data-job-id");
  expect(jobId).toBeTruthy();
  if (!jobId) return;
  await card.getByTestId("accept-job").click();
  await expect(page.getByTestId("command-message")).toHaveText(`Accepted ${jobId}`);

  await page.getByLabel(`Select ${jobId}`).check();
  await page.getByTestId("leg-destination").fill("katl");
  await page.getByTestId("load-mission").click();
  await expect(page.getByTestId("command-message")).toContainText("Mission loaded to KATL");
  await expect(page.getByTestId("mission-strip-transit")).toContainText(
    "Transit leg: 1 job goes beyond KATL",
  );

  const auth = { Authorization: `Bearer ${await token(request)}` };
  // The connector's boards also carry long-haul jobs (beyond one leg) that need a stop.
  const board = (await (await request.get("/api/jobs", { headers: auth })).json()) as {
    available: Array<{ origin: string; longHaul?: boolean }>;
  };
  expect(board.available.filter((j) => j.origin === "KMEM" && j.longHaul)).toHaveLength(2);

  let mission: MissionLite | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/missions", { headers: auth });
        const body = (await res.json()) as { missions: MissionLite[] };
        mission = body.missions.find((m) => m.jobIds.includes(jobId));
        return mission?.status;
      },
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe("delivered");
  expect(mission?.destination).toBe("KATL");
  expect(mission?.transitJobIds).toEqual([jobId]);
  expect(mission?.payout?.total).toBe(0); // paid only on the final delivery

  const jobs = (await (await request.get("/api/jobs", { headers: auth })).json()) as {
    accepted: JobLite[];
    inTransit: JobLite[];
  };
  const stored = jobs.inTransit.find((j) => j.id === jobId);
  expect(stored?.status).toBe("in_transit");
  expect(stored?.destination).toBe("KRDU");
  expect(stored?.transit?.location).toBe("KATL");
  expect(stored?.transit?.legs).toHaveLength(1);
  expect(jobs.accepted.some((j) => j.id === jobId)).toBe(false);
  // No payout row for the job yet.
  const ledger = (await (await request.get("/api/ledger", { headers: auth })).json()) as {
    entries: Array<{ category: string; refId: string | null }>;
    balanced: boolean;
  };
  expect(ledger.balanced).toBe(true);
  expect(ledger.entries.some((e) => e.category === "mission_payout" && e.refId === jobId)).toBe(
    false,
  );

  // /jobs: the stored cargo with its location, final destination and deadline (REPLAY).
  const row = page.locator(`[data-testid="transit-job"][data-job-id="${jobId}"]`);
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row).toHaveAttribute("data-location", "KATL");
  await expect(row.getByTestId("transit-location")).toHaveText("at KATL");
  await expect(row).toContainText("KRDU");
  await expect(row.getByTestId("transit-deadline")).toContainText(/Due Month \d+ · Day \d+/);
  const panel = page.locator("section", { has: page.getByTestId("transit-jobs") });
  await expect(panel.getByText("REPLAY")).toBeVisible();

  // /map: one transit pin at KATL whose hover text names the job, KRDU and the deadline.
  await page.goto("/map");
  const pin = page.getByTestId("map-transit-pin");
  await expect(pin).toHaveCount(1, { timeout: 30_000 });
  await expect(pin).toContainText("KATL · 1 in transit");
  await expect(pin).toHaveAttribute("title", new RegExp(`${jobId} → KRDU, Due Month`));
  await page.getByTestId("pins-toggle").click();
  await expect(pin).toHaveCount(0);
});
