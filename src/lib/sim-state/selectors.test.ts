import { describe, expect, it } from "vitest";
import type { Welcome } from "@cargo-ops/protocol";
import { initialSimState, simReducer, type ClientSimState } from "./reducer";
import {
  currentPhase,
  destinationEteMin,
  eteMin,
  frameAgeMs,
  fuelEnduranceMin,
  isDemo,
  isLive,
  isSimConnected,
  recentEvents,
  statusLabel,
} from "./selectors";

const welcome = (over: Partial<Welcome> = {}): Welcome => ({
  type: "welcome",
  v: 1,
  session: "s",
  mode: "live",
  sim: { connected: true, name: "MSFS 2024", protocol: "SunRise" },
  ...over,
});

function withWelcome(msg: Welcome): ClientSimState {
  return simReducer(initialSimState, { type: "welcome", msg });
}

describe("statusLabel", () => {
  it("labels a live session with sim name and protocol", () => {
    const s = withWelcome(welcome());
    expect(statusLabel(s)).toBe("LIVE · MSFS 2024 · SunRise");
    expect(isLive(s)).toBe(true);
    expect(isSimConnected(s)).toBe(true);
  });

  it("omits missing parts", () => {
    expect(statusLabel(withWelcome(welcome({ sim: { connected: true } })))).toBe("LIVE");
  });

  it("shows SIM OFFLINE when the connector is up but the sim is not", () => {
    const s = withWelcome(welcome({ sim: { connected: false } }));
    expect(statusLabel(s)).toBe("SIM OFFLINE");
    expect(isLive(s)).toBe(true);
    expect(isSimConnected(s)).toBe(false);
  });

  it("prefers the sim domain over the welcome for sim connection", () => {
    let s = withWelcome(welcome());
    s = simReducer(s, {
      type: "snapshot",
      msg: {
        type: "snapshot",
        v: 1,
        seq: 0,
        source: "sim",
        state: { sim: { connected: false, paused: false, simRate: 1 } },
      },
      at: 0,
    });
    expect(statusLabel(s)).toBe("SIM OFFLINE");
  });

  it("labels demo, replay and transport states", () => {
    const demo = withWelcome(welcome({ mode: "demo", sim: { connected: false } }));
    expect(statusLabel(demo)).toBe("DEMO DATA");
    expect(isDemo(demo)).toBe(true);
    expect(isLive(demo)).toBe(false);
    expect(isSimConnected(withWelcome(welcome({ mode: "demo" })))).toBe(false);
    expect(statusLabel(withWelcome(welcome({ mode: "replay" })))).toBe("REPLAY");
    expect(statusLabel(initialSimState)).toBe("IDLE");
    const status = (st: "connecting" | "disconnected" | "error") =>
      statusLabel(simReducer(initialSimState, { type: "status", status: st }));
    expect(status("connecting")).toBe("CONNECTING");
    expect(status("disconnected")).toBe("CONNECTOR OFFLINE");
    expect(status("error")).toBe("CONNECTION ERROR");
  });
});

describe("fuelEnduranceMin", () => {
  it("divides total pounds by total flow", () => {
    expect(fuelEnduranceMin({ totalGal: 0, totalLb: 600, flowPph: [200, 100] })).toBe(120);
  });

  it("returns null with no fuel data, no flow, or near-zero flow", () => {
    expect(fuelEnduranceMin(null)).toBeNull();
    expect(fuelEnduranceMin(undefined)).toBeNull();
    expect(fuelEnduranceMin({ totalGal: 0, totalLb: 600, flowPph: [] })).toBeNull();
    expect(fuelEnduranceMin({ totalGal: 0, totalLb: 600, flowPph: [0, 0.2] })).toBeNull();
  });
});

describe("eteMin", () => {
  it("computes minutes from nautical miles and knots", () => {
    expect(eteMin(120, 160)).toBe(45);
    expect(eteMin(0, 100)).toBe(0);
  });

  it("returns null for missing, negative or stationary inputs", () => {
    expect(eteMin(null, 100)).toBeNull();
    expect(eteMin(100, undefined)).toBeNull();
    expect(eteMin(-1, 100)).toBeNull();
    expect(eteMin(100, 0)).toBeNull();
    expect(eteMin(100, 0.5)).toBeNull();
    expect(eteMin(Number.NaN, 100)).toBeNull();
  });

  it("derives destination ETE from plan and motion domains", () => {
    let s = withWelcome(welcome());
    expect(destinationEteMin(s)).toBeNull();
    s = simReducer(s, {
      type: "snapshot",
      msg: {
        type: "snapshot",
        v: 1,
        seq: 0,
        source: "sim",
        state: {
          plan: { active: true, destDistanceNm: 85 },
          motion: {
            iasKt: 150,
            tasKt: 165,
            gsKt: 170,
            hdgMagDeg: 100,
            hdgTrueDeg: 97,
            vsFpm: 0,
            gForce: 1,
            onGround: false,
          },
          phase: { current: "Cruise" },
        },
      },
      at: 1000,
    });
    expect(destinationEteMin(s)).toBe(30);
    expect(currentPhase(s)).toBe("Cruise");
    expect(frameAgeMs(s, 1500)).toBe(500);
  });
});

describe("misc selectors", () => {
  it("returns no phase or frame age without data", () => {
    expect(currentPhase(initialSimState)).toBeNull();
    expect(frameAgeMs(initialSimState, 10)).toBeNull();
  });

  it("returns recent events newest first", () => {
    let s = withWelcome(welcome());
    for (let seq = 0; seq < 5; seq++) {
      s = simReducer(s, {
        type: "event",
        msg: { type: "event", v: 1, seq, source: "sim", name: "sim.rate", data: seq },
        at: seq,
      });
    }
    expect(recentEvents(s, 2).map((e) => e.msg.seq)).toEqual([4, 3]);
  });
});
