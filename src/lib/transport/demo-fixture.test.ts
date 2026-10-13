import { describe, expect, it } from "vitest";
import { FLIGHT_PHASES, type Frame } from "@cargo-ops/protocol";
import { actionFromMessage, initialSimState, simReducer } from "@/lib/sim-state/reducer";
import { currentPhase, fuelEnduranceMin } from "@/lib/sim-state/selectors";
import { getDemoFrames } from "./demo-fixture";
import text from "./fixtures/demo-kmem-katl.jsonl?raw";

describe("bundled demo fixture", () => {
  const frames = getDemoFrames();
  const msgs = frames.map((f) => f.msg as Frame);

  it("is valid, small, and starts with a full snapshot", () => {
    expect(text.length).toBeLessThan(400 * 1024);
    expect(frames.length).toBeGreaterThan(300);
    const first = msgs[0];
    expect(first?.type).toBe("snapshot");
    if (first?.type === "snapshot") {
      expect(first.state.position).toBeTruthy();
      expect(first.state.sim?.connected).toBe(false);
    }
  });

  it("marks every frame as demo with contiguous seq at ~1 Hz", () => {
    expect(msgs.every((m) => m.source === "demo")).toBe(true);
    expect(msgs.map((m) => m.seq)).toEqual(msgs.map((_, i) => i));
    const lastT = frames.at(-1)?.t ?? 0;
    expect(lastT).toBeGreaterThan(5 * 60_000);
    expect(lastT).toBeLessThan(7 * 60_000);
  });

  it("walks every phase in order and ends parked", () => {
    const names = msgs.flatMap((m) => (m.type === "event" ? [m.name] : []));
    expect(names[0]).toBe("flight.started");
    expect(names).toContain("touchdown");
    expect(names.at(-1)).toBe("flight.ended");
    const phases = msgs.flatMap((m) =>
      m.type === "event" && m.name === "phase.changed" ? [(m.data as { to: string }).to] : [],
    );
    expect(["Boarding", ...phases]).toEqual([...FLIGHT_PHASES]);

    let state = simReducer(initialSimState, {
      type: "welcome",
      msg: { type: "welcome", v: 1, session: "t", mode: "demo", sim: { connected: false } },
    });
    for (const msg of msgs) {
      const action = actionFromMessage(msg, 0);
      if (action) state = simReducer(state, action);
    }
    expect(state.needsResync).toBe(false);
    expect(currentPhase(state)).toBe("Arrived");
    expect(state.sim.controls?.parkingBrake).toBe(true);
    expect(state.sim.engines?.running).toEqual([false]);
    expect(state.sim.motion?.onGround).toBe(true);
    expect(state.sim.position?.lat).toBeCloseTo(33.64, 1);
    expect(state.sim.position?.lon).toBeCloseTo(-84.43, 1);
    expect(fuelEnduranceMin(state.sim.fuel)).toBeNull();
    expect(state.events.length).toBe(names.length);
  });
});
