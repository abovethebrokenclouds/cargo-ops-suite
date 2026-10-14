import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { MissionWeather, WeatherCheck } from "@cargo-ops/protocol";
import { checkWeather, computePayout, type WeatherReportInput } from "@cargo-ops/economy";

import { PayoutBreakdown } from "./PayoutBreakdown";
import { WeatherBonusLine, WeatherBonusPill } from "./WeatherBonus";

const NOW = Date.UTC(2026, 9, 14, 12, 0, 0);

function end(
  stage: WeatherCheck["stage"],
  category: WeatherReportInput["category"],
  origin: WeatherReportInput["origin"] = "live",
  source: WeatherCheck["source"] = "sim",
): WeatherCheck {
  return checkWeather({
    stage,
    station: stage === "departure" ? "KMEM" : "KATL",
    report: {
      origin,
      category,
      rawText: "KATL 141153Z 00000KT 1/2SM FG VV002 09/09 A3012",
      observedAt: new Date(NOW - 7 * 60_000).toISOString(),
      fetchedAt: new Date(NOW - 3 * 60_000).toISOString(),
      stale: false,
    },
    source,
    nowMs: NOW,
  });
}

function payout(weather: MissionWeather, noBonus = false) {
  return computePayout({
    kind: "cargo",
    weightKg: 500,
    distanceNm: 100,
    units: 1,
    reputation: 50,
    estimate: false,
    landingGrade: "B",
    lateMin: 0,
    weather,
    noBonus,
  });
}

describe("weather bonus UI", () => {
  it("live LIFR at arrival: both ends, LIVE tags, +10 % in the logbook and the breakdown", () => {
    const weather: MissionWeather = {
      departure: end("departure", "IFR"),
      arrival: end("arrival", "LIFR"),
      bonus: 0.1,
    };
    render(<WeatherBonusLine weather={weather} />);
    const line = screen.getByTestId("weather-bonus");
    expect(line).toHaveAttribute("data-bonus", "0.1");
    const arr = line.querySelector('[data-weather-end="Arr"]') as HTMLElement;
    expect(arr).toHaveAttribute("data-category", "LIFR");
    expect(arr).toHaveAttribute("data-eligible", "true");
    expect(within(arr).getByText("LIVE")).toBeInTheDocument();
    expect(screen.getByTestId("weather-bonus-result")).toHaveTextContent("Weather bonus +10 %");

    render(<WeatherBonusPill weather={weather} />);
    const pill = screen.getByTestId("weather-bonus-pill");
    expect(pill).toHaveTextContent("IFR → LIFR");
    expect(pill).toHaveTextContent("+10 %");

    render(<PayoutBreakdown breakdown={payout(weather)} />);
    const cond = document.querySelector('[data-factor="conditions"]') as HTMLElement;
    expect(cond).toHaveTextContent("Weather: LIFR at KATL arrival (live METAR) +10 %");
    expect(cond).toHaveTextContent("× 1.10");
  });

  it("SAMPLE weather in a replay: labelled SAMPLE and REPLAY, no bonus", () => {
    const weather: MissionWeather = {
      departure: end("departure", "LIFR", "sample", "replay"),
      arrival: end("arrival", "MVFR", "sample", "replay"),
      bonus: 0,
    };
    render(<WeatherBonusLine weather={weather} />);
    const line = screen.getByTestId("weather-bonus");
    expect(within(line).getAllByText("SAMPLE")).toHaveLength(2);
    expect(within(line).getAllByText("REPLAY")).toHaveLength(2);
    expect(screen.getByTestId("weather-bonus-result")).toHaveTextContent(/No weather bonus/);
    render(<WeatherBonusPill weather={weather} />);
    expect(screen.getByTestId("weather-bonus-pill")).not.toHaveTextContent("%");
  });

  it("bonuses removed (sim rate): eligible LIFR is shown as withheld", () => {
    const weather: MissionWeather = { arrival: end("arrival", "LIFR"), bonus: 0 };
    render(<WeatherBonusLine weather={weather} />);
    expect(screen.getByTestId("weather-bonus-result")).toHaveTextContent("Weather bonus withheld");
    render(<PayoutBreakdown breakdown={payout(weather, true)} />);
    const cond = document.querySelector('[data-factor="conditions"]') as HTMLElement;
    expect(cond).toHaveTextContent("withheld");
    expect(cond).toHaveTextContent("× 1.00");
  });

  it("no weather recorded: a dash, no line", () => {
    const { container } = render(<WeatherBonusLine weather={undefined} />);
    expect(container).toBeEmptyDOMElement();
    render(<WeatherBonusPill weather={null} />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });
});
