import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "./replay-fixtures";

// Hired pilots (plan §7.4) against the real connector: hire a pilot and assign the starter
// aircraft to a route through the /fleet UI, see it labelled "Hired pilot (simulated)" with
// the REPLAY source tag, have mission.load on that aircraft refused with the reason, then
// unassign it in the UI. Money and the ledger are read from the authenticated API. The legs
// themselves run on in-game time; their booking is covered by the connector integration
// tests (connector/test/hired-pilots.test.ts).

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

test("hire a pilot, assign the starter in the UI: simulated label, mission.load refused, unassign", async ({
  page,
  request,
}) => {
  test.setTimeout(90_000);
  await page.goto("/fleet");
  await expect(page.locator('header [role="status"]').first()).toHaveAttribute(
    "data-status",
    "replay",
  );
  const tok = await token(request);
  const auth = { Authorization: `Bearer ${tok}` };
  const get = async <T>(path: string) =>
    (await (await request.get(path, { headers: auth })).json()) as T;

  await page.getByTestId("tab-hired-pilots").click();
  await expect(page.getByTestId("no-pilots")).toBeVisible();
  await page.getByTestId("hire-pilot").click();
  await expect(page.getByTestId("command-message")).toContainText("Hired a Turboprop pilot");
  const card = page.getByTestId("pilot-card");
  await expect(card).toHaveCount(1);
  await expect(card.getByTestId("simulated-tag")).toHaveText("Hired pilot (simulated)");
  await expect(card.getByText("REPLAY")).toBeVisible();
  await expect(card.getByTestId("pilot-status")).toHaveText("Unassigned");

  // Assign the starter (parked at the base) to the first destination offered.
  await expect(card.getByTestId("pilot-aircraft")).toBeEnabled();
  await expect(card.getByTestId("pilot-destination")).toBeEnabled();
  const dest = await card.getByTestId("pilot-destination").inputValue();
  expect(dest).toMatch(/^[A-Z0-9]{3,4}$/);
  await card.getByTestId("assign-pilot").click();
  await expect(page.getByTestId("command-message")).toContainText("(simulated)");
  await expect(card.getByTestId("pilot-route")).toContainText(`KMEM ⇄ ${dest}`);
  await expect(card.getByTestId("pilot-status")).toContainText(/Next departure|Flying/);

  // The fleet card says who flies it.
  await page.getByTestId("tab-hangar").click();
  await expect(page.getByTestId("fleet-card").first().getByTestId("aircraft-status")).toHaveText(
    "Hired pilot (simulated)",
  );

  // The player cannot load a mission on it.
  const jobs = await get<{ available: Array<{ id: string; origin: string }> }>("/api/jobs");
  const job = jobs.available.find((j) => j.origin === "KMEM");
  expect(job).toBeTruthy();
  expect((await command(page, tok, "job.accept", { jobId: job?.id })).ok).toBe(true);
  const load = await command(page, tok, "mission.load", { jobIds: [job?.id] });
  expect(load.ok).toBe(false);
  expect(load.error?.code).toBe("aircraft_with_hired_pilot");
  expect(load.error?.message).toMatch(/hired pilot .*\(simulated\)/);

  // The API agrees; the pro-rated first wage is in a balanced ledger.
  const pilots = await get<{ simulated: boolean; pilots: Array<{ id: string }> }>("/api/pilots");
  expect(pilots.simulated).toBe(true);
  expect(pilots.pilots).toHaveLength(1);
  const ledger = await get<{
    balanced: boolean;
    entries: Array<{ category: string; amount: number }>;
  }>("/api/ledger");
  expect(ledger.balanced).toBe(true);
  // The first wage is pro-rated by the time left in the in-game month; the fresh company's
  // clock has run a few seconds, so it is a few cents under $7,500.
  const wage = ledger.entries.find((e) => e.category === "pilot_wage")?.amount ?? 0;
  expect(wage).toBeGreaterThanOrEqual(-7_500);
  expect(wage).toBeLessThan(-7_490);

  // Unassign in the UI: the aircraft is the player's again and the mission loads.
  await page.getByTestId("tab-hired-pilots").click();
  await card.getByTestId("unassign-pilot").click();
  await expect(card.getByTestId("pilot-status")).toHaveText("Unassigned");
  const loaded = await command(page, tok, "mission.load", { jobIds: [job?.id] });
  expect(loaded.ok, JSON.stringify(loaded.error)).toBe(true);
});
