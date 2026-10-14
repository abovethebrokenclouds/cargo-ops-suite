import type { APIRequestContext } from "@playwright/test";

import { expect, test } from "./replay-fixtures";

import { readFileSync } from "node:fs";

import {
  airportLookup,
  checkPayload,
  computePayout,
  flightWear,
  fuelPrice,
  type EconomyAirport,
} from "../packages/economy/src/index";

const AIRPORTS = JSON.parse(
  readFileSync(new URL("../src/assets/data/airports-major.json", import.meta.url), "utf8"),
) as EconomyAirport[];

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
  aircraftId?: string;
  payout?: { total: number; costs?: Array<{ key: string; amount: number }> };
  landingGrade?: string;
  failure?: { code: string };
  payloadCheck?: { stage: string; status: string; source: string; loadedKg?: number };
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

  // Payload check against the replayed payload stations (Pilot 170 lb + 1,830 lb cargo →
  // 830.1 kg after the pilot), computed by the shared rule, labelled REPLAY.
  const fixtureCheck = checkPayload({
    cargoKg: job.weightKg,
    stations: [
      { name: "Pilot", weightLb: 170 },
      { name: "Cargo Zone A", weightLb: 450 },
      { name: "Cargo Zone B", weightLb: 520 },
      { name: "Cargo Zone C", weightLb: 480 },
      { name: "Cargo Pod", weightLb: 380 },
    ],
    weights: null,
    source: "replay",
    stage: "departure",
    checkedAt: "",
  });
  expect(fixtureCheck.loadedKg).toBe(830.1);
  const strip = page.getByTestId("mission-strip");
  const preview = strip.getByTestId("payload-check");
  await expect(preview).toHaveAttribute("data-stage", "preview");
  await expect(preview).toHaveAttribute("data-source", "replay");
  await expect(preview).toHaveAttribute("data-status", fixtureCheck.status);
  await expect(preview.getByText("REPLAY")).toBeVisible();
  await expect(strip.getByTestId("payload-check-numbers")).toContainText(
    `cargo ${job.weightKg.toLocaleString("en-US")} kg`,
  );
  const mismatch = fixtureCheck.status === "underloaded";

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
    payloadMismatch: mismatch,
  }).total;
  expect(mission?.landingGrade).toBe("B");
  expect(mission?.payloadCheck).toMatchObject({
    stage: "departure",
    source: "replay",
    status: fixtureCheck.status,
    loadedKg: 830.1,
  });
  expect(mission?.payout?.total).toBe(expected);
  // A matching payload pays exactly the board estimate; an underloaded one loses bonuses.
  if (mismatch) expect(mission?.payout?.total).toBeLessThan(job.payoutEstimate);
  else expect(mission?.payout?.total).toBe(job.payoutEstimate);

  const log = (await (await request.get("/api/logbook", { headers: auth })).json()) as {
    flights: Array<{
      mission: { id: string; payout: number | null } | null;
      fuelUsedKg: number | null;
      airborneMin: number | null;
      landing: { peakG: number } | null;
    }>;
  };
  const flight = log.flights.find((f) => f.mission?.id === mission?.id);
  expect(flight?.mission?.payout).toBe(expected);

  // P4: fuel at KATL's price and KATL's landing fee are booked; the ledger balances; the
  // starter C208B moved to KATL and wore by the formula.
  const katl = airportLookup(AIRPORTS).get("KATL");
  if (!katl) throw new Error("KATL");
  const price = fuelPrice(katl, AIRPORTS).usdPerKg;
  const fuelKg = flight?.fuelUsedKg ?? 0;
  const fee = mission?.payout?.costs?.find((c) => c.key === "landing_fee")?.amount;
  const fuel = mission?.payout?.costs?.find((c) => c.key === "fuel")?.amount ?? 0;
  expect(fee).toBe(300);
  expect(Math.abs(fuel - fuelKg * price)).toBeLessThan(0.2); // logbook kg is rounded to 0.1
  const ledger = (await (await request.get("/api/ledger", { headers: auth })).json()) as {
    entries: Array<{ category: string; amount: number; refId: string | null }>;
    balanced: boolean;
    cash: number;
  };
  expect(ledger.balanced).toBe(true);
  const ofMission = ledger.entries.filter((e) => e.refId === mission?.id || e.refId === job.id);
  expect(ofMission.map((e) => [e.category, e.amount]).sort()).toEqual(
    [
      ["fuel", -fuel],
      ["landing_fee", -300],
      ["mission_payout", expected],
    ].sort(),
  );
  // Nothing else moved cash in a fresh replay company: cash = start + payout − costs.
  expect(ledger.cash).toBeCloseTo(250_000 + expected - fuel - 300, 2);
  const fleet = (await (await request.get("/api/fleet", { headers: auth })).json()) as {
    aircraft: Array<{ id: string; location: string; condition: number; cycles: number }>;
  };
  const aircraft = fleet.aircraft.find((a) => a.id === mission?.aircraftId);
  const wear = flightWear({
    airborneMin: flight?.airborneMin ?? 0,
    peakG: flight?.landing?.peakG ?? null,
    overspeedEvents: 0,
    crashed: false,
  }).total;
  expect(wear).toBeGreaterThan(0);
  expect(aircraft?.location).toBe("KATL");
  expect(aircraft?.cycles).toBe(1);
  expect(aircraft?.condition).toBeCloseTo(100 - wear, 2);

  await page.goto("/logbook");
  const formatted = `$${expected.toLocaleString("en-US")}`;
  await expect(page.getByTestId("logbook-payout").filter({ hasText: formatted })).toHaveCount(1);
  const row = page.getByTestId("logbook-row").filter({ hasText: formatted });
  const pill = row.getByTestId("payload-check-pill");
  await expect(pill).toHaveAttribute("data-status", fixtureCheck.status);
  await expect(pill).toHaveAttribute("data-source", "replay");
  await expect(pill.getByText("REPLAY")).toBeVisible();
  await expect(page.getByTestId("export-csv")).toBeEnabled();
  const csv = await request.get("/api/export/csv", { headers: auth });
  expect(csv.status()).toBe(200);
  expect(await csv.text()).toContain(`,delivered,${expected},${fixtureCheck.status}`);
});

test("cargo /api routes require the bearer token", async ({ request }) => {
  for (const path of [
    "/api/jobs",
    "/api/missions",
    "/api/logbook",
    "/api/export/json",
    "/api/ledger",
    "/api/fleet",
    "/api/loans",
  ]) {
    expect((await request.get(path)).status()).toBe(401);
  }
});
