import { expect, test } from "@playwright/test";

import { SimConnectEmulator } from "../connector/test/support/simconnect-emulator";
import { startConnector, type ReplayConnector } from "./replay-fixtures";

// Live mode against the TEST-ONLY SimConnect protocol emulator: a free flight with no GPS plan
// gets a destination from the /flight picker (labelled Manual, distance computed by the
// connector), an activated GPS plan takes over (labelled GPS plan), and deactivating it falls
// back to the manual choice. Emulated evidence about our code, never a check of MSFS (PC-53).

/** A Caravan level at 9,500 ft over northern Alabama, no GPS flight plan. */
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
  "GPS IS ACTIVE FLIGHT PLAN": 0,
};

/** The pilot activates a GPS plan whose last leg goes to KATL. */
const GPS_KATL = {
  "GPS IS ACTIVE FLIGHT PLAN": 1,
  "GPS FLIGHT PLAN WP COUNT": 2,
  "GPS FLIGHT PLAN WP INDEX": 1,
  "GPS WP NEXT ID": "KATL",
  "GPS WP NEXT LAT": 33.6367,
  "GPS WP NEXT LON": -84.4281,
  "GPS WP DISTANCE": 152.4,
  "GPS WP ETE": 3230,
  "GPS ETE": 3230,
};

let emu: SimConnectEmulator | null = null;
let connector: ReplayConnector | null = null;

test.beforeAll(async () => {
  emu = await SimConnectEmulator.start({ values: CRUISE, secondMs: 200, simFrameMs: 50 });
  connector = await startConnector("destination", [
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

test("free flight: manual destination on /flight, GPS plan takes over, then falls back", async ({
  page,
}) => {
  if (!emu || !connector) throw new Error("setup failed");
  await page.goto(`${connector.url}/flight`);
  const chip = page.locator('header [role="status"]').first();
  await expect(chip).toHaveText(/LIVE/, { timeout: 15_000 });
  await expect(page.getByTestId("phase-label")).toHaveText("Cruise", { timeout: 15_000 });
  await expect(page.getByText("No flight plan")).toBeVisible();
  await expect(page.getByTestId("plan-basis")).toHaveCount(0);
  await expect(page.getByTestId("destination-status")).toHaveText(/No GPS flight plan/);

  // Pick KATL: the connector computes distance (≈ 149 nm great circle) and ETE at 170 kt.
  const search = page.getByTestId("destination-search");
  await expect(search).toBeEnabled({ timeout: 15_000 });
  await search.fill("KATL");
  await page.locator('[data-testid="destination-result"][data-ident="KATL"]').click();
  await expect(page.getByTestId("destination-message")).toHaveText(
    "KATL set as the destination for this flight.",
  );
  const basis = page.getByTestId("plan-basis");
  await expect(basis).toHaveText("Manual");
  // Picked in the air: no origin airport, so the route reads "To KATL".
  await expect(page.getByText("To KATL", { exact: true })).toBeVisible();
  await expect(page.getByTestId("distance-remaining")).toHaveText(/^1(4[5-9]|5[0-3])$/);
  // No REPLAY/DEMO tag on the route: these frames are source "sim".
  const route = page.locator("section", { has: basis });
  await expect(route.locator("[data-source-tag]")).toHaveCount(0);

  // A GPS plan is activated in the sim: it takes precedence, with the GPS's own distance.
  emu.set(GPS_KATL);
  await expect(basis).toHaveText("GPS plan", { timeout: 10_000 });
  await expect(page.getByTestId("distance-remaining")).toHaveText("152");
  await expect(page.getByTestId("destination-status")).toHaveText(/GPS flight plan is in use/);

  // Deactivated: the manual destination for this flight is back.
  emu.set({ "GPS IS ACTIVE FLIGHT PLAN": 0 });
  await expect(basis).toHaveText("Manual", { timeout: 10_000 });

  // Clear it: no route at all, nothing invented.
  await page.getByTestId("destination-clear").click();
  await expect(page.getByTestId("plan-basis")).toHaveCount(0);
  await expect(page.getByText("No flight plan")).toBeVisible();
  await expect(page.getByTestId("distance-remaining")).toHaveText("—");
});
