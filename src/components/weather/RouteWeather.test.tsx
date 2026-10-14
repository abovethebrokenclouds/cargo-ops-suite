import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetarResponse } from "@cargo-ops/weather";

import { initialSimState, simReducer, type ClientSimState } from "@/lib/sim-state";
import { setOnlineWeatherEnabled } from "@/lib/settings/weather-settings";
import { SimConnectionContext, type TransportKind } from "@/lib/transport/useSimConnection";
import { sampleResponse } from "@/lib/weather/use-metar";

import { RouteWeather } from "./RouteWeather";

const connectorJson = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("@/lib/transport/connector-api", () => ({
  connectorJson: (path: string) => connectorJson(path),
}));

function replayState(): ClientSimState {
  return simReducer(initialSimState, {
    type: "welcome",
    msg: { type: "welcome", v: 1, session: "t", mode: "replay", sim: { connected: false } },
  });
}

function renderWeather(state: ClientSimState, transportKind: TransportKind) {
  return render(
    <SimConnectionContext.Provider value={{ state, send: () => {}, transportKind }}>
      <RouteWeather origin="KMEM" destination="KATL" />
    </SimConnectionContext.Provider>,
  );
}

const station = (id: string) =>
  screen
    .getAllByTestId("metar-station")
    .find((el) => el.getAttribute("data-station") === id) as HTMLElement;

describe("RouteWeather", () => {
  beforeEach(() => {
    window.localStorage.clear();
    connectorJson.mockReset();
  });
  afterEach(() => vi.useRealTimers());

  it("demo: SAMPLE reports labelled as such, category chips, raw text toggle, age", () => {
    renderWeather(initialSimState, "demo");
    const mem = station("KMEM");
    const atl = station("KATL");
    expect(mem).toHaveAttribute("data-origin", "sample");
    expect(within(mem).getByText("SAMPLE")).toBeInTheDocument();
    expect(within(mem).getByTestId("flight-category")).toHaveTextContent("VFR");
    expect(within(atl).getByTestId("flight-category")).toHaveTextContent("MVFR");
    expect(screen.queryByText("LIVE")).toBeNull();
    expect(screen.getByTestId("weather-status")).toHaveTextContent(/not real weather/);
    expect(within(mem).getByTestId("metar-age")).toHaveTextContent(/Observed .*ago|just now/);
    expect(within(mem).queryByTestId("metar-raw")).toBeNull();
    fireEvent.click(within(mem).getByTestId("metar-raw-toggle"));
    expect(within(mem).getByTestId("metar-raw")).toHaveTextContent(/^KMEM \d{6}Z 20009KT/);
    expect(connectorJson).not.toHaveBeenCalled();
  });

  it("connector: asks with online=1 by default and shows LIVE reports with attribution", async () => {
    const live: MetarResponse = sampleResponse(["KMEM", "KATL"]);
    live.mode = "online";
    live.onlineAllowed = true;
    for (const s of live.stations) {
      if (s.report) s.report = { ...s.report, origin: "live" };
      s.note = null;
    }
    connectorJson.mockResolvedValue(live);
    renderWeather(replayState(), "live");
    await waitFor(() => expect(station("KMEM")).toHaveAttribute("data-origin", "live"));
    expect(connectorJson).toHaveBeenCalledWith("/api/weather/metar?ids=KMEM,KATL&online=1");
    expect(within(station("KMEM")).getByText("LIVE")).toBeInTheDocument();
    expect(screen.getByTestId("weather-status")).toHaveTextContent(/aviationweather\.gov/);
  });

  it("connector: the online-weather switch off sends online=0 and says so", async () => {
    setOnlineWeatherEnabled(false);
    connectorJson.mockImplementation(async (path: string) => ({
      mode: "online",
      onlineAllowed: false,
      stations: ["KMEM", "KATL"].map((s) => ({
        station: s,
        report: null,
        note: "Online weather is off in Settings.",
      })),
      attribution: "x",
      endpoint: "y",
      path,
    }));
    renderWeather(replayState(), "live");
    await waitFor(() =>
      expect(screen.getByTestId("weather-status")).toHaveAttribute("data-weather-mode", "disabled"),
    );
    expect(connectorJson).toHaveBeenCalledWith("/api/weather/metar?ids=KMEM,KATL&online=0");
    expect(within(station("KMEM")).getByTestId("metar-note")).toHaveTextContent(/off in Settings/);
    await act(async () => {});
  });

  it("connector offline: says weather needs the connector, no request", () => {
    renderWeather(initialSimState, "live");
    expect(within(station("KMEM")).getByTestId("metar-note")).toHaveTextContent(
      /needs the connector/,
    );
    expect(connectorJson).not.toHaveBeenCalled();
  });
});
