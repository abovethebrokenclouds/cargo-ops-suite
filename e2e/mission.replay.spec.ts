import { expect, test, type APIRequestContext } from "@playwright/test";

import { computePayout } from "../packages/economy/src/index";

// P3 acceptance (plan §5): a full replayed mission completes end to end. The connector
// replays demo-kmem-katl.jsonl at 20× in a loop; a mission loaded at any point starts
// at the next block-out from KMEM (the replay restarts parked at KMEM with the brake
// set) and is delivered at KATL. A new replay pass clears the flight about a second
// after arrival, so the payout is asserted through the API and the persisted logbook,
// not by racing the live UI.

interface MissionLite {
  id: string;
  status: string;
  jobIds: string[];
  payout?: { total: number };
  landingGrade?: string;
  failure?: { code: string };
}

async function token(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/session");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

test("accept → load → fly (replay) → deliver: payout in the API and the logbook", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await page.goto("/jobs");
  await expect(page.locator('header [role="status"]').first()).toHaveAttribute(
    "data-status",
    "replay",
  );
  // Ask the connector for a board at KMEM with jobs to KATL.
  await page.getByLabel("Board airport").fill("KMEM");
  await page.getByLabel("Jobs to (optional)").fill("KATL");
  await page.getByTestId("refresh-board").click();
  await expect(page.getByTestId("command-message")).toHaveText("Board refreshed");
  const card = page.locator('[data-testid="job-card"][data-destination="KATL"]').first();
  await expect(card).toBeVisible();
  await expect(card.getByText("REPLAY")).toBeVisible();
  const jobId = await card.getAttribute("data-job-id");
  expect(jobId).toBeTruthy();
  await card.getByTestId("accept-job").click();
  await expect(page.getByTestId("command-message")).toHaveText(`Accepted ${jobId}`);

  const auth = { Authorization: `Bearer ${await token(request)}` };
  const jobs = (await (await request.get("/api/jobs", { headers: auth })).json()) as {
    accepted: Array<{
      id: string;
      kind: "cargo";
      weightKg: number;
      distanceNm: number;
      units: number;
      payoutEstimate: number;
    }>;
  };
  const job = jobs.accepted.find((j) => j.id === jobId);
  expect(job).toBeDefined();
  if (!job) return;

  await page.getByLabel(`Select ${jobId}`).check();
  await page.getByTestId("load-mission").click();
  await expect(page.getByTestId("command-message")).toContainText("Mission loaded");
  await expect(page.getByTestId("mission-strip")).toBeVisible();

  // Wait for delivery (next block-out from KMEM, then arrival at KATL).
  let mission: MissionLite | undefined;
  await expect
    .poll(
      async () => {
        const res = await request.get("/api/missions", { headers: auth });
        const body = (await res.json()) as { missions: MissionLite[] };
        mission = body.missions.find((m) => m.jobIds.includes(job.id));
        return mission?.status;
      },
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe("delivered");

  // Landing B, on time, reputation 50 (tier 2): the formula and the board estimate agree.
  const expected = computePayout({
    kind: job.kind,
    weightKg: job.weightKg,
    distanceNm: job.distanceNm,
    units: job.units,
    reputation: 50,
    estimate: false,
    landingGrade: "B",
    lateMin: 0,
  }).total;
  expect(mission?.landingGrade).toBe("B");
  expect(mission?.payout?.total).toBe(expected);
  expect(mission?.payout?.total).toBe(job.payoutEstimate);

  const log = (await (await request.get("/api/logbook", { headers: auth })).json()) as {
    flights: Array<{ mission: { id: string; payout: number | null } | null }>;
  };
  expect(log.flights.find((f) => f.mission?.id === mission?.id)?.mission?.payout).toBe(expected);

  await page.goto("/logbook");
  const formatted = `$${expected.toLocaleString("en-US")}`;
  await expect(page.getByTestId("logbook-payout").filter({ hasText: formatted })).toHaveCount(1);
  await expect(page.getByTestId("export-csv")).toBeEnabled();
  const csv = await request.get("/api/export/csv", { headers: auth });
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain(`,delivered,${expected}`);
});

test("cargo /api routes require the bearer token", async ({ request }) => {
  for (const path of ["/api/jobs", "/api/missions", "/api/logbook", "/api/export/json"]) {
    expect((await request.get(path)).status()).toBe(401);
  }
});
