import { expect, test } from "@playwright/test";

import { SimConnectEmulator } from "../connector/test/support/simconnect-emulator";
import { startConnector, type ReplayConnector } from "./replay-fixtures";

// Payload entered by you (docs/ECONOMY.md), live mode against the TEST-ONLY SimConnect
// protocol emulator: an aircraft that reports PAYLOAD STATION COUNT 0 (the MSFS 2024 case of
// plan §14.2). The check stays "unknown", the entered value is shown as YOURS, and TOTAL
// WEIGHT − EMPTY WEIGHT − fuel is shown as a second source. Emulated evidence about our code,
// never a check of MSFS itself.

/** A Caravan parked at KMEM with the brake set and no payload stations. */
const PARKED_NO_STATIONS = {
  "NUMBER OF ENGINES": 1,
  "PAYLOAD STATION COUNT": 0,
  TITLE: "Emulated Caravan 208B",
  "ATC ID": "N208EM",
  "FUEL TOTAL QUANTITY": 335.5,
  "FUEL TOTAL QUANTITY WEIGHT": 2247.9,
  "ENG FUEL FLOW PPH:1": 62.5,
  // 7,417.9 − 4,600 − 2,247.9 = 570 lb = 258.5 kg on board besides fuel.
  "TOTAL WEIGHT": 7417.9,
  "EMPTY WEIGHT": 4600,
  "MAX GROSS WEIGHT": 8807,
  "GENERAL ENG COMBUSTION:1": 1,
  "BRAKE PARKING POSITION": 1,
  "SIMULATION RATE": 1,
  "ZULU TIME": 50_400,
  "ZULU DAY OF MONTH": 13,
  "ZULU MONTH OF YEAR": 10,
  "ZULU YEAR": 2026,
  "PLANE LATITUDE": 35.0424,
  "PLANE LONGITUDE": -89.9767,
  "INDICATED ALTITUDE": 341,
  "PLANE ALT ABOVE GROUND": 0,
  "AIRSPEED INDICATED": 0,
  "AIRSPEED TRUE": 0,
  "GROUND VELOCITY": 0,
  "PLANE HEADING DEGREES MAGNETIC": 178,
  "PLANE HEADING DEGREES TRUE": 179.5,
  "VERTICAL SPEED": 0,
  "G FORCE": 1,
  "PLANE TOUCHDOWN NORMAL VELOCITY": 0,
  "PLANE TOUCHDOWN BANK DEGREES": 0,
  "PLANE TOUCHDOWN PITCH DEGREES": 0,
  "SIM ON GROUND": 1,
};

let emu: SimConnectEmulator | null = null;
let connector: ReplayConnector | null = null;

test.beforeAll(async () => {
  emu = await SimConnectEmulator.start({
    values: PARKED_NO_STATIONS,
    secondMs: 200,
    simFrameMs: 50,
  });
  connector = await startConnector("payload-entered", [
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

test("no payload stations: the payload you enter is labelled YOURS, check stays unknown", async ({
  page,
}) => {
  test.setTimeout(90_000);
  if (!emu || !connector) throw new Error("setup failed");
  await page.goto(`${connector.url}/jobs`);
  const chip = page.locator('header [role="status"]').first();
  await expect(chip).toHaveText(/LIVE/, { timeout: 15_000 });

  await page.getByLabel("Board airport").fill("KMEM");
  await page.getByLabel("Jobs to (optional)").fill("KATL");
  await page.getByTestId("refresh-board").click();
  await expect(page.getByTestId("command-message")).toHaveText("Board refreshed");
  const card = page.locator('[data-testid="job-card"][data-destination="KATL"]').first();
  await expect(card).toBeVisible();
  const jobId = await card.getAttribute("data-job-id");
  expect(jobId).toBeTruthy();
  await card.getByTestId("accept-job").click();
  await expect(page.getByTestId("command-message")).toHaveText(`Accepted ${jobId}`);
  await page.getByLabel(`Select ${jobId}`).check();
  await page.getByTestId("load-mission").click();
  await expect(page.getByTestId("command-message")).toContainText("Mission loaded");

  const strip = page.getByTestId("mission-strip");
  const check = strip.getByTestId("payload-check");
  await expect(check).toHaveAttribute("data-status", "unknown");
  await expect(check).toHaveAttribute("data-source", "sim");
  await expect(strip.getByTestId("payload-check-entered")).toHaveCount(0);

  // Enter the payload: shown as the player's, used only because no stations are reported.
  const form = page.getByTestId("entered-payload");
  await form.getByLabel(/Payload entered by you/).fill("181");
  await form.getByRole("button", { name: "Save" }).click();
  await expect(page.getByTestId("command-message")).toHaveText("Payload entered by you: 181 kg");
  const entered = strip.getByTestId("payload-check-entered");
  await expect(entered).toHaveAttribute("data-role", "used");
  await expect(entered).toContainText("YOURS");
  await expect(entered).toContainText("Entered by you 181 kg");
  await expect(check).toHaveAttribute("data-status", "unknown");
  await expect(strip.getByTestId("payload-check-numbers")).toHaveCount(0);
  const implied = strip.getByTestId("payload-check-implied");
  await expect(implied).toHaveAttribute("data-cross-check", "match");
  await expect(implied).toContainText("Total weight − empty − fuel 259 kg");
  await expect(strip.getByTestId("payload-check-advice")).toContainText("bonuses are unaffected");

  // The same check on /flight.
  await page.goto(`${connector.url}/flight`);
  const flightStrip = page.getByTestId("mission-strip");
  await expect(flightStrip.getByTestId("payload-check-entered")).toContainText(
    "Entered by you 181 kg",
  );
  await expect(flightStrip.getByTestId("payload-check")).toHaveAttribute("data-status", "unknown");
});
