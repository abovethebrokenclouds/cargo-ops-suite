import { expect, test } from "@playwright/test";

import { SimConnectEmulator } from "../connector/test/support/simconnect-emulator";
import { startConnector, type ReplayConnector } from "./replay-fixtures";

// MSFS facilities override in live mode against the TEST-ONLY SimConnect protocol emulator:
// the board airport's data on /jobs is labelled MSFS once the emulated sim answered its
// facility request, the sim's runways are listed, and an add-on airport that the bundled
// OurAirports data does not have becomes a job destination after the sim answered for it.
// Emulated evidence about our code, never a check of MSFS (PC-57).

/** A Caravan parked at KMEM. */
const PARKED = {
  "NUMBER OF ENGINES": 1,
  "PAYLOAD STATION COUNT": 1,
  TITLE: "Emulated Caravan 208B",
  "ATC ID": "N208EM",
  "FUEL TOTAL QUANTITY": 300,
  "FUEL TOTAL QUANTITY WEIGHT": 2010,
  "TOTAL WEIGHT": 6800,
  "EMPTY WEIGHT": 4600,
  "MAX GROSS WEIGHT": 8807,
  "PAYLOAD STATION WEIGHT:1": 170,
  "PAYLOAD STATION NAME:1": "Pilot",
  "BRAKE PARKING POSITION": 1,
  "SIMULATION RATE": 1,
  "PLANE LATITUDE": 35.0424,
  "PLANE LONGITUDE": -89.9767,
  "INDICATED ALTITUDE": 341,
  "PLANE ALT ABOVE GROUND": 0,
  "PLANE HEADING DEGREES TRUE": 179,
  "PLANE HEADING DEGREES MAGNETIC": 178,
  "G FORCE": 1,
  "SIM ON GROUND": 1,
};

let emu: SimConnectEmulator | null = null;
let connector: ReplayConnector | null = null;

test.beforeAll(async () => {
  emu = await SimConnectEmulator.start({
    values: PARKED,
    secondMs: 200,
    simFrameMs: 50,
    facilities: {
      KMEM: {
        values: { LATITUDE: 35.0424, LONGITUDE: -89.9767, ALTITUDE: 103.9, NAME64: "Memphis" },
        runways: [
          {
            HEADING: 178.6,
            LENGTH: 3389.4,
            WIDTH: 45.7,
            SURFACE: 0,
            PRIMARY_NUMBER: 18,
            PRIMARY_DESIGNATOR: 3,
            SECONDARY_NUMBER: 36,
            SECONDARY_DESIGNATOR: 3,
          },
        ],
      },
      XADD: {
        values: { LATITUDE: 35.5, LONGITUDE: -89.5, ALTITUDE: 91.4, NAME64: "Addon Field" },
        runways: [
          {
            HEADING: 90,
            LENGTH: 1219.2,
            WIDTH: 30.5,
            SURFACE: 4,
            PRIMARY_NUMBER: 9,
            PRIMARY_DESIGNATOR: 0,
            SECONDARY_NUMBER: 27,
            SECONDARY_DESIGNATOR: 0,
          },
        ],
      },
    },
  });
  connector = await startConnector("facilities", [
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

test("board airport labelled MSFS, sim runways listed, add-on airport offered", async ({
  page,
}) => {
  test.setTimeout(90_000);
  if (!emu || !connector) throw new Error("setup failed");
  await page.goto(`${connector.url}/jobs`);
  const chip = page.locator('header [role="status"]').first();
  await expect(chip).toHaveText(/LIVE/, { timeout: 15_000 });

  const facts = page.getByTestId("airport-facts");
  await expect(facts.getByTestId("fact-runway").locator("[data-field-source]")).toHaveText("MSFS", {
    timeout: 15_000,
  });
  await expect(facts.getByTestId("fact-runway")).toContainText("11,120 ft");
  await expect(facts.getByTestId("fact-elevation").locator("[data-field-source]")).toHaveText(
    "MSFS",
  );
  // The name stays OurAirports for a bundled airport.
  await expect(facts.locator("[data-field-source]").first()).toHaveText("OurAirports");
  await expect(facts.getByTestId("msfs-runways")).toContainText("18C/36C");

  // An add-on airport: asked for on the first refresh, offered on the next one.
  await page.getByLabel("Board airport").fill("KMEM");
  await page.getByLabel("Jobs to (optional)").fill("XADD");
  await page.getByTestId("refresh-board").click();
  await expect(page.getByTestId("command-message")).toContainText("asked the simulator");
  await expect.poll(() => emu?.facilityRequests().includes("XADD")).toBe(true);
  await page.waitForTimeout(500);
  await page.getByTestId("refresh-board").click();
  await expect(page.getByTestId("command-message")).toHaveText("Board refreshed");
  const card = page.locator('[data-testid="job-card"][data-destination="XADD"]').first();
  await expect(card).toBeVisible();
  await expect(card.locator('[data-suitability="runway"]')).toHaveAttribute(
    "title",
    /4,000 ft paved \(MSFS\)/,
  );
  expect(emu.unhandled).toEqual([]);
});
