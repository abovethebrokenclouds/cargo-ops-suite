import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SimStatusChip } from "./SimStatusChip";
import type { SimStatus } from "./sim-status";

const cases: Array<[SimStatus, string, boolean]> = [
  ["live", "LIVE · MSFS 2024 · SunRise", true],
  ["demo", "DEMO DATA", false],
  ["replay", "REPLAY", false],
  ["disconnected", "SIM OFFLINE", false],
  ["connecting", "CONNECTING…", true],
  ["error", "CONNECTOR ERROR", false],
];

describe("SimStatusChip", () => {
  it.each(cases)("renders %s as %s", (status, label, pulsing) => {
    render(<SimStatusChip status={status} simName="MSFS 2024" protocol="SunRise" />);
    const chip = screen.getByRole("status");
    expect(chip).toHaveAttribute("data-status", status);
    expect(chip).toHaveAttribute("aria-live", "polite");
    expect(chip).toHaveTextContent(label);
    const dot = chip.querySelector(".status-dot");
    expect(dot).not.toBeNull();
    if (pulsing) expect(dot).toHaveAttribute("data-live", "true");
    else expect(dot).not.toHaveAttribute("data-live");
  });

  it("never labels demo data as live", () => {
    render(<SimStatusChip status="demo" simName="MSFS 2024" protocol="SunRise" />);
    const chip = screen.getByRole("status");
    expect(chip.textContent).not.toMatch(/LIVE/);
    expect(chip.className).toMatch(/bg-warning/);
  });

  it("omits missing sim name and protocol from the live label", () => {
    render(<SimStatusChip status="live" />);
    expect(screen.getByRole("status")).toHaveTextContent(/^LIVE$/);
  });

  it("exposes detail to assistive tech and as a tooltip", () => {
    render(<SimStatusChip status="error" detail="Port 4311 refused" />);
    const chip = screen.getByRole("status");
    expect(chip).toHaveAttribute("title", "Port 4311 refused");
    expect(chip).toHaveTextContent("CONNECTOR ERROR: Port 4311 refused");
  });
});
