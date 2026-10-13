import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

import { readFileSync } from "node:fs";

import {
  DEMO_COMPANY_SEED,
  airportLookup,
  generateMarket,
  uninspectedHasHiddenGrounding,
  type EconomyAirport,
} from "../packages/economy/src/index";

// P5 acceptance against the real connector, through its API (WebSocket commands from the
// page's own origin + authenticated /api reads), not by racing the UI: a used aircraft
// bought without an inspection whose hidden grounding defect surfaces on the first
// dispatch is refused with the reason, and the repair goes to the maintenance board. The
// full repair → dispatch OK loop runs on in-game time in the connector integration tests.

const AIRPORTS = JSON.parse(
  readFileSync(new URL("../src/assets/data/airports-major.json", import.meta.url), "utf8"),
) as EconomyAirport[];
const lookup = airportLookup(AIRPORTS);

interface Res {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string; reasons?: Array<{ code: string }> };
}

async function token(request: APIRequestContext): Promise<string> {
  const res = await request.get("/api/session");
  expect(res.status()).toBe(200);
  return ((await res.json()) as { token: string }).token;
}

/** Send one command over a WebSocket opened by the page (allowed origin) and await its result. */
async function command(page: Page, tok: string, name: string, args: unknown = {}): Promise<Res> {
  return page.evaluate(
    async ({ tok, name, args }) => {
      const w = window as unknown as { __e2eWs?: Promise<WebSocket> };
      w.__e2eWs ??= new Promise<WebSocket>((resolve, reject) => {
        const ws = new WebSocket(`ws://${location.host}/ws?token=${encodeURIComponent(tok)}`);
        ws.onopen = () => {
          ws.send(
            JSON.stringify({ type: "hello", v: 1, token: tok, client: "web", wants: ["company"] }),
          );
          resolve(ws);
        };
        ws.onerror = () => reject(new Error("ws error"));
      });
      const ws = await w.__e2eWs;
      const id = `e2e-${Math.random().toString(36).slice(2)}`;
      return new Promise((resolve) => {
        const onMsg = (ev: MessageEvent) => {
          const msg = JSON.parse(String(ev.data)) as { type: string; id?: string };
          if (msg.type === "result" && msg.id === id) {
            ws.removeEventListener("message", onMsg);
            resolve(msg as unknown as { ok: boolean });
          }
        };
        ws.addEventListener("message", onMsg);
        ws.send(JSON.stringify({ type: "command", v: 1, id, name, args }));
      });
    },
    { tok, name, args },
  ) as Promise<Res>;
}

test("used aircraft with a hidden grounding defect: first dispatch refused with the reason, repair queued", async ({
  page,
  request,
}) => {
  test.setTimeout(60_000);
  await page.goto("/fleet");
  await expect(page.locator('header [role="status"]').first()).toHaveAttribute(
    "data-status",
    "replay",
  );
  const tok = await token(request);
  const auth = { Authorization: `Bearer ${tok}` };
  const get = async <T>(path: string) =>
    (await (await request.get(path, { headers: auth })).json()) as T;

  // Find (deterministically, from the replay company's seed) a market generation with an
  // affordable listing whose uninspected purchase hides a grounding defect.
  const market = await get<{ generation: number }>("/api/market");
  const company = await get<{ cash: number }>("/api/ledger");
  let refreshes = -1;
  let pick: ReturnType<typeof generateMarket>[number] | undefined;
  for (let k = 0; k < 30 && !pick; k++) {
    pick = generateMarket({
      seed: DEMO_COMPANY_SEED,
      generation: market.generation + k,
      airports: lookup.list,
      base: lookup.get("KMEM"),
      gameMs: 0,
    })
      .filter((l) => l.askingPrice <= 1_000_000 && l.typeKey !== "c208b")
      .find((l) => uninspectedHasHiddenGrounding(DEMO_COMPANY_SEED, l));
    refreshes = k;
  }
  expect(pick).toBeDefined();
  if (!pick) return;
  for (let i = 0; i < refreshes; i++) {
    expect((await command(page, tok, "market.refresh")).ok).toBe(true);
  }
  const listed = await get<{ listings: Array<{ id: string; askingPrice: number }> }>("/api/market");
  expect(listed.listings.find((l) => l.id === pick?.id)?.askingPrice).toBe(pick.askingPrice);

  // Cash for the purchase and the repair: a loan against the starter.
  const fleet0 = await get<{ aircraft: Array<{ id: string; typeKey: string }> }>("/api/fleet");
  const starter = fleet0.aircraft[0]?.id ?? "";
  const loan = await command(page, tok, "loan.take", {
    lenderId: "jetwash",
    principal: 1_800_000,
    termMonths: 24,
    collateral: { type: "aircraft", id: starter },
  });
  expect(loan.ok, JSON.stringify(loan.error)).toBe(true);
  expect(company.cash).toBeGreaterThan(0);

  const bought = await command(page, tok, "market.buy", { listingId: pick.id });
  expect(bought.ok, JSON.stringify(bought.error)).toBe(true);
  const id = (bought.data as { aircraft: { id: string } }).aircraft.id;
  expect((await command(page, tok, "fleet.select", { aircraftId: id })).ok).toBe(true);

  // A board at the aircraft's airport, one job, then the first dispatch.
  expect((await command(page, tok, "jobs.refresh", { airport: pick.location })).ok).toBe(true);
  const jobs = await get<{ available: Array<{ id: string; origin: string }> }>("/api/jobs");
  const job = jobs.available.find((j) => j.origin === pick?.location);
  expect(job).toBeDefined();
  if (!job) return;
  expect((await command(page, tok, "job.accept", { jobId: job.id })).ok).toBe(true);
  const refused = await command(page, tok, "mission.load", { jobIds: [job.id] });
  expect(refused.ok).toBe(false);
  expect(refused.error?.code).toBe("aircraft_unairworthy");
  expect(refused.error?.reasons?.map((r) => r.code)).toContain("grounding_defect");
  expect(refused.error?.message).toMatch(/Grounding defect/);

  const fleet = await get<{
    aircraft: Array<{
      id: string;
      airworthy: boolean;
      airworthiness?: { status: string };
      systems?: Array<{ defects: Array<{ severity: string; cause: string }> }>;
    }>;
    maintenance?: Array<{ aircraftId: string; readyAtGameMs: number }>;
  }>("/api/fleet");
  const a = fleet.aircraft.find((x) => x.id === id);
  expect(a?.airworthy).toBe(false);
  expect(a?.airworthiness?.status).toBe("grounded");
  expect(a?.systems?.flatMap((s) => s.defects).some((d) => d.severity === "grounding")).toBe(true);

  // Repair everything known: the aircraft goes to the maintenance board with an ETA and
  // dispatch is refused until it completes.
  const repair = await command(page, tok, "fleet.repairAll", { aircraftId: id });
  expect(repair.ok, JSON.stringify(repair.error)).toBe(true);
  const after = await get<{ maintenance?: Array<{ aircraftId: string; readyAtGameMs: number }> }>(
    "/api/fleet",
  );
  expect(after.maintenance?.some((o) => o.aircraftId === id && o.readyAtGameMs > 0)).toBe(true);
  const again = await command(page, tok, "mission.load", { jobIds: [job.id] });
  expect(again.error?.code).toBe("aircraft_in_maintenance");

  // The UI shows it too.
  await page.reload();
  await expect(page.getByTestId("maintenance-order").first()).toBeVisible();

  // Leave the shared replay company as the other specs expect it.
  expect((await command(page, tok, "job.release", { jobId: job.id })).ok).toBe(true);
  expect((await command(page, tok, "fleet.select", { aircraftId: null })).ok).toBe(true);
});
