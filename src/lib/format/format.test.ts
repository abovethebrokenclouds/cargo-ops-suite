import { describe, expect, it } from "vitest";

import {
  EMPTY,
  formatDegrees,
  formatFeet,
  formatFpm,
  formatInt,
  formatKnots,
  formatLat,
  formatLatLon,
  formatLon,
  formatMinutes,
  formatUsd,
} from "./index";

describe("format", () => {
  it("formats integers with thousands separators", () => {
    expect(formatInt(0)).toBe("0");
    expect(formatInt(1234567)).toBe("1,234,567");
    expect(formatInt(12345.6)).toBe("12,346");
    expect(formatInt(-0.2)).toBe("0");
    expect(formatInt(-4200)).toBe("-4,200");
  });

  it("returns an em dash for missing or non-finite values", () => {
    for (const f of [formatInt, formatFeet, formatKnots, formatFpm, formatDegrees, formatUsd]) {
      expect(f(null)).toBe(EMPTY);
      expect(f(undefined)).toBe(EMPTY);
      expect(f(Number.NaN)).toBe(EMPTY);
      expect(f(Number.POSITIVE_INFINITY)).toBe(EMPTY);
    }
    expect(formatMinutes(null)).toBe(EMPTY);
    expect(formatLatLon(null, 10)).toBe(EMPTY);
  });

  it("formats feet and knots", () => {
    expect(formatFeet(35000)).toBe("35,000 ft");
    expect(formatKnots(248.4)).toBe("248 kt");
  });

  it("formats vertical speed with an explicit sign", () => {
    expect(formatFpm(1200)).toBe("+1,200 fpm");
    expect(formatFpm(-800)).toBe("−800 fpm");
    expect(formatFpm(0.3)).toBe("0 fpm");
  });

  it("zero-pads and normalises degrees", () => {
    expect(formatDegrees(5)).toBe("005°");
    expect(formatDegrees(90)).toBe("090°");
    expect(formatDegrees(359.6)).toBe("000°");
    expect(formatDegrees(360)).toBe("000°");
    expect(formatDegrees(-10)).toBe("350°");
    expect(formatDegrees(725)).toBe("005°");
  });

  it("formats whole US dollars", () => {
    expect(formatUsd(248500)).toBe("$248,500");
    expect(formatUsd(6400.49)).toBe("$6,400");
    expect(formatUsd(-1200)).toBe("-$1,200");
  });

  it("formats minutes as hours and minutes", () => {
    expect(formatMinutes(83)).toBe("1h 23m");
    expect(formatMinutes(45)).toBe("45m");
    expect(formatMinutes(120)).toBe("2h 00m");
    expect(formatMinutes(0)).toBe("0m");
    expect(formatMinutes(-5)).toBe("0m");
  });

  it("formats latitude and longitude in degrees and decimal minutes", () => {
    expect(formatLat(35.0424)).toBe("N35°02.54′");
    expect(formatLat(-33.9461)).toBe("S33°56.77′");
    expect(formatLon(-89.9767)).toBe("W089°58.60′");
    expect(formatLon(151.1772)).toBe("E151°10.63′");
    expect(formatLat(91)).toBe(EMPTY);
    expect(formatLon(-181)).toBe(EMPTY);
    expect(formatLat(10.99999999)).toBe("N11°00.00′");
    expect(formatLatLon(35.0424, -89.9767)).toBe("N35°02.54′ W089°58.60′");
  });
});
