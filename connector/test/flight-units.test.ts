import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PROTOCOL_VERSION, type FixtureFrame } from "../src/protocol";
import {
  GroundDebouncer,
  SimClock,
  greatCircleNm,
  type FlightSample,
} from "../src/core/flight-sample";
import { PhaseFsm } from "../src/core/phase-fsm";
import { TelemetryRecorder } from "../src/core/telemetry-recorder";
import type { TelemetryRow } from "../src/storage/flights";
import { FakeSource } from "../src/sim/fake-source";
import type { SimUpdate } from "../src/sim/source";

function sample(tMs: number, over: Partial<FlightSample> = {}): FlightSample {
  return {
    tMs,
    onGround: false,
    lat: 35,
    lon: -90,
    altFt: 8000,
    aglFt: 7700,
    iasKt: 150,
    gsKt: 150,
    vsFpm: 0,
    hdgTrueDeg: 90,
    gForce: 1,
    parkingBrake: false,
    enginesRunning: true,
    fuelLb: 1000,
    paused: false,
    simRate: 1,
    ...over,
  };
}

describe("SimClock", () => {
  it("advances by receive time × sim rate and stops while paused", () => {
    const clock = new SimClock();
    assert.equal(clock.advance(1000, { paused: false, simRate: 1 }), 0);
    assert.equal(clock.advance(2000, { paused: false, simRate: 1 }), 1000);
    assert.equal(clock.advance(3000, { paused: false, simRate: 4 }), 5000);
    assert.equal(clock.advance(60_000, { paused: true, simRate: 4 }), 5000);
    // The interval that ends a pause belongs to the pause (no frames may arrive while
    // paused, e.g. in the main menu after SimStop); counting resumes from the next update.
    assert.equal(clock.advance(61_000, { paused: false, simRate: 0.5 }), 5000);
    assert.equal(clock.advance(62_000, { paused: false, simRate: 0.5 }), 5500);
    assert.equal(clock.advance(60_000, { paused: false, simRate: 1 }), 5500, "never backwards");
  });

  it("prefers a stated sim time when the frames carry one", () => {
    const clock = new SimClock();
    clock.advance(0, { paused: false, simRate: 1, simTimeSec: 100 });
    assert.equal(clock.advance(1000, { paused: false, simRate: 1, simTimeSec: 130 }), 30_000);
    assert.equal(clock.advance(2000, { paused: true, simRate: 1, simTimeSec: 160 }), 30_000);
  });
});

describe("GroundDebouncer", () => {
  it("needs N consecutive samples to change state", () => {
    const d = new GroundDebouncer(3);
    assert.equal(d.update(true), true);
    assert.equal(d.update(false), true);
    assert.equal(d.update(false), true);
    assert.equal(d.update(true), true, "streak broken");
    assert.equal(d.update(false), true);
    assert.equal(d.update(false), true);
    assert.equal(d.update(false), false);
  });
});

describe("PhaseFsm", () => {
  it("allows step climbs and descents among airborne phases", () => {
    const fsm = new PhaseFsm();
    let t = 0;
    const fly = (seconds: number, vsFpm: number) => {
      const seen: string[] = [];
      for (let i = 0; i < seconds; i++) {
        const tr = fsm.update(sample((t += 1000), { vsFpm }));
        if (tr) seen.push(tr.to);
      }
      return seen;
    };
    fly(1, 0);
    assert.equal(fsm.phase, "Cruise", "initial airborne level phase");
    assert.deepEqual(fly(40, 800), ["Climb"]);
    assert.deepEqual(fly(40, 0), ["Cruise"]);
    assert.deepEqual(fly(40, -800), ["Descent"]);
    assert.deepEqual(fly(40, 0), ["Cruise"]);
    // A short climb (< 30 s) does not change the phase.
    assert.deepEqual(fly(20, 800), []);
  });

  it("never returns to a ground phase from the air", () => {
    const fsm = new PhaseFsm();
    fsm.update(sample(0));
    for (let i = 1; i < 100; i++) fsm.update(sample(i * 1000, { gsKt: 3 }));
    assert.equal(fsm.phase, "Cruise");
  });

  it("starts on the ground in Boarding and needs 3 s above 5 kt for TaxiOut", () => {
    const fsm = new PhaseFsm();
    fsm.update(sample(0, { onGround: true, gsKt: 0, parkingBrake: true }));
    assert.equal(fsm.phase, "Boarding");
    assert.equal(fsm.update(sample(1000, { onGround: true, gsKt: 8 })), null);
    assert.equal(fsm.update(sample(2000, { onGround: true, gsKt: 8 })), null);
    assert.deepEqual(fsm.update(sample(4000, { onGround: true, gsKt: 8 })), {
      from: "Boarding",
      to: "TaxiOut",
      tMs: 4000,
    });
  });
});

describe("TelemetryRecorder", () => {
  it("writes 1 Hz rows, holds them until the flight has an id, and keeps 5 Hz before touchdown", () => {
    const written: TelemetryRow[] = [];
    const rec = new TelemetryRecorder((_id, rows) => written.push(...rows));
    rec.begin(10_000);
    for (let t = 10_000; t <= 20_000; t += 200) rec.sample(sample(t), "TaxiOut");
    assert.equal(written.length, 0, "held until attach");
    rec.attach("f1");
    assert.equal(written.length, 11, "1 Hz over 10 s");
    for (let t = 20_200; t <= 100_000; t += 200) rec.sample(sample(t), "Approach");
    const base = written.length;
    rec.touchdown(100_000);
    const fine = written.slice(base);
    assert.equal(fine.length, 301, "5 Hz over the 60 s before touchdown");
    assert.equal(fine[0]?.tMs, 30_000);
    assert.equal(fine.at(-1)?.tMs, 90_000);
  });
});

describe("FakeSource strips derived data", () => {
  it("drops phase/flight domains and phase/touchdown/flight events, keeps the rest", () => {
    const base = { v: PROTOCOL_VERSION, source: "demo" as const };
    const frames: FixtureFrame[] = [
      {
        t: 0,
        msg: {
          ...base,
          type: "snapshot",
          seq: 0,
          state: {
            phase: { current: "Cruise" },
            flight: { active: true },
            aircraft: { title: "X" },
          },
        },
      },
      {
        t: 10,
        msg: { ...base, type: "delta", seq: 1, patch: { phase: { current: "Descent" } } },
      },
      { t: 20, msg: { ...base, type: "event", seq: 2, name: "touchdown", data: {} } },
      { t: 30, msg: { ...base, type: "event", seq: 3, name: "crash", data: {} } },
    ];
    const source = new FakeSource({ frames, manual: true });
    const updates: SimUpdate[] = [];
    source.subscribe((u) => updates.push(u));
    source.playAll();
    assert.deepEqual(updates, [
      { type: "reset", state: { aircraft: { title: "X" } }, at: 0 },
      { type: "event", name: "crash", data: {} },
    ]);
  });
});

describe("greatCircleNm", () => {
  it("measures KMEM–KATL", () => {
    const d = greatCircleNm({ lat: 35.0424, lon: -89.9767 }, { lat: 33.6367, lon: -84.4281 });
    assert.ok(Math.abs(d - 287.7) < 0.2, `${d}`);
  });
});
