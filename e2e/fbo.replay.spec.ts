import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "./replay-fixtures";

// P5 part 2 acceptance against the real connector ("FBO income accrues from a replayed
// arrival"): buy the FBO at KATL through the API, fly the replayed KMEM→KATL mission, and
// assert the own-arrival FBO transactions (fuel at the farm's cost, landing fee waived)
// and the waived landing fee on the mission. The 20× replay loops and clears the flight
// about a second after arrival, so everything is asserted through the API.
//
// Like every replay spec it runs against its own connector with a fresh company
// (e2e/replay-fixtures.ts), so it no longer has to run last.

interface Res {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
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

interface MissionLite {
  id: string;
  status: string;
  jobIds: string[];
  payout?: { total: number; costs?: Array<{ key: string; amount: number; note?: string }> };
}

test("buy an FBO at KATL, fly the replayed mission there: own-arrival FBO transactions", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await page.goto("/fbo");
  await expect(page.locator('header [role="status"]').first()).toHaveAttribute(
    "data-status",
    "replay",
  );
  const tok = await token(request);
  const auth = { Authorization: `Bearer ${tok}` };
  const get = async <T>(path: string) =>
    (await (await request.get(path, { headers: auth })).json()) as T;

  // The quote the UI shows comes from the same formula.
  const quote = await get<{ buyPrice: number }>("/api/fbos/quote?icao=KATL");
  expect(quote.buyPrice).toBe(774_000);

  // A C208B parked at KMEM for the replay (independent of where the starter aircraft is).
  const lease = await command(page, tok, "fleet.lease", {
    typeKey: "c208b",
    kind: "dry",
    airport: "KMEM",
  });
  expect(lease.ok, JSON.stringify(lease.error)).toBe(true);
  const aircraftId = (lease.data as { id: string }).id;
  expect((await command(page, tok, "fleet.select", { aircraftId })).ok).toBe(true);

  // Buy with cash, else financed by the first lender that agrees.
  let bought = await command(page, tok, "fbo.buy", { icao: "KATL" });
  if (!bought.ok) {
    const loans = await get<{
      offers: Array<{
        lenderId: string;
        eligible: boolean;
        maxLtv: number;
        minTermMonths: number;
        maxTermMonths: number;
      }>;
    }>("/api/loans");
    for (const o of loans.offers.filter((x) => x.eligible)) {
      bought = await command(page, tok, "fbo.buy", {
        icao: "KATL",
        financing: {
          lenderId: o.lenderId,
          termMonths: Math.max(o.minTermMonths, Math.min(60, o.maxTermMonths)),
          principal: Math.floor((774_000 * o.maxLtv) / 1_000) * 1_000,
        },
      });
      if (bought.ok) break;
    }
  }
  expect(bought.ok, JSON.stringify(bought.error)).toBe(true);
  const fboId = (bought.data as { fbo: { id: string } }).fbo.id;
  await page.reload();
  const card = page.getByTestId("fbo-card");
  await expect(card).toContainText("KATL");
  await expect(page.getByTestId("fbo-list").getByText("REPLAY").first()).toBeVisible();

  // A board at KMEM with jobs to KATL; accept one and load it on the leased aircraft.
  expect(
    (await command(page, tok, "jobs.refresh", { airport: "KMEM", destination: "KATL" })).ok,
  ).toBe(true);
  const jobs = await get<{
    available: Array<{ id: string; destination: string; weightKg: number }>;
  }>("/api/jobs");
  const job = jobs.available.find((j) => j.destination === "KATL");
  expect(job).toBeDefined();
  if (!job) return;
  expect((await command(page, tok, "job.accept", { jobId: job.id })).ok).toBe(true);
  const loaded = await command(page, tok, "mission.load", { jobIds: [job.id] });
  expect(loaded.ok, JSON.stringify(loaded.error)).toBe(true);

  let mission: MissionLite | undefined;
  await expect
    .poll(
      async () => {
        const body = await get<{ missions: MissionLite[] }>("/api/missions");
        mission = body.missions.find((m) => m.jobIds.includes(job.id));
        return mission?.status;
      },
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe("delivered");

  // Own arrival at the FBO: the landing fee is waived, fuel is billed at the farm's cost.
  const fee = mission?.payout?.costs?.find((c) => c.key === "landing_fee");
  expect(fee?.amount).toBe(0);
  expect(mission?.payout?.costs?.find((c) => c.key === "fuel")?.note).toContain("own fuel farm");
  const fbos = await get<{
    fbos: Array<{ id: string; today: { own: number } }>;
    transactions: Array<{ fboId: string; kind: string; amount: number; source: string }>;
  }>(`/api/fbos?fbo=${fboId}`);
  const own = fbos.transactions.filter((t) => t.fboId === fboId && t.source === "own");
  expect(own.map((t) => t.kind).sort()).toEqual(["fuel_at_cost", "landing_fee_waived"]);
  expect(own.find((t) => t.kind === "landing_fee_waived")?.amount).toBe(300);
  expect(own.find((t) => t.kind === "fuel_at_cost")?.amount).toBeGreaterThan(0);
  const ledger = await get<{ balanced: boolean }>("/api/ledger");
  expect(ledger.balanced).toBe(true);
});
