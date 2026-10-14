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
  stale = false,
  station: string = stage === "departure" ? "KMEM" : "KATL",
): WeatherCheck {
  return checkWeather({
    stage,
    station,
    report: {
      origin,
      category,
      rawText: "KATL 141153Z 00000KT 1/2SM FG VV002 09/09 A3012",
      observedAt: new Date(NOW - 7 * 60_000).toISOString(),
      fetchedAt: new Date(NOW - 3 * 60_000).toISOString(),
      stale,
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

  it("bonuses removed (sim rate): the recorded outcome says withheld, and by what", () => {
    const weather: MissionWeather = {
      arrival: end("arrival", "LIFR"),
      bonus: 0,
      outcome: "withheld_rate",
      bonusFrom: "arrival",
    };
    render(<WeatherBonusLine weather={weather} />);
    const result = screen.getByTestId("weather-bonus-result");
    expect(result).toHaveTextContent("Weather bonus withheld");
    expect(result).toHaveTextContent("LIFR at KATL arrival");
    expect(result).toHaveTextContent("sim rate");
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

  it("a stale live report frozen at an end is tagged STALE, not plain LIVE", () => {
    const weather: MissionWeather = {
      departure: end("departure", "LIFR", "live", "sim", true),
      arrival: end("arrival", "VFR"),
      bonus: 0,
    };
    expect(weather.departure?.eligible).toBe(false);
    render(<WeatherBonusLine weather={weather} />);
    const line = screen.getByTestId("weather-bonus");
    const dep = line.querySelector('[data-weather-end="Dep"]') as HTMLElement;
    expect(within(dep).getByText("STALE")).toBeInTheDocument();
    const arr = line.querySelector('[data-weather-end="Arr"]') as HTMLElement;
    expect(within(arr).queryByText("STALE")).toBeNull();
  });

  // Final leg KATL → KRDU of a chain KMEM → KATL → KRDU: the payout counted the chain's
  // ends (KMEM departure on leg 1, KRDU arrival), never the transit stop KATL.
  const katl = (cat: WeatherReportInput["category"]) =>
    end("departure", cat, "live", "sim", false, "KATL");
  const krdu = (cat: WeatherReportInput["category"]) =>
    end("arrival", cat, "live", "sim", false, "KRDU");
  const kmem = (cat: WeatherReportInput["category"]) =>
    end("departure", cat, "live", "sim", false, "KMEM");

  it("transit stop LIFR, chain ends VFR: no IFR/LIFR at the counted ends, not 'withheld'", () => {
    const weather: MissionWeather = {
      departure: katl("LIFR"),
      arrival: krdu("VFR"),
      bonus: 0,
      outcome: "no_ifr",
      chain: { legs: 2, departure: kmem("VFR"), arrival: krdu("VFR") },
    };
    render(<WeatherBonusLine weather={weather} />);
    const result = screen.getByTestId("weather-bonus-result");
    expect(result).not.toHaveTextContent(/withheld/i);
    expect(result).not.toHaveTextContent(/sim rate|payload/);
    expect(result).toHaveTextContent("No weather bonus");
    expect(result).toHaveTextContent("KMEM departure VFR");
    expect(result).toHaveTextContent("KRDU arrival VFR");
    expect(result).toHaveTextContent("KATL is a transit stop");
    const chain = screen.getByTestId("weather-bonus-chain");
    expect(chain).toHaveTextContent("KMEM");
    expect(chain).toHaveTextContent("2 legs");
  });

  it("chain departure IFR at KMEM: the bonus names KMEM, in the line and the pill", () => {
    const weather: MissionWeather = {
      departure: katl("LIFR"),
      arrival: krdu("VFR"),
      bonus: 0.05,
      outcome: "applied",
      bonusFrom: "departure",
      chain: { legs: 2, departure: kmem("IFR"), arrival: krdu("VFR") },
    };
    render(<WeatherBonusLine weather={weather} />);
    const result = screen.getByTestId("weather-bonus-result");
    expect(result).toHaveTextContent("Weather bonus +5 %");
    expect(result).toHaveTextContent("IFR at KMEM departure");
    expect(result).toHaveTextContent("first leg of this 2-leg transit chain");
    render(<WeatherBonusPill weather={weather} />);
    const pill = screen.getByTestId("weather-bonus-pill");
    expect(pill).toHaveTextContent("+5 %");
    expect(pill).toHaveTextContent("KMEM");
  });

  it("a leg that only carried transit cargo: decided at the final delivery", () => {
    const weather: MissionWeather = {
      departure: kmem("IFR"),
      arrival: end("arrival", "LIFR"),
      outcome: "in_transit",
    };
    render(<WeatherBonusLine weather={weather} />);
    expect(screen.getByTestId("weather-bonus-result")).toHaveTextContent(
      /decided at the cargo's final delivery/,
    );
  });

  it("older saves without an outcome never claim why a bonus was not paid", () => {
    const weather: MissionWeather = { departure: katl("LIFR"), arrival: krdu("VFR"), bonus: 0 };
    render(<WeatherBonusLine weather={weather} />);
    const result = screen.getByTestId("weather-bonus-result");
    expect(result).not.toHaveTextContent(/withheld/i);
    expect(result).toHaveTextContent("No weather bonus was paid on this delivery");
  });
});
