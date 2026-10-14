import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { PROTOCOL_VERSION, type Result, type Snapshot } from "@cargo-ops/protocol";
import { airportLookup, type EconomyAirport } from "@cargo-ops/economy";
import { initialSimState, simReducer } from "@/lib/sim-state";
import { SimConnectionContext } from "@/lib/transport/useSimConnection";

import { DestinationPicker, PlanBasisTag } from "./DestinationPicker";
import { LiveFlightView } from "./LiveFlightView";

const airports: EconomyAirport[] = [
  {
    ident: "KATL",
    iata: "ATL",
    name: "Hartsfield-Jackson Atlanta",
    type: "large",
    lat: 33.64,
    lon: -84.43,
  },
  {
    ident: "KBNA",
    iata: "BNA",
    name: "Nashville International",
    type: "large",
    lat: 36.12,
    lon: -86.68,
  },
  {
    ident: "KMEM",
    iata: "MEM",
    name: "Memphis International",
    type: "large",
    lat: 35.04,
    lon: -89.98,
  },
];
const lookup = airportLookup(airports);

function ok(data: unknown): Result {
  return { type: "result", v: PROTOCOL_VERSION, id: "x", ok: true, data };
}

describe("DestinationPicker", () => {
  it("searches the airports and sends plan.destination with the picked ident", async () => {
    const command = vi.fn(async () => ok({ destination: "KATL", basis: "manual" }));
    render(
      <DestinationPicker
        lookup={lookup}
        basis={null}
        destination={null}
        missionDestination={null}
        enabled
        command={command}
      />,
    );
    expect(screen.getByTestId("destination-status")).toHaveTextContent(/No GPS flight plan/);
    fireEvent.change(screen.getByTestId("destination-search"), { target: { value: "atl" } });
    const results = screen.getAllByTestId("destination-result");
    expect(results[0]).toHaveAttribute("data-ident", "KATL");
    await act(async () => {
      fireEvent.click(results[0]!);
    });
    expect(command).toHaveBeenCalledWith("plan.destination", { icao: "KATL" });
    expect(screen.getByTestId("destination-message")).toHaveTextContent(
      "KATL set as the destination for this flight.",
    );
    expect(screen.queryByTestId("destination-results")).toBeNull();
  });

  it("says the GPS plan takes precedence when the connector answers with basis gps", async () => {
    const command = vi.fn(async () => ok({ destination: "KBNA", basis: "gps" }));
    render(
      <DestinationPicker
        lookup={lookup}
        basis="gps"
        destination={null}
        missionDestination={null}
        enabled
        command={command}
      />,
    );
    expect(screen.getByTestId("destination-status")).toHaveTextContent(/GPS flight plan is in use/);
    fireEvent.change(screen.getByTestId("destination-search"), { target: { value: "KBNA" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("destination-result"));
    });
    expect(screen.getByTestId("destination-message")).toHaveTextContent(/takes precedence/);
  });

  it("defaults to the mission destination and offers Clear only for a manual choice", async () => {
    const command = vi.fn(async () => ok({ destination: null, basis: "mission" }));
    const { rerender } = render(
      <DestinationPicker
        lookup={lookup}
        basis="mission"
        destination="KATL"
        missionDestination="KATL"
        enabled
        command={command}
      />,
    );
    expect(screen.getByTestId("destination-status")).toHaveTextContent(
      /Mission destination KATL \(default\)/,
    );
    expect(screen.getByTestId("destination-search")).toHaveAttribute(
      "placeholder",
      "Destination (mission: KATL)",
    );
    expect(screen.queryByTestId("destination-clear")).toBeNull();
    rerender(
      <DestinationPicker
        lookup={lookup}
        basis="manual"
        destination="KBNA"
        missionDestination="KATL"
        enabled
        command={command}
      />,
    );
    expect(screen.getByTestId("destination-status")).toHaveTextContent(/not GPS/);
    await act(async () => {
      fireEvent.click(screen.getByTestId("destination-clear"));
    });
    expect(command).toHaveBeenCalledWith("plan.destination", { icao: null });
    expect(screen.getByTestId("destination-message")).toHaveTextContent(
      /back to the mission's destination/,
    );
  });

  it("shows the connector's refusal", async () => {
    const command = vi.fn(async (): Promise<Result> => ({
      type: "result",
      v: PROTOCOL_VERSION,
      id: "x",
      ok: false,
      error: { code: "unknown_airport", message: "KZZZ is not in the airport list" },
    }));
    render(
      <DestinationPicker
        lookup={airportLookup([
          ...airports,
          { ident: "KZZZ", name: "Nowhere", type: "medium", lat: 0, lon: 1 },
        ])}
        basis={null}
        destination={null}
        missionDestination={null}
        enabled
        command={command}
      />,
    );
    fireEvent.change(screen.getByTestId("destination-search"), { target: { value: "KZZZ" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("destination-result"));
    });
    expect(screen.getByRole("alert")).toHaveTextContent("unknown_airport");
  });

  it("is disabled with a reason (demo, simulator offline)", () => {
    render(
      <DestinationPicker
        lookup={null}
        basis="gps"
        destination="KATL"
        missionDestination={null}
        enabled={false}
        disabledNote="Demo flight: picking a destination needs the local connector."
        command={vi.fn()}
      />,
    );
    expect(screen.getByTestId("destination-search")).toBeDisabled();
    expect(screen.getByTestId("destination-disabled")).toHaveTextContent(/local connector/);
  });
});

describe("PlanBasisTag", () => {
  it("labels each basis and renders nothing without a plan", () => {
    const { rerender, container } = render(<PlanBasisTag basis={null} />);
    expect(container).toBeEmptyDOMElement();
    for (const [basis, label] of [
      ["gps", "GPS plan"],
      ["manual", "Manual"],
      ["mission", "Mission"],
    ] as const) {
      rerender(<PlanBasisTag basis={basis} />);
      expect(screen.getByTestId("plan-basis")).toHaveTextContent(label);
      expect(screen.getByTestId("plan-basis")).toHaveAttribute("data-basis", basis);
    }
  });
});

describe("LiveFlightView route source label", () => {
  function state(plan: Snapshot["state"]["plan"], mode: "live" | "demo" = "live") {
    let s = simReducer(initialSimState, {
      type: "welcome",
      msg: {
        type: "welcome",
        v: 1,
        session: "t",
        mode,
        sim: mode === "live" ? { connected: true, name: "MSFS 2024" } : { connected: false },
      },
    });
    s = simReducer(s, {
      type: "snapshot",
      msg: {
        type: "snapshot",
        v: 1,
        seq: 0,
        source: mode === "live" ? "sim" : "demo",
        state: {
          sim: { connected: true, paused: false, simRate: 1, name: "MSFS 2024" },
          position: { lat: 34.5, lon: -87.25, altFt: 9500, aglFt: 9000 },
          plan,
        },
      },
      at: Date.now(),
    });
    return s;
  }

  it("shows Manual with the connector's distance and ETE, and the picker for a live session", async () => {
    const s = state({
      active: true,
      basis: "manual",
      origin: "KMEM",
      destination: "KATL",
      destDistanceNm: 168.2,
      eteSec: 3600,
    });
    render(
      <SimConnectionContext.Provider
        value={{ state: s, send: () => {}, transportKind: "live", command: vi.fn() }}
      >
        <LiveFlightView />
      </SimConnectionContext.Provider>,
    );
    expect(screen.getByTestId("plan-basis")).toHaveTextContent("Manual");
    expect(screen.getByTestId("distance-remaining")).toHaveTextContent("168");
    expect(screen.getByText("KMEM → KATL")).toBeInTheDocument();
    expect(screen.getByText(/1h 00m|60 min|1:00/)).toBeInTheDocument();
    // Enabled once the bundled airports (a lazy ~1.1 MB JSON import) have loaded.
    await waitFor(() => expect(screen.getByTestId("destination-search")).toBeEnabled(), {
      timeout: 15_000,
    });
  }, 20_000);

  it("labels a demo plan without a basis as a GPS plan and disables the picker", () => {
    const s = state(
      { active: true, origin: "KMEM", destination: "KATL", destDistanceNm: 150 },
      "demo",
    );
    render(
      <SimConnectionContext.Provider value={{ state: s, send: () => {}, transportKind: "demo" }}>
        <LiveFlightView />
      </SimConnectionContext.Provider>,
    );
    expect(screen.getByTestId("plan-basis")).toHaveTextContent("GPS plan");
    expect(screen.getByTestId("destination-search")).toBeDisabled();
    expect(screen.getByTestId("destination-disabled")).toHaveTextContent(/local connector/);
  });
});
