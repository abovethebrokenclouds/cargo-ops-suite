import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MetarResponse, TafResponse } from "@cargo-ops/weather";

import { initialSimState, simReducer, type ClientSimState } from "@/lib/sim-state";
import { setOnlineWeatherEnabled } from "@/lib/settings/weather-settings";
import { SimConnectionContext, type TransportKind } from "@/lib/transport/useSimConnection";
import { sampleResponse, sampleTafResponse } from "@/lib/weather/use-metar";

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
    const liveTaf: TafResponse = sampleTafResponse(["KATL"]);
    liveTaf.mode = "online";
    liveTaf.onlineAllowed = true;
    for (const s of liveTaf.stations) {
      if (s.report) s.report = { ...s.report, origin: "live" };
      s.note = null;
    }
    connectorJson.mockImplementation(async (path: string) =>
      path.startsWith("/api/weather/taf") ? liveTaf : live,
    );
    renderWeather(replayState(), "live");
    await waitFor(() => expect(station("KMEM")).toHaveAttribute("data-origin", "live"));
    expect(connectorJson).toHaveBeenCalledWith("/api/weather/metar?ids=KMEM,KATL&online=1");
    expect(connectorJson).toHaveBeenCalledWith("/api/weather/taf?ids=KATL&online=1");
    expect(connectorJson).toHaveBeenCalledTimes(2);
    expect(within(station("KMEM")).getByText("LIVE")).toBeInTheDocument();
    expect(screen.getByTestId("weather-status")).toHaveTextContent(/aviationweather\.gov/);
    const taf = screen.getByTestId("taf-timeline");
    await waitFor(() => expect(taf).toHaveAttribute("data-origin", "live"));
    expect(within(taf).getByTestId("taf-source")).toHaveTextContent(/TAF: NOAA Aviation Weather/);
  });

  it("demo: destination TAF timeline labelled SAMPLE with categories per period", () => {
    renderWeather(initialSimState, "demo");
    const taf = screen.getByTestId("taf-timeline");
    expect(taf).toHaveAttribute("data-station", "KATL");
    expect(taf).toHaveAttribute("data-origin", "sample");
    expect(within(taf).getByText("SAMPLE")).toBeInTheDocument();
    expect(within(taf).getByTestId("taf-source")).toHaveTextContent(/not a real forecast/);
    const periods = within(taf).getAllByTestId("taf-period");
    expect(periods.map((p) => p.getAttribute("data-kind"))).toEqual([
      "BASE",
      "TEMPO",
      "FM",
      "BECMG",
    ]);
    expect(periods.map((p) => p.getAttribute("data-category"))).toEqual([
      "MVFR",
      "IFR",
      "VFR",
      "VFR",
    ]);
    expect(within(taf).getAllByTestId("taf-segment")).toHaveLength(2);
    // No ETA given: no marker, no ETA line.
    expect(within(taf).queryByTestId("taf-eta-marker")).toBeNull();
    expect(within(taf).queryByTestId("taf-eta")).toBeNull();
    fireEvent.click(within(taf).getByTestId("taf-raw-toggle"));
    expect(within(taf).getByTestId("taf-raw")).toHaveTextContent(/^TAF KATL \d{6}Z \d{4}\/\d{4} /);
    expect(connectorJson).not.toHaveBeenCalled();
  });

  it("forecast={false} shows no TAF and asks for none", async () => {
    connectorJson.mockResolvedValue(sampleResponse(["KMEM", "KATL"]));
    render(
      <SimConnectionContext.Provider
        value={{ state: replayState(), send: () => {}, transportKind: "live" }}
      >
        <RouteWeather origin="KMEM" destination="KATL" forecast={false} />
      </SimConnectionContext.Provider>,
    );
    await waitFor(() => expect(connectorJson).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("taf-timeline")).toBeNull();
    expect(connectorJson).toHaveBeenCalledWith("/api/weather/metar?ids=KMEM,KATL&online=1");
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
