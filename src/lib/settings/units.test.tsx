import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { UnitsPanel } from "@/components/settings/SettingsPanels";
import { PayloadBar } from "@/components/flight/PayloadBar";

import { maskToken } from "./connector-data";
import {
  DEFAULT_UNITS,
  UNITS_KEY,
  altitudeFromFt,
  formatAltitudeFt,
  formatWeightLb,
  getUnits,
  parseUnits,
  setUnits,
  weightFromLb,
} from "./units";

afterEach(() => window.localStorage.clear());

describe("unit preferences", () => {
  it("defaults to lb / ft / kt and tolerates junk", () => {
    expect(parseUnits(null)).toEqual(DEFAULT_UNITS);
    expect(parseUnits("not json")).toEqual(DEFAULT_UNITS);
    expect(parseUnits('{"weight":"stone","altitude":"m","speed":"mph"}')).toEqual({
      weight: "lb",
      altitude: "m",
      speed: "kt",
    });
  });

  it("persists per browser in localStorage", () => {
    setUnits({ weight: "kg", altitude: "m", speed: "kt" });
    expect(JSON.parse(window.localStorage.getItem(UNITS_KEY) ?? "{}")).toEqual({
      weight: "kg",
      altitude: "m",
      speed: "kt",
    });
    expect(getUnits()).toEqual({ weight: "kg", altitude: "m", speed: "kt" });
  });

  it("converts and formats", () => {
    expect(weightFromLb(2_204.6226218, "kg")).toBeCloseTo(1_000);
    expect(weightFromLb(100, "lb")).toBe(100);
    expect(altitudeFromFt(3_280.84, "m")).toBeCloseTo(1_000);
    expect(formatWeightLb(2_204.6226218, "kg")).toBe("1,000 kg");
    expect(formatAltitudeFt(10_000, "ft")).toBe("10,000 ft");
    expect(formatAltitudeFt(10_000, "m")).toBe("3,048 m");
    expect(formatWeightLb(null, "kg")).toBe("—");
  });
});

describe("Settings → Units panel", () => {
  it("switches weight and altitude and stores the choice", async () => {
    render(<UnitsPanel />);
    const kg = await screen.findByLabelText("kg");
    fireEvent.click(kg);
    fireEvent.click(screen.getByLabelText("m"));
    expect(getUnits()).toEqual({ weight: "kg", altitude: "m", speed: "kt" });
    expect(screen.getByLabelText("kg")).toBeChecked();
    expect(screen.getByLabelText("kt")).toBeChecked();
  });

  it("the payload bar follows the weight unit", () => {
    const weights = {
      totalLb: 8_000,
      emptyLb: 5_000,
      payloadLb: 2_204.6226218,
      fuelAndOtherLb: 795.38,
      maxGrossLb: 8_750,
      marginLb: 750,
      overweight: false,
    };
    const { rerender } = render(<PayloadBar weights={weights} />);
    expect(screen.getByTestId("payload-lb")).toHaveTextContent("2,205");
    rerender(<PayloadBar weights={weights} unit="kg" />);
    expect(screen.getByTestId("payload-lb")).toHaveTextContent("1,000");
    expect(screen.getByTestId("payload-bar")).toHaveTextContent("3,969 kg");
  });
});

describe("token masking", () => {
  it("never shows more than the last four characters", () => {
    const token = "a".repeat(60) + "beef";
    const masked = maskToken(token);
    expect(masked.endsWith("beef")).toBe(true);
    expect(masked).not.toContain("aaaa");
    expect(maskToken("short")).not.toContain("short");
    expect(maskToken(null)).toBe("—");
  });
});
