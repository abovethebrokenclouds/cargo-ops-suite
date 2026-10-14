import type { APIRequestContext, Page } from "@playwright/test";

import { expect, test } from "./replay-fixtures";

// Insurer repair loans against the real connector (docs/ECONOMY.md "Insurer repair loans"):
// insure the starter C208B, fly the replayed KMEM→KATL mission so it carries real wear, then
// finance the wear overhaul from /fleet with "Finance with insurer". The loan shows up on
// /company as a repair loan with no collateral, and the API reports it with the ledger rows.
// Like every replay spec it runs against its own connector with a fresh company.

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

/**
 * Full navigation: the page boots, fetches /api/session, opens a new WebSocket and gets the
 * connector's welcome and snapshot before it can show any company data. Wait for that signal
 * (the header chip turns REPLAY only after a real welcome) so each data assertion after it gets
 * its own budget instead of sharing it with the page boot and the handshake.
 */
async function openWithConnector(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await expect(page.locator('header [role="status"]').first()).toHaveAttribute(
    "data-status",
    "replay",
  );
}

interface FleetLite {
  aircraft: Array<{
    id: string;
    registration: string;
    status: string;
    condition: number;
    insurance?: {
      insured: boolean;
      repairLoan?: { overhaulBill: number | null; open: { loanId: string } | null };
    };
  }>;
}

interface LoanLite {
  id: string;
  kind?: string;
  status: string;
  apr: number;
  principal: number;
  balance: number;
  lenderName: string;
  collateral: { id: string };
}

test("insure, fly the replay for wear, finance the overhaul with the insurer", async ({
  page,
  request,
}) => {
  test.setTimeout(150_000);
  await openWithConnector(page, "/fleet");
  const tok = await token(request);
  const auth = { Authorization: `Bearer ${tok}` };
  const get = async <T>(path: string) =>
    (await (await request.get(path, { headers: auth })).json()) as T;

  const starter = (await get<FleetLite>("/api/fleet")).aircraft[0];
  expect(starter).toBeDefined();
  if (!starter) return;
  // Before the policy the insurer refuses.
  const refused = await command(page, tok, "insurance.repairLoan", {
    aircraftId: starter.id,
    repair: "overhaul",
    principal: 1_000,
    termMonths: 12,
  });
  expect(refused.error?.code).toBe("not_insured");
  const insured = await command(page, tok, "insurance.buy", { aircraftId: starter.id });
  expect(insured.ok, JSON.stringify(insured.error)).toBe(true);

  // Fly the replayed KMEM→KATL mission on the starter: the wear makes an overhaul bill.
  expect(
    (await command(page, tok, "jobs.refresh", { airport: "KMEM", destination: "KATL" })).ok,
  ).toBe(true);
  const jobs = await get<{ available: Array<{ id: string; destination: string }> }>("/api/jobs");
  const job = jobs.available.find((j) => j.destination === "KATL");
  expect(job).toBeDefined();
  if (!job) return;
  expect((await command(page, tok, "job.accept", { jobId: job.id })).ok).toBe(true);
  const loaded = await command(page, tok, "mission.load", { jobIds: [job.id] });
  expect(loaded.ok, JSON.stringify(loaded.error)).toBe(true);
  await expect
    .poll(
      async () => {
        const body = await get<{ missions: Array<{ jobIds: string[]; status: string }> }>(
          "/api/missions",
        );
        return body.missions.find((m) => m.jobIds.includes(job.id))?.status;
      },
      { timeout: 90_000, intervals: [1_000] },
    )
    .toBe("delivered");
  await expect
    .poll(async () => {
      const a = (await get<FleetLite>("/api/fleet")).aircraft.find((x) => x.id === starter.id);
      return a?.status === "available" && (a.insurance?.repairLoan?.overhaulBill ?? 0) > 500;
    })
    .toBe(true);

  // The repair flow on /fleet: "Finance with insurer" for the selected (first) aircraft.
  await openWithConnector(page, "/fleet");
  const panel = page.getByTestId("repair-financing");
  await expect(panel).toBeVisible();
  await expect(panel).toContainText("never repossesses");
  await expect(panel.getByText("DEMO")).toHaveCount(0);
  await page.getByLabel("Repair loan term").fill("6");
  const finance = page.getByTestId("finance-with-insurer");
  await expect(finance).toBeEnabled();
  await finance.click();
  await expect(page.getByTestId("command-message")).toContainText("financed by the insurer");

  // The API: one active repair loan from the insurer on the starter, at 4 %, for the bill.
  const loans = await get<{ loans: LoanLite[] }>("/api/loans");
  const loan = loans.loans.find((l) => l.kind === "repair");
  expect(loan).toMatchObject({
    status: "active",
    apr: 4,
    lenderName: "Hull insurer",
    collateral: { id: starter.id },
  });
  if (!loan) return;
  expect(loan.balance).toBe(loan.principal);
  const ledger = await get<{
    entries: Array<{ category: string; amount: number; refId: string | null }>;
    balanced: boolean;
  }>("/api/ledger");
  expect(ledger.balanced).toBe(true);
  expect(
    ledger.entries.find((e) => e.category === "repair_loan_disbursement" && e.refId === loan.id)
      ?.amount,
  ).toBe(loan.principal);
  // Cancelling the policy now is refused; the second loan on the same aircraft as well.
  expect(
    (await command(page, tok, "insurance.cancel", { aircraftId: starter.id })).error?.code,
  ).toBe("repair_loan_open");

  // /company lists it as a repair loan with no collateral.
  await openWithConnector(page, "/company");
  const item = page.locator('[data-testid="active-loan"][data-kind="repair"]');
  await expect(item).toBeVisible();
  await expect(item).toContainText(`repair loan, ${starter.registration} (no collateral)`);
  await expect(item).toContainText("Hull insurer");
});
