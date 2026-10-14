import { networkInterfaces } from "node:os";

import { expect, test } from "@playwright/test";

import { startConnector, type ReplayConnector } from "./replay-fixtures";

// LAN opt-in (plan §3.2) against the real connector started with `--lan <address>` on this
// host's first non-loopback IPv4 address. Two pages play the two machines: "pc" on
// 127.0.0.1 (this PC, gets the main token) and "tablet" on http://<address>:<port> (a real
// non-loopback client address, so the connector treats it as a LAN device). The tablet gets
// no token until it pairs with the code generated on the PC page; it can then fly but not run
// destructive data actions; a revoke on the PC sends it back to the pairing form.
// Skipped locally when the host has no non-loopback IPv4 address (the connector tests cover
// the same logic with an injected address); in CI a missing address fails the spec instead.

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((n) => n && n.family === "IPv4" && !n.internal)?.address;

const executablePath = process.env["PW_CHROMIUM_PATH"];

// Sandboxed CI/cloud hosts may set an HTTPS proxy that Chromium also uses for ws:// to a
// non-loopback address; a home network has none. Talk to the connector directly.
test.use({
  launchOptions: { args: ["--no-proxy-server"], ...(executablePath ? { executablePath } : {}) },
});

test.describe("LAN pairing", () => {
  test.skip(!lanIp && !process.env["CI"], "no non-loopback IPv4 address on this host");

  let connector: ReplayConnector;

  test.beforeAll(async () => {
    if (!lanIp) throw new Error("this CI host has no non-loopback IPv4 address; LAN e2e needs one");
    connector = await startConnector("lan", [
      "--sim",
      "fake",
      "--loop",
      "--speed",
      process.env["CARGO_OPS_E2E_SPEED"] ?? "20",
      "--lan",
      lanIp as string,
    ]);
  });
  test.afterAll(async () => {
    await connector?.stop();
  });

  test("a LAN device pairs with a code from the PC, controls, and is refused after revoke", async ({
    browser,
  }) => {
    const port = connector.port;
    const lanBase = `http://${lanIp}:${port}`;
    const pcContext = await browser.newContext({ baseURL: connector.url });
    const tabletContext = await browser.newContext({ baseURL: lanBase });
    const pc = await pcContext.newPage();
    const tablet = await tabletContext.newPage();

    try {
      // The PC: LAN is on, the tablet URL is listed, no device is paired yet.
      const mainToken = ((await (await pc.request.get("/api/session")).json()) as { token: string })
        .token;
      await pc.goto("/settings");
      await expect(pc.getByTestId("lan-status")).toHaveText(`On · listening on ${lanIp}`);
      await expect(pc.getByTestId("lan-urls")).toContainText(`${lanBase}/`);
      await expect(pc.getByTestId("lan-no-devices")).toBeVisible();

      // The tablet: no token from /api/session, only the pairing form.
      const session = await tablet.request.get("/api/session");
      expect(session.status()).toBe(403);
      expect(await session.text()).not.toContain(mainToken);
      await tablet.goto("/settings");
      await expect(tablet.getByTestId("pair-device")).toBeVisible();
      await expect(tablet.locator('header [role="status"]').first()).not.toHaveAttribute(
        "data-status",
        "replay",
      );

      // A wrong code is refused.
      await tablet.getByTestId("pair-code").fill("ZZZZ-ZZZZ");
      await tablet.getByTestId("pair-submit").click();
      await expect(tablet.getByTestId("pair-device")).toContainText(/wrong or expired/);

      // The PC generates a one-time code; the tablet types it.
      await pc.getByTestId("lan-generate-code").click();
      const code = (await pc.getByTestId("lan-code").textContent())?.trim() ?? "";
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
      await expect(pc.getByTestId("lan-pair-url")).toHaveText(
        `${lanBase}/settings#pair=${code.replace("-", "")}`,
      );
      await tablet.getByTestId("pair-code").fill(code);
      await tablet.getByTestId("pair-name").fill("Playwright tablet");
      await tablet.getByTestId("pair-submit").click();

      // Paired: live data (REPLAY), its own token, never the PC's.
      await expect(tablet.getByTestId("pair-device")).toHaveCount(0);
      await expect(tablet.locator('header [role="status"]').first()).toHaveAttribute(
        "data-status",
        "replay",
      );
      await expect(tablet.getByTestId("lan-paired-device")).toContainText("Playwright tablet");
      // No path on the PC reaches the tablet: backups are local-only, status hides paths.
      await expect(tablet.getByText("Backups are kept on the PC")).toBeVisible();
      expect(await tablet.content()).not.toContain(connector.dataDir);
      const lanToken = await tablet.evaluate(() => localStorage.getItem("cargo-ops.lan-token"));
      expect(lanToken).toMatch(/^[0-9a-f]{64}$/);
      expect(lanToken).not.toBe(mainToken);
      expect(await tablet.content()).not.toContain(mainToken);

      // Full control over the WebSocket (a command round-trip), destructive data stays local.
      const probe = await tablet.evaluate(async (token) => {
        const auth = { Authorization: `Bearer ${token}` };
        const jobs = await fetch("/api/jobs", { headers: auth });
        const status = (await (await fetch("/api/status", { headers: auth })).json()) as Record<
          string,
          unknown
        >;
        const backupList = await fetch("/api/backups", { headers: auth });
        const backup = await fetch("/api/backups", { method: "POST", headers: auth });
        const imp = await fetch("/api/import", {
          method: "POST",
          headers: { ...auth, "Content-Type": "application/json" },
          body: "{}",
        });
        const command = await new Promise<boolean>((resolve) => {
          const ws = new WebSocket(`ws://${location.host}/ws`);
          ws.onopen = () =>
            ws.send(
              JSON.stringify({
                type: "hello",
                v: 1,
                token,
                client: "web",
                wants: ["jobs"],
              }),
            );
          ws.onmessage = (ev) => {
            const msg = JSON.parse(String(ev.data)) as { type: string; id?: string; ok?: boolean };
            if (msg.type === "welcome") {
              ws.send(
                JSON.stringify({ type: "command", v: 1, id: "e2e", name: "jobs.list", args: {} }),
              );
            }
            if (msg.type === "result" && msg.id === "e2e") {
              ws.close();
              resolve(msg.ok === true);
            }
          };
          ws.onerror = () => resolve(false);
        });
        return {
          jobs: jobs.status,
          statusPaths: ["dataDir", "database", "recording"].filter((k) => k in status),
          statusMode: status["mode"],
          backupList: backupList.status,
          backup: [backup.status, ((await backup.json()) as { error: string }).error],
          imp: [imp.status, ((await imp.json()) as { error: string }).error],
          command,
        };
      }, lanToken);
      expect(probe).toEqual({
        jobs: 200,
        statusPaths: [],
        statusMode: "replay",
        backupList: 403,
        backup: [403, "local_only"],
        imp: [403, "local_only"],
        command: true,
      });

      // The PC lists the device and revokes it; the tablet is back at the pairing form.
      await pc.reload();
      const row = pc.getByTestId("lan-device-row");
      await expect(row).toContainText("Playwright tablet");
      await pc.getByRole("button", { name: "Revoke Playwright tablet" }).click();
      await expect(pc.getByTestId("lan-no-devices")).toBeVisible();
      await expect(tablet.getByTestId("pair-device")).toBeVisible({ timeout: 15_000 });
      expect(await tablet.evaluate(() => localStorage.getItem("cargo-ops.lan-token"))).toBeNull();
      const after = await tablet.request.get("/api/status", {
        headers: { Authorization: `Bearer ${lanToken}` },
      });
      expect(after.status()).toBe(401);
    } finally {
      await pcContext.close();
      await tabletContext.close();
    }
  });

  test("a foreign Origin and a rebinding Host are refused on the LAN address", async ({
    request,
  }) => {
    const port = connector.port;
    const lanBase = `http://${lanIp}:${port}`;
    const pair = await request.post(`${lanBase}/api/lan/pair`, {
      headers: { Origin: "http://evil.example" },
      data: { code: "ABCDEFGH" },
    });
    expect(pair.status()).toBe(403);
    const rebinding = await request.get(`${lanBase}/api/health`, {
      headers: { Host: `evil.example:${port}` },
    });
    expect(rebinding.status()).toBe(421);
  });
});
