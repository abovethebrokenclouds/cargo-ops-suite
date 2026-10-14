import { expect, test } from "@playwright/test";

import { SimConnectEmulator } from "../connector/test/support/simconnect-emulator";
import { startConnector, type ReplayConnector } from "./replay-fixtures";

// Live mode against the TEST-ONLY SimConnect protocol emulator (connector/test/support): the
// real connector connects over TCP, the page shows LIVE; then the "simulator" quits. Nothing
// sim-derived may stay on screen as live: no phase, no telemetry, no SIM data light. This is
// emulated evidence about our code, never a check of MSFS itself.

/** A Caravan level at 9,500 ft, so the connector's first phase is Cruise. */
const CRUISE = {
  "NUMBER OF ENGINES": 1,
  "PAYLOAD STATION COUNT": 1,
  TITLE: "Emulated Caravan 208B",
  "ATC ID": "N208EM",
  "FUEL TOTAL QUANTITY": 300,
  "FUEL TOTAL QUANTITY WEIGHT": 2010,
  "ENG FUEL FLOW PPH:1": 350,
  "TOTAL WEIGHT": 7400,
  "EMPTY WEIGHT": 4600,
  "MAX GROSS WEIGHT": 8807,
  "PAYLOAD STATION WEIGHT:1": 170,
  "PAYLOAD STATION NAME:1": "Pilot",
  "GENERAL ENG COMBUSTION:1": 1,
  "BRAKE PARKING POSITION": 0,
  "SIMULATION RATE": 1,
  "PLANE LATITUDE": 34.5,
  "PLANE LONGITUDE": -87.25,
  "INDICATED ALTITUDE": 9500,
  "PLANE ALT ABOVE GROUND": 9000,
  "AIRSPEED INDICATED": 150,
  "AIRSPEED TRUE": 175,
  "GROUND VELOCITY": 170,
  "PLANE HEADING DEGREES MAGNETIC": 106,
  "PLANE HEADING DEGREES TRUE": 105,
  "VERTICAL SPEED": 0,
  "G FORCE": 1,
  "SIM ON GROUND": 0,
};

let emu: SimConnectEmulator | null = null;
let connector: ReplayConnector | null = null;

test.beforeAll(async () => {
  emu = await SimConnectEmulator.start({ values: CRUISE, secondMs: 200, simFrameMs: 50 });
  connector = await startConnector("sim-offline", [
    "--simconnect-host",
    "127.0.0.1",
    "--simconnect-port",
    String(emu.port),
    "--weather",
    "off",
  ]);
});

test.afterAll(async () => {
  await connector?.stop();
  await emu?.close();
});

test("MSFS quits: /flight drops the phase and telemetry and never shows SIM data", async ({
  page,
}) => {
  if (!emu || !connector) throw new Error("setup failed");
  await page.goto(`${connector.url}/flight`);
  const chip = page.locator('header [role="status"]').first();
  await expect(chip).toHaveText(/LIVE/, { timeout: 15_000 });
  const phase = page.getByTestId("phase-label");
  const data = page.locator('[data-annunciator="Data"]');
  await expect(phase).toHaveText("Cruise", { timeout: 15_000 });
  await expect(data).toHaveText(/SIM$/);
  await expect(page.getByTestId("aircraft-title")).toHaveText("Emulated Caravan 208B");

  // The simulator quits and stays closed.
  emu.setAccepting(false);
  emu.quit();
  await expect(chip).toHaveText(/SIM OFFLINE/);
  await expect(phase).toHaveText("—");
  await expect(data).toHaveText(/SIM OFF/);
  await expect(data).not.toHaveAttribute("data-state", "on");
  await expect(page.getByTestId("aircraft-title")).toHaveText("No aircraft loaded");
  for (const v of await page.getByTestId("metric-value").all()) {
    await expect(v).toHaveAttribute("data-empty", "");
  }

  // Back: live again, phase recomputed from new frames.
  emu.setAccepting(true);
  await expect(chip).toHaveText(/LIVE/, { timeout: 15_000 });
  await expect(phase).toHaveText("Cruise", { timeout: 15_000 });
  await expect(data).toHaveText(/SIM$/);
});
