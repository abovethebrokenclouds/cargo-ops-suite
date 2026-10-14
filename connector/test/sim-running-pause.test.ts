// SimStart / SimStop and the "Sim" system state combined with Pause / Pause_EX1 (plan §14.4:
// the pause events misreport in some builds). Effective pause = pause flag OR sim not
// running; a SimStop (main menu) freezes the flight's sim clock like a pause, a SimStart
// resumes it; a pause flag that never clears is overridden only by the conservative
// stuck-pause rule in connector/src/sim/pause-state.ts. A stop is not a disconnect: the link
// stays up and the running flight keeps its id.
//
// The SimConnect side (real SimConnectSource against the protocol emulator) is in
// simconnect-emulator.test.ts ("SimStart / SimStop and the effective pause").

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FlightState } from "../src/protocol";
import { SimClock } from "../src/core/flight-sample";
import { PauseState, STUCK_PAUSE_MOVING_MS, STUCK_PAUSE_MIN_GS_KT } from "../src/sim/pause-state";
import { SimScript } from "./sim-script";

const flight = (s: SimScript) => s.session.store.getDomain("flight") as FlightState;

/** One fast frame moving east at `gsKt` for `dtMs`. */
function mover(start = { lat: 35, lon: -90 }) {
  const pos = { ...start };
  return (gsKt: number, dtMs: number) => {
    pos.lon += (gsKt * dtMs) / 3_600_000 / 60 / Math.cos((pos.lat * Math.PI) / 180);
    return { lat: pos.lat, lon: pos.lon, gsKt };
  };
}

describe("PauseState: effective pause", () => {
  it("is the pause flag OR the sim not running; an unknown run state counts as running", () => {
    const p = new PauseState();
    assert.equal(p.paused, false);
    assert.equal(p.simRunning, undefined);
    assert.equal(p.setFlag(true), true, "changed");
    assert.equal(p.paused, true);
    assert.equal(p.setFlag(false), true);
    assert.equal(p.paused, false);

    assert.equal(p.simStop(), true, "SimStop pauses");
    assert.equal(p.paused, true);
    assert.equal(p.setFlag(true), false, "already paused by the stop: no change");
    assert.equal(p.simStart(), false, "still paused by the flag");
    assert.equal(p.paused, true);
    assert.equal(p.setFlag(false), true);
    assert.equal(p.paused, false);

    assert.equal(p.systemState(false), true, '"Sim" = 0 pauses');
    assert.equal(p.paused, true);
    assert.equal(p.systemState(true), true, '"Sim" = 1 resumes');
    assert.equal(p.paused, false);
    assert.equal(p.systemState(true), false, "no change");
  });

  it("reset forgets the flag and the run state (new connection)", () => {
    const p = new PauseState();
    p.setFlag(true);
    p.simStop();
    p.reset();
    assert.equal(p.paused, false);
    assert.equal(p.simRunning, undefined);
  });
});

describe("PauseState: stuck pause rule", () => {
  const RULE = STUCK_PAUSE_MOVING_MS;

  it("a pause flag that outlives a SimStart is overridden after sustained real movement", () => {
    const p = new PauseState();
    const move = mover();
    let t = 0;
    p.setFlag(true);
    p.simStop();
    p.simStart();
    assert.equal(p.paused, true, "still paused right after SimStart");
    assert.equal(p.frame(move(150, 0), t), false, "first frame only sets the reference");
    let overriddenAt: number | null = null;
    while (t < RULE + 1000) {
      t += 200;
      if (p.frame(move(150, 200), t)) {
        overriddenAt = t;
        break;
      }
    }
    assert.equal(overriddenAt, RULE, `overridden after ${RULE} ms of movement`);
    assert.equal(p.paused, false);
    assert.equal(p.overridden, true);
    assert.equal(p.flag, true, "the reported flag itself is kept");
  });

  it("never without a SimStart after the pause was reported", () => {
    const p = new PauseState();
    const move = mover();
    p.simStart(); // before the pause: does not count
    p.setFlag(true);
    for (let t = 0; t <= RULE * 3; t += 200) assert.equal(p.frame(move(150, 200), t), false);
    assert.equal(p.paused, true);
  });

  it("never while the aircraft is frozen (same position, or a stale ground speed)", () => {
    const p = new PauseState();
    p.setFlag(true);
    p.simStart();
    for (let t = 0; t <= RULE * 3; t += 200) {
      // Paused sims freeze the position; a frozen GROUND VELOCITY may still read 150.
      assert.equal(p.frame({ lat: 35, lon: -90, gsKt: 150 }, t), false);
    }
    assert.equal(p.paused, true);
  });

  it("needs ground speed too, and the movement to be continuous", () => {
    const p = new PauseState();
    const move = mover();
    p.setFlag(true);
    p.simStart();
    let t = 0;
    p.frame(move(150, 0), t);
    // Creeping below the ground-speed floor does not count.
    for (; t < RULE * 2;) {
      t += 200;
      assert.equal(p.frame(move(STUCK_PAUSE_MIN_GS_KT - 1, 200), t), false);
    }
    // Moving, then one frozen frame restarts the count.
    for (let i = 0; i < (RULE / 200) * 0.9; i++) {
      t += 200;
      assert.equal(p.frame(move(150, 200), t), false);
    }
    t += 200;
    const frozen = move(0, 0);
    assert.equal(p.frame({ ...frozen, gsKt: 150 }, t), false);
    for (let i = 0; i < (RULE / 200) * 0.9; i++) {
      t += 200;
      assert.equal(p.frame(move(150, 200), t), false);
    }
    assert.equal(p.paused, true, "never 10 s of continuous movement");
  });

  it("is not applied while the sim is stopped, and a fresh pause report re-arms it", () => {
    const p = new PauseState();
    const move = mover();
    p.setFlag(true);
    p.simStart();
    p.simStop();
    let t = 0;
    for (; t <= RULE * 2; t += 200) assert.equal(p.frame(move(150, 200), t), false);
    assert.equal(p.paused, true, "stopped");
    p.simStart();
    for (; !p.frame(move(150, 200), t); t += 200) assert.ok(t < RULE * 5);
    assert.equal(p.paused, false, "overridden after the second SimStart");
    // The sim reports the pause again (any pause event): honoured until the next SimStart.
    assert.equal(p.setFlag(true), true);
    assert.equal(p.paused, true);
    assert.equal(p.overridden, false);
    for (let i = 0; i < 100; i++) {
      t += 200;
      assert.equal(p.frame(move(150, 200), t), false);
    }
    assert.equal(p.paused, true);
    // A real unpause clears it the normal way.
    assert.equal(p.setFlag(false), true);
    assert.equal(p.paused, false);
  });
});

describe("SimClock: an interval that ends a pause is not counted", () => {
  it("does not count the gap before the first unpaused update", () => {
    const clock = new SimClock();
    clock.advance(0, { paused: false, simRate: 1 });
    assert.equal(clock.advance(1000, { paused: false, simRate: 1 }), 1000);
    assert.equal(clock.advance(1200, { paused: true, simRate: 1 }), 1000);
    // Ten minutes in the main menu, no frames at all, then the resume update.
    assert.equal(clock.advance(601_200, { paused: false, simRate: 1 }), 1000);
    assert.equal(clock.advance(602_200, { paused: false, simRate: 1 }), 2000);
  });
});

describe("SimStop / SimStart in the flight core", () => {
  it("SimStop freezes the running flight's clock; SimStart resumes it; same flight, no disconnect", () => {
    const s = new SimScript();
    s.departure(3000);
    s.cruise(60);
    const before = flight(s);
    assert.ok(before.active && before.id);
    const framesBefore = s.frames.length;

    s.simStop();
    assert.equal(
      (s.session.store.getDomain("sim") as { paused: boolean } | null)?.paused,
      true,
      "the sim domain reads paused",
    );
    s.t += 10 * 60_000; // ten minutes in the main menu: no frames arrive
    s.simStart();
    s.cruise(30);

    const after = flight(s);
    assert.equal(after.id, before.id, "same flight");
    assert.equal(after.active, true);
    assert.equal(s.events("flight.ended").length, 0);
    assert.equal(s.events("sim.disconnected").length, 0, "a stop is not a disconnect");
    const elapsed = (after.elapsedSec ?? 0) - (before.elapsedSec ?? 0);
    assert.ok(elapsed >= 29 && elapsed <= 31, `elapsed across the stop ${elapsed} s (not 600+)`);
    const block = (after.blockMin ?? 0) - (before.blockMin ?? 0);
    assert.ok(block < 0.6, `block time across the stop +${block} min`);
    assert.equal(after.flags?.paused, false);
    assert.equal(after.flags?.teleport, false);
    // Data honesty: everything published during and after the stop is still tagged "sim".
    for (const f of s.frames.slice(framesBefore)) assert.equal(f.source, "sim");
  });

  it("the economy's sim minutes do not count the main menu either", () => {
    const s = new SimScript();
    s.departure(3000);
    s.cruise(30);
    const t0 = s.session.flight.clock.nowMs;
    s.simStop();
    s.t += 30 * 60_000;
    s.simStart();
    s.cruise(10);
    const dt = s.session.flight.clock.nowMs - t0;
    assert.ok(dt >= 9_000 && dt <= 10_500, `sim clock +${dt} ms`);
  });
});
