import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { initialSimState, simReducer, type ClientSimState } from "@/lib/sim-state";
import { SimConnectionContext } from "@/lib/transport/useSimConnection";
import { resetWeatherStores, sampleResponse } from "@/lib/weather/use-metar";

import { MapView } from "./MapView";

const connectorJson = vi.fn<(path: string) => Promise<unknown>>();
vi.mock("@/lib/transport/connector-api", () => ({
  connectorJson: (path: string) => connectorJson(path),
}));
// The map itself is not under test: a stub that shows how many badges it was given.
vi.mock("./OpsMap", () => ({
  OpsMap: (props: { metarBadges?: readonly unknown[] }) => (
    <div data-testid="ops-map-stub" data-badges={props.metarBadges?.length ?? 0} />
  ),
}));
vi.mock("@/lib/map/airports", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/map/airports")>();
  const list = [
    {
      ident: "KMEM",
      name: "Memphis",
      type: "large",
      lat: 35.04,
      lon: -89.98,
      country: "US",
      region: "US-TN",
    },
    {
      ident: "KATL",
      name: "Atlanta",
      type: "large",
      lat: 33.64,
      lon: -84.43,
      country: "US",
      region: "US-GA",
    },
  ];
  const index = { list, byIdent: new Map(list.map((a) => [a.ident, a])) };
  return { ...real, loadAirports: () => Promise.resolve(index) };
});

function replayWithPlan(): ClientSimState {
  const welcomed = simReducer(initialSimState, {
    type: "welcome",
    msg: { type: "welcome", v: 1, session: "t", mode: "replay", sim: { connected: false } },
  });
  return {
    ...welcomed,
    sim: { ...welcomed.sim, plan: { origin: "KMEM", destination: "KATL" } },
  } as ClientSimState;
}

describe("MapView METAR badges", () => {
  beforeEach(() => {
    window.localStorage.clear();
    connectorJson.mockReset();
    resetWeatherStores();
    connectorJson.mockImplementation(async (path: string) => {
      if (path.startsWith("/api/weather/metar")) return sampleResponse(["KMEM", "KATL"]);
      throw new Error(`unexpected ${path}`);
    });
  });

  it("one METAR request for the badge stations; none at all with the layer off", async () => {
    render(
      <SimConnectionContext.Provider
        value={{ state: replayWithPlan(), send: () => {}, transportKind: "live" }}
      >
        <MapView />
      </SimConnectionContext.Provider>,
    );
    await waitFor(() =>
      expect(screen.getByTestId("ops-map-stub")).toHaveAttribute("data-badges", "2"),
    );
    const metarCalls = () =>
      connectorJson.mock.calls.filter((c) => c[0].startsWith("/api/weather/metar"));
    expect(metarCalls().map((c) => c[0])).toEqual(["/api/weather/metar?ids=KMEM,KATL&online=1"]);
    fireEvent.click(screen.getByTestId("weather-toggle"));
    await waitFor(() =>
      expect(screen.getByTestId("ops-map-stub")).toHaveAttribute("data-badges", "0"),
    );
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(metarCalls()).toHaveLength(1);
  });
});
