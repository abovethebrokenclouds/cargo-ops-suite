import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SimEvent, Snapshot, Source, Welcome } from "@cargo-ops/protocol";

import { initialSimState, simReducer, type ClientSimState } from "@/lib/sim-state";
import { SimConnectionContext, type TransportKind } from "@/lib/transport/useSimConnection";

import { LiveFlightView } from "./LiveFlightView";

const cruise: Snapshot["state"] = {
  sim: { connected: false, paused: false, simRate: 1 },
  aircraft: { title: "Cessna 208B Grand Caravan EX", atcId: "N401CO" },
  position: { lat: 34.5, lon: -87.25, altFt: 11500, aglFt: 10900 },
  motion: {
    iasKt: 148,
    tasKt: 175,
    gsKt: 180,
    hdgMagDeg: 106.4,
    hdgTrueDeg: 105.5,
    vsFpm: -10,
    gForce: 1,
    onGround: false,
  },
  fuel: { totalGal: 220.2, totalLb: 1475, flowPph: [355] },
  weights: { totalLb: 8205, emptyLb: 4730, maxGrossLb: 8750, payloadLb: 2000 },
  payload: { stations: [{ name: "Cargo Zone A", weightLb: 450 }] },
  engines: { running: [true] },
  controls: { parkingBrake: false },
  plan: { active: true, origin: "KMEM", destination: "KATL", destDistanceNm: 150 },
  flight: { active: true, plannedDistanceNm: 300, flownDistanceNm: 150 },
  phase: { current: "Cruise" },
};

function session(mode: Welcome["mode"], source: Source, state: Snapshot["state"]) {
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
    msg: { type: "snapshot", v: 1, seq: 0, source, state },
    at: Date.now(),
  });
  return s;
}

function addEvent(s: ClientSimState, seq: number, name: SimEvent["name"], data: unknown) {
  return simReducer(s, {
    type: "event",
    msg: { type: "event", v: 1, seq, source: s.source ?? "sim", name, data },
    at: Date.now(),
  });
}

function renderView(state: ClientSimState, transportKind: TransportKind | null = "demo") {
  return render(
    <SimConnectionContext.Provider value={{ state, send: () => {}, transportKind }}>
      <LiveFlightView />
    </SimConnectionContext.Provider>,
  );
}

const values = () => screen.getAllByTestId("metric-value");

describe("LiveFlightView", () => {
  it("shows em dashes everywhere with no data", () => {
    renderView(initialSimState, null);
    for (const v of values()) {
      expect(v).toHaveTextContent("—");
      expect(v).toHaveAttribute("data-empty");
    }
    expect(screen.getByTestId("aircraft-title")).toHaveTextContent("No aircraft loaded");
    expect(screen.getByTestId("atc-id")).toHaveTextContent("—");
    expect(screen.getByTestId("distance-remaining")).toHaveTextContent(/^—$/);
    expect(screen.getByTestId("position-lon")).toHaveTextContent("—");
    expect(screen.getByTestId("payload-lb")).toHaveTextContent("—");
    // No digits anywhere in the big readouts.
    for (const v of values()) expect(v.textContent).not.toMatch(/\d/);
    // Status lights claim nothing.
    const lights = within(screen.getByLabelText("Status lights")).getAllByText("—");
    expect(lights).toHaveLength(6);
    expect(screen.queryByText("DEMO")).toBeNull();
    expect(screen.getByText("Awaiting touchdown")).toBeInTheDocument();
    expect(screen.getByText("No flight plan")).toBeInTheDocument();
  });

  it("renders demo values with DEMO tags", () => {
    renderView(session("demo", "demo", cruise));
    const tile = (label: string) => screen.getByText(label, { selector: ".label-eyebrow" });
    expect(screen.getByTestId("aircraft-title")).toHaveTextContent("Cessna 208B Grand Caravan EX");
    expect(screen.getByTestId("atc-id")).toHaveTextContent("N401CO");
    const metric = (label: string) =>
      document.querySelector(`[data-metric="${label}"] [data-testid="metric-value"]`);
    expect(metric("Altitude")).toHaveTextContent("11,500");
    expect(metric("Airspeed")).toHaveTextContent("148");
    expect(metric("Fuel on board")).toHaveTextContent("1,475");
    expect(metric("Ground speed")).toHaveTextContent("180");
    expect(metric("Heading")).toHaveTextContent("106");
    expect(metric("Vertical speed")).toHaveTextContent("−10");
    expect(metric("Position")).toHaveTextContent("N34°30.00′");
    expect(screen.getByTestId("position-lon")).toHaveTextContent("W087°15.00′");
    expect(tile("Altitude")).toBeInTheDocument();
    // TAS shown when airborne; AGL hidden above 2,500 ft.
    expect(screen.getByText("175")).toBeInTheDocument();
    expect(document.querySelector('[data-readout="AGL"]')).toBeNull();
    // Route from the plan domain: 150 nm at 180 kt → 50 min; endurance 4h 09m is fine.
    expect(screen.getByTestId("distance-remaining")).toHaveTextContent("150");
    expect(screen.getByText("50m")).toBeInTheDocument();
    expect(screen.getByText("4h 09m")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByTestId("payload-lb")).toHaveTextContent("2,000");
    // Every telemetry tile is tagged.
    for (const t of document.querySelectorAll("[data-metric]")) {
      expect(t).toHaveAttribute("data-source", "demo");
      expect(within(t as HTMLElement).getByText("DEMO")).toBeInTheDocument();
    }
    expect(screen.getByTestId("phase-label")).toHaveTextContent("Cruise");
    expect(document.querySelector('[aria-current="step"]')).toHaveTextContent("Cruise");
  });

  it("shows live sim data without DEMO tags", () => {
    renderView(session("live", "sim", cruise), "live");
    expect(screen.queryByText("DEMO")).toBeNull();
    expect(screen.queryByText("REPLAY")).toBeNull();
    for (const t of document.querySelectorAll("[data-metric]")) {
      expect(t).toHaveAttribute("data-source", "sim");
    }
    expect(document.querySelector('[data-annunciator="Data"]')).toHaveTextContent("SIM");
  });

  it("shows AGL low, warns on endurance and badges a fast sim rate and pause", () => {
    renderView(
      session("live", "sim", {
        ...cruise,
        sim: { connected: true, paused: true, simRate: 8 },
        position: { lat: 34, lon: -85, altFt: 2400, aglFt: 1500 },
        fuel: { totalGal: 30, totalLb: 200, flowPph: [355] },
      }),
      "live",
    );
    expect(document.querySelector('[data-readout="AGL"]')).toHaveTextContent("1,500");
    expect(screen.getByRole("alert")).toHaveTextContent("Endurance below ETE + 45 min reserve");
    const rate = document.querySelector('[data-annunciator="Sim rate"]');
    expect(rate).toHaveTextContent("×8");
    expect(rate).toHaveClass("text-warning");
    expect(document.querySelector('[data-annunciator="Pause"]')).toHaveTextContent("PAUSED");
  });

  it("shows a landing card after a touchdown event", () => {
    let s = session("demo", "demo", { ...cruise, phase: { current: "Landing" } });
    s = addEvent(s, 1, "touchdown", {
      rateFpm: -142,
      gForce: 1.18,
      gsKt: 72,
      bankDeg: 0.8,
      pitchDeg: 4.6,
    });
    renderView(s);
    const card = screen.getByTestId("landing-card");
    expect(within(card).getByTestId("landing-grade")).toHaveTextContent("B");
    expect(within(card).getByText("Good")).toBeInTheDocument();
    expect(within(card).getByText("−142 fpm")).toBeInTheDocument();
    expect(within(card).getByText("1.18 G")).toBeInTheDocument();
    expect(within(card).getByText("72 kt")).toBeInTheDocument();
    expect(within(card).getByText("+0.8°")).toBeInTheDocument();
    expect(within(card).getByText("+4.6°")).toBeInTheDocument();
    expect(
      within(card).getByText(/Provisional — connector analyser arrives in P2/),
    ).toBeInTheDocument();
    expect(within(card).getByText("DEMO")).toBeInTheDocument();
  });
});
