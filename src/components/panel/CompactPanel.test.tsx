import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Mission, Snapshot, Source, Welcome } from "@cargo-ops/protocol";
import { checkPayload } from "@cargo-ops/economy";

import { DEFAULT_UNITS } from "@/lib/settings/units";
import { initialSimState, simReducer, type ClientSimState } from "@/lib/sim-state";
import { sampleResponse, type MetarState } from "@/lib/weather/use-metar";

import { CompactPanel } from "./CompactPanel";
import { panelSourceNote } from "./panel-note";

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
  engines: { running: [true] },
  controls: { parkingBrake: false },
  plan: { active: true, origin: "KMEM", destination: "KATL", destDistanceNm: 150 },
  flight: { active: true, plannedDistanceNm: 300, flownDistanceNm: 150 },
  phase: { current: "Cruise" },
};

function mission(source: Source): Mission {
  return {
    id: "M-7",
    status: "in_progress",
    origin: "KMEM",
    destination: "KATL",
    jobIds: ["J-1"],
    jobs: [{ kind: "express" } as Mission["jobs"][number]],
    aircraftKey: "c208",
    payloadKg: 840,
    distanceNm: 288,
    timeLimitMin: 150,
    elapsedMin: 40,
    expectedPayout: 5200,
    createdAt: "2026-10-14T12:00:00.000Z",
    payloadCheck: checkPayload({
      cargoKg: 840,
      stations: [
        { name: "Cargo Zone A", weightLb: 450 },
        { name: "Cargo Zone B", weightLb: 520 },
        { name: "Cargo Zone C", weightLb: 480 },
        { name: "Cargo Pod", weightLb: 380 },
      ],
      weights: { totalLb: 8430, maxGrossLb: 8750 },
      source,
      stage: "departure",
      checkedAt: "2026-10-14T12:00:00.000Z",
    }),
  };
}

function session(
  mode: Welcome["mode"],
  source: Source,
  opts: { simConnected?: boolean; withMission?: boolean } = {},
): ClientSimState {
  const connected = opts.simConnected ?? mode === "live";
  let s = simReducer(initialSimState, {
    type: "welcome",
    msg: {
      type: "welcome",
      v: 1,
      session: "t",
      mode,
      sim: connected
        ? { connected: true, name: "MSFS 2024", protocol: "SunRise" }
        : { connected: false },
    },
  });
  const base = { ...cruise, sim: { ...cruise.sim, connected } };
  const state = opts.withMission ? { ...base, mission: mission(source) } : base;
  s = simReducer(s, {
    type: "snapshot",
    msg: { type: "snapshot", v: 1, seq: 0, source, state },
    at: Date.now(),
  });
  return s;
}

const idleMetar: MetarState = { status: "idle" };

function renderPanel(
  state: ClientSimState,
  extra: { metar?: MetarState; now?: number | null; pairingRequired?: boolean } = {},
) {
  return render(
    <CompactPanel
      state={state}
      now={extra.now === undefined ? Date.now() : extra.now}
      units={DEFAULT_UNITS}
      fleet={null}
      fleetSource={null}
      metar={extra.metar ?? idleMetar}
      {...(extra.pairingRequired ? { pairingRequired: true } : {})}
    />,
  );
}

const chip = () => screen.getByRole("status");
/** "LIVE" as a word anywhere in the panel (LIVE chip, live METAR tag …). */
const showsLive = () => /\bLIVE\b/.test(screen.getByTestId("compact-panel").textContent ?? "");

describe("CompactPanel (/panel)", () => {
  it("before the connector answers: CONNECTING, no data sections, never LIVE", () => {
    renderPanel({ ...initialSimState, connection: "connecting" });
    expect(chip()).toHaveAttribute("data-status", "connecting");
    expect(screen.getByTestId("panel-source-note")).toHaveTextContent("Connecting to Cargo Ops");
    expect(screen.queryByTestId("panel-mission")).toBeNull();
    expect(screen.queryByTestId("panel-route")).toBeNull();
    expect(showsLive()).toBe(false);
  });

  it("connector offline: says how to start it, shows no data, never LIVE", () => {
    renderPanel({ ...initialSimState, connection: "disconnected", error: "connector unreachable" });
    expect(chip()).toHaveTextContent("CONNECTOR OFFLINE");
    expect(screen.getByTestId("panel-source-note")).toHaveTextContent(
      "Start scripts\\start-cargo-ops.cmd on this PC",
    );
    expect(screen.queryByTestId("panel-lamps")).toBeNull();
    expect(showsLive()).toBe(false);
  });

  it('a "live" connection without a welcome is never LIVE', () => {
    renderPanel({ ...initialSimState, connection: "live" });
    expect(chip()).not.toHaveAttribute("data-status", "live");
    expect(chip()).toHaveTextContent("SIM OFFLINE");
    expect(showsLive()).toBe(false);
  });

  it("connector up, simulator not running: SIM OFFLINE and no live readouts", () => {
    renderPanel(session("live", "sim", { simConnected: false }));
    expect(chip()).toHaveTextContent("SIM OFFLINE");
    expect(screen.getByTestId("panel-source-note")).toHaveTextContent("Start a flight");
    expect(showsLive()).toBe(false);
    const link = screen
      .getAllByTestId("panel-lamp")
      .find((l) => l.getAttribute("data-lamp") === "link");
    expect(link).toHaveAttribute("data-state", "nogo");
  });

  it("live simulator after a real welcome: LIVE chip, values, no DEMO/REPLAY tags", () => {
    renderPanel(session("live", "sim", { withMission: true }));
    expect(chip()).toHaveAttribute("data-status", "live");
    expect(chip()).toHaveTextContent("LIVE · MSFS 2024 · SunRise");
    expect(chip().querySelector("[data-live]")).toBeNull(); // nothing pulses in the panel
    expect(screen.queryByTestId("panel-source-note")).toBeNull();
    expect(document.querySelector("[data-source-tag]")).toBeNull();

    expect(screen.getByTestId("panel-mission-route")).toHaveTextContent("KMEM → KATL");
    expect(screen.getByTestId("panel-cargo")).toHaveTextContent("840 kg · Express");
    expect(screen.getByTestId("panel-deadline")).toHaveTextContent("1h 50m left");
    expect(
      within(screen.getByTestId("panel-payload")).getByTestId("payload-check-pill"),
    ).toHaveAttribute("data-status", "ok");

    expect(screen.getByTestId("panel-route-pair")).toHaveTextContent("KMEM → KATL");
    expect(screen.getByTestId("plan-basis")).toHaveAttribute("data-basis", "gps");
    expect(screen.getByTestId("panel-distance")).toHaveTextContent("150 nm");
    expect(screen.getByTestId("panel-ete")).toHaveTextContent("50m");
    expect(screen.getByTestId("panel-fuel-total")).toHaveTextContent("1,475 lb");
    expect(screen.getByTestId("panel-fuel-check")).toHaveTextContent("OK");
    expect(screen.getByTestId("panel-board-summary")).toHaveTextContent("GO");
  });

  it("replay: REPLAY chip and REPLAY tags on the data, never LIVE", () => {
    renderPanel(session("replay", "replay", { withMission: true }));
    expect(chip()).toHaveAttribute("data-status", "replay");
    expect(chip()).toHaveTextContent("REPLAY");
    expect(screen.getByTestId("panel-source-note")).toHaveTextContent("not live data");
    for (const id of ["panel-mission", "panel-route", "panel-fuel", "panel-lamps"]) {
      expect(
        within(screen.getByTestId(id)).getAllByText("REPLAY", { selector: "[data-source-tag]" })
          .length,
      ).toBeGreaterThan(0);
    }
    expect(showsLive()).toBe(false);
  });

  it("demo: DEMO DATA chip and DEMO tags, never LIVE; sample weather is marked SAMPLE", () => {
    const metar: MetarState = { status: "ready", data: sampleResponse(["KMEM", "KATL"]) };
    renderPanel(session("demo", "demo"), { metar });
    expect(chip()).toHaveAttribute("data-status", "demo");
    expect(chip()).toHaveTextContent("DEMO DATA");
    expect(
      within(screen.getByTestId("panel-route")).getByText("DEMO", {
        selector: "[data-source-tag]",
      }),
    ).toBeInTheDocument();
    const stations = screen.getAllByTestId("panel-wx-station");
    expect(stations.map((s) => s.getAttribute("data-station"))).toEqual(["KMEM", "KATL"]);
    for (const s of stations) {
      expect(within(s).getByText("SAMPLE")).toBeInTheDocument();
      expect(within(s).getByTestId("flight-category")).not.toHaveAttribute(
        "data-category",
        "unknown",
      );
    }
    expect(showsLive()).toBe(false);
  });

  it("no mission and no plan: says so instead of numbers", () => {
    const s = session("replay", "replay");
    renderPanel({ ...s, sim: { ...s.sim, plan: undefined } } as ClientSimState);
    expect(screen.getByTestId("panel-no-mission")).toHaveTextContent("No active mission");
    expect(within(screen.getByTestId("panel-route")).getByText(/No route yet/)).toBeTruthy();
  });

  it("old frames are marked STALE", () => {
    const s = session("replay", "replay");
    renderPanel({ ...s, lastFrameAt: 1_000 }, { now: 60_000 });
    expect(screen.getByTestId("panel-route")).toHaveAttribute("data-stale");
    expect(within(screen.getByTestId("panel-fuel")).getByText("STALE")).toBeInTheDocument();
  });

  it("is read-only: no buttons, inputs or links", () => {
    renderPanel(session("live", "sim", { withMission: true }));
    const root = screen.getByTestId("compact-panel");
    expect(root.querySelectorAll("button, input, select, textarea, a, form")).toHaveLength(0);
  });

  it("an unpaired LAN device gets no data", () => {
    renderPanel(session("live", "sim"), { pairingRequired: true });
    expect(screen.getByTestId("panel-source-note")).toHaveTextContent("PC that runs Cargo Ops");
    expect(screen.queryByTestId("panel-mission")).toBeNull();
  });

  it("panelSourceNote covers every connection state", () => {
    expect(panelSourceNote({ ...initialSimState, connection: "error" })).toMatch(/not reachable/);
    expect(panelSourceNote({ ...initialSimState, connection: "idle" })).toMatch(/Connecting/);
    expect(panelSourceNote(session("live", "sim"))).toBeNull();
  });
});
