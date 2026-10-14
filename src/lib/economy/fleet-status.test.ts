import { describe, expect, it } from "vitest";

import { AIRCRAFT_STATUSES } from "@cargo-ops/protocol";

import { DASHBOARD_FLEET_STATUS } from "./fleet-status";

describe("dashboard fleet status labels", () => {
  it("cover every status; a hired aircraft reads as simulated, never as from the simulator", () => {
    for (const s of AIRCRAFT_STATUSES) expect(DASHBOARD_FLEET_STATUS[s]).toBeTruthy();
    expect(DASHBOARD_FLEET_STATUS.hired).toBe("HIRED PILOT (SIMULATED)");
    expect(Object.values(DASHBOARD_FLEET_STATUS).some((l) => /\bSIM\.?\)/.test(l))).toBe(false);
  });
});
