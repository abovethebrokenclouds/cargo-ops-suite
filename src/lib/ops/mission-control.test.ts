import { describe, expect, it } from "vitest";
import type {
  FleetAircraft,
  FleetState,
  SimEvent,
  Snapshot,
  Source,
  Welcome,
} from "@cargo-ops/protocol";
import { initialSimState, simReducer, type ClientSimState } from "@/lib/sim-state";

import {
  boardSummary,
  describeEvent,
  formatMet,
  formatUtc,
  goNoGoLamps,
  loopLines,
  missionElapsedSec,
  utcDayOfYear,
  type GoNoGoInput,
  type Lamp,
} from "./mission-control";

function session(mode: Welcome["mode"], connected = false): ClientSimState {
  return simReducer(initialSimState, {
    type: "welcome",
    msg: { type: "welcome", v: 1, session: "s", mode, sim: { connected } },
  });
}

function withSnapshot(
  state: Snapshot["state"],
  { mode = "demo", source = "demo", at = 1000, connected = false } = {} as {
    mode?: Welcome["mode"];
    source?: Source;
    at?: number;
    connected?: boolean;
  },
): ClientSimState {
  return simReducer(session(mode, connected), {
    type: "snapshot",
    msg: { type: "snapshot", v: 1, seq: 0, source, state },
    at,
  });
}

const noWx = { station: null, category: null, sample: false, source: null };

function lamps(state: ClientSimState, extra: Partial<GoNoGoInput> = {}): Record<string, Lamp> {
  const list = goNoGoLamps({
    state,
    now: 1500,
    fleet: null,
    fleetSource: null,
    weather: noWx,
    ...extra,
  });
  return Object.fromEntries(list.map((l) => [l.id, l]));
}

const FULL: Snapshot["state"] = {
  sim: { connected: true, paused: false, simRate: 1 },
  position: { lat: 35, lon: -90, altFt: 5000, aglFt: 4700 },
  motion: {
    iasKt: 150,
    tasKt: 160,
    gsKt: 180,
    hdgMagDeg: 90,
    hdgTrueDeg: 89,
    vsFpm: 500,
    gForce: 1,
    onGround: false,
  },
  fuel: { totalGal: 200, totalLb: 1340, flowPph: [300] },
  weights: { totalLb: 8000, emptyLb: 4700, maxGrossLb: 8750, payloadLb: 2000 },
  controls: { parkingBrake: false },
  plan: { active: true, origin: "KMEM", destination: "KATL", destDistanceNm: 180 },
  flight: { active: true, elapsedSec: 3723 },
};

function aircraft(over: Partial<FleetAircraft> = {}): FleetAircraft {
  return {
    id: "a1",
    registration: "N1CO",
    typeKey: "c208",
    typeName: "Caravan",
    ownership: "owned",
    status: "available",
    location: "KMEM",
    hours: 0,
    cycles: 0,
    condition: 90,
    airworthy: true,
    purchasePrice: 0,
    value: 0,
    repairCost: 0,
    repairHours: 0,
    financed: false,
    acquiredAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const fleetOf = (a: FleetAircraft): FleetState => ({
  aircraft: [a],
  selectedId: a.id,
  selection: "manual",
  ambiguous: false,
  value: 0,
});

describe("goNoGoLamps", () => {
  it("lights nothing before a welcome: every lamp is NO DATA", () => {
    const all = goNoGoLamps({
      state: initialSimState,
      now: null,
      fleet: null,
      fleetSource: null,
      weather: noWx,
    });
    expect(all).toHaveLength(10);
    for (const l of all) {
      expect(l.state, l.id).toBe("nodata");
      expect(l.value).toBe("NO DATA");
      expect(l.source).toBeNull();
    }
    expect(boardSummary(all)).toEqual({ go: 0, hold: 0, nogo: 0, info: 0, nodata: 10 });
  });

  it("a demo session's link is HOLD (DEMO), never GO", () => {
    const l = lamps(withSnapshot(FULL))["link"];
    expect(l?.state).toBe("hold");
    expect(l?.value).toBe("DEMO");
    expect(l?.source).toBe("demo");
  });

  it("the link is GO only for a live welcome with the simulator running", () => {
    expect(lamps(session("live", true))["link"]?.state).toBe("go");
    const off = lamps(session("live", false))["link"];
    expect(off?.state).toBe("nogo");
    expect(off?.value).toBe("SIM OFF");
    const down = simReducer(session("live", true), { type: "status", status: "disconnected" });
    expect(lamps(down)["link"]?.value).toBe("OFFLINE");
  });

  it("derives telemetry lamps from the frame and tags them with its source", () => {
    const l = lamps(withSnapshot(FULL, { mode: "replay", source: "replay" }));
    expect(l["fresh"]).toMatchObject({ state: "go", source: "replay" });
    expect(l["brake"]).toMatchObject({ state: "info", value: "OFF" });
    expect(l["ground"]).toMatchObject({ state: "info", value: "AIRBORNE" });
    expect(l["rate"]).toMatchObject({ state: "go", value: "×1" });
    expect(l["weight"]).toMatchObject({ state: "go" });
    // 1340 lb at 300 pph = 268 min endurance; ETE 180 nm at 180 kt = 60 min (+45 reserve).
    expect(l["fuel"]).toMatchObject({ state: "go", source: "replay" });
  });

  it("flags stale data, low fuel, high sim rate and overweight", () => {
    const s = withSnapshot({
      ...FULL,
      sim: { connected: true, paused: false, simRate: 8 },
      fuel: { totalGal: 20, totalLb: 134, flowPph: [300] },
      weights: { totalLb: 9000, emptyLb: 4700, maxGrossLb: 8750, payloadLb: 2000 },
    });
    const l = goNoGoLamps({ state: s, now: 10_000, fleet: null, fleetSource: null, weather: noWx });
    const by = Object.fromEntries(l.map((x) => [x.id, x]));
    expect(by["fresh"]).toMatchObject({ state: "nogo", value: "STALE" });
    expect(by["fuel"]).toMatchObject({ state: "nogo", value: "LOW" });
    expect(by["rate"]).toMatchObject({ state: "nogo", value: "×8" });
    expect(by["weight"]).toMatchObject({ state: "nogo", value: "OVER" });
  });

  it("keeps fuel NO DATA without an ETE (no ground speed)", () => {
    const s = withSnapshot({ ...FULL, motion: { ...FULL.motion!, gsKt: 0 } });
    expect(lamps(s)["fuel"]?.state).toBe("nodata");
  });

  it("payload: NO DATA without a mission, else the connector's check", () => {
    expect(lamps(withSnapshot(FULL))["payload"]?.state).toBe("nodata");
  });

  it("airworthiness from the selected fleet aircraft", () => {
    const s = withSnapshot(FULL);
    expect(lamps(s)["airworthy"]?.state).toBe("nodata");
    expect(
      lamps(s, { fleet: fleetOf(aircraft()), fleetSource: "demo" })["airworthy"],
    ).toMatchObject({ state: "go", source: "demo" });
    expect(
      lamps(s, { fleet: fleetOf(aircraft({ airworthy: false })), fleetSource: "sim" })["airworthy"],
    ).toMatchObject({ state: "nogo", value: "GROUNDED" });
    // A fleet without a source is not trusted.
    expect(lamps(s, { fleet: fleetOf(aircraft()), fleetSource: null })["airworthy"]?.state).toBe(
      "nodata",
    );
  });

  it("weather: category maps to GO / HOLD / NO-GO and sample reports are marked", () => {
    const s = withSnapshot(FULL);
    const wx = (category: "VFR" | "MVFR" | "IFR" | "LIFR" | null, sample = true) =>
      lamps(s, { weather: { station: "KATL", category, sample, source: "demo" } })["wx"];
    expect(wx("VFR")).toMatchObject({ state: "go", sample: true, value: "VFR" });
    expect(wx("MVFR")?.state).toBe("hold");
    expect(wx("IFR")?.state).toBe("nogo");
    expect(wx("LIFR")?.state).toBe("nogo");
    expect(wx(null)?.state).toBe("nodata");
  });

  it("live with the simulator offline: no FRESH, no telemetry lamps, no payload preview", () => {
    const preview = {
      stage: "preview",
      status: "ok",
      source: "sim",
      cargoKg: 840,
      toleranceKg: 84,
      checkedAt: "2026-10-14T12:00:00.000Z",
      message: "Sim payload matches the cargo",
    } as const;
    const s = withSnapshot(
      {
        ...FULL,
        mission: { payloadCheck: preview } as unknown as NonNullable<Snapshot["state"]["mission"]>,
      },
      { mode: "live", source: "sim", connected: false },
    );
    const l = lamps(s);
    expect(l["link"]).toMatchObject({ state: "nogo", value: "SIM OFF" });
    expect(l["fresh"]).toMatchObject({ state: "nodata", value: "SIM OFF", source: null });
    for (const id of ["brake", "ground", "fuel", "rate", "weight", "payload"]) {
      expect(l[id]?.state, id).toBe("nodata");
    }
  });

  it("payload lamp: over max gross only by the payload you entered is a caution, not a no-go", () => {
    const over = {
      stage: "preview",
      status: "overloaded",
      overBasis: "entered",
      enteredKg: 2500,
      enteredRole: "used",
      source: "sim",
      cargoKg: 840,
      toleranceKg: 84,
      checkedAt: "2026-10-14T12:00:00.000Z",
      message: "Empty weight + fuel + the payload entered by you is above the maximum",
    } as const;
    const s = withSnapshot({
      ...FULL,
      mission: { payloadCheck: over } as unknown as NonNullable<Snapshot["state"]["mission"]>,
    });
    expect(lamps(s)["payload"]).toMatchObject({ state: "hold", value: "OVER (YOURS)" });
  });

  it("drops telemetry lamps to NO DATA once the session ends", () => {
    const s = simReducer(withSnapshot(FULL), { type: "status", status: "disconnected" });
    const l = lamps(s);
    for (const id of ["brake", "ground", "fuel", "rate", "weight", "payload"]) {
      expect(l[id]?.state, id).toBe("nodata");
    }
  });
});

describe("clocks", () => {
  it("formats the mission elapsed time", () => {
    expect(formatMet(null)).toBe("T+--:--:--");
    expect(formatMet(0)).toBe("T+00:00:00");
    expect(formatMet(3723.9)).toBe("T+01:02:03");
    expect(formatMet(-1)).toBe("T+--:--:--");
  });

  it("reads MET from the tracked flight clock only", () => {
    expect(missionElapsedSec(initialSimState)).toBeNull();
    expect(missionElapsedSec(withSnapshot(FULL))).toBe(3723);
    expect(missionElapsedSec(withSnapshot({ flight: { active: true, blockMin: 2 } }))).toBe(120);
    expect(missionElapsedSec(withSnapshot({ flight: { active: false } }))).toBeNull();
  });

  it("formats UTC and the day of year", () => {
    const t = Date.UTC(2026, 9, 14, 3, 4, 5);
    expect(formatUtc(t)).toBe("03:04:05Z");
    expect(formatUtc(null)).toBe("--:--:--Z");
    expect(utcDayOfYear(t)).toBe("287");
    expect(utcDayOfYear(Date.UTC(2026, 0, 1))).toBe("001");
    expect(utcDayOfYear(null)).toBeNull();
  });
});

describe("event loop", () => {
  const ev = (
    seq: number,
    name: SimEvent["name"],
    data: unknown = null,
    source: Source = "sim",
  ) => ({
    at: seq * 1000,
    msg: { type: "event", v: 1, seq, source, name, data } as SimEvent,
  });

  it("describes events from the fields present", () => {
    expect(describeEvent(ev(1, "phase.changed", { from: "Climb", to: "Cruise" })).text).toBe(
      "PHASE Climb → Cruise",
    );
    expect(
      describeEvent(ev(2, "flight.started", { origin: "KMEM", destination: "KATL" })).text,
    ).toBe("FLIGHT STARTED KMEM → KATL");
    expect(describeEvent(ev(3, "touchdown", { rateFpm: -142.4, grade: "A" })).text).toBe(
      "TOUCHDOWN · -142 fpm · grade A",
    );
    expect(describeEvent(ev(4, "touchdown", {})).text).toBe("TOUCHDOWN");
    expect(describeEvent(ev(5, "sim.paused", { paused: false })).text).toBe("SIM RESUMED");
    expect(describeEvent(ev(5, "sim.paused", { paused: true, event: "SimStop" })).text).toBe(
      "SIM STOPPED · MAIN MENU",
    );
    expect(describeEvent(ev(5, "sim.paused", { paused: false, event: "SimStart" })).text).toBe(
      "SIM RESUMED",
    );
    expect(
      describeEvent(ev(5, "sim.paused", { paused: false, event: "stuck_pause", flags: 4 })).text,
    ).toBe("SIM RESUMED · STUCK PAUSE IGNORED");
    expect(describeEvent(ev(6, "sim.rate", { rate: 4 })).text).toBe("SIM RATE ×4");
    expect(describeEvent(ev(7, "loan.missed", null)).text).toBe("LOAN MISSED");
    expect(describeEvent(ev(7, "loan.missed", null)).tone).toBe("nogo");
    expect(describeEvent(ev(8, "crash", null)).tone).toBe("nogo");
  });

  it("lists newest first, keeps each event's own source, caps the count", () => {
    const events = [ev(1, "flight.started", null, "replay"), ev(2, "touchdown", null, "replay")];
    const lines = loopLines(events);
    expect(lines.map((l) => l.seq)).toEqual([2, 1]);
    expect(lines.every((l) => l.source === "replay")).toBe(true);
    const many = Array.from({ length: 80 }, (_, i) => ev(i + 1, "sim.rate", { rate: 1 }));
    expect(loopLines(many, 50)).toHaveLength(50);
    expect(loopLines([])).toEqual([]);
  });
});
