// Flight core scenarios with hand-built frame sequences (see sim-script.ts):
// a normal flight, touch-and-go, bounce, pause, sim rate, teleport, crash, and
// the flight.start / flight.end commands.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { touchdownSchema, type FlightState, type Touchdown } from "../src/protocol";
import type { FlightRecord } from "../src/core/flight-tracker";
import { SimScript } from "./sim-script";

const flight = (s: SimScript) => s.session.store.getDomain("flight") as FlightState;
const touchdowns = (s: SimScript) =>
  s.events("touchdown").map((d) => {
    const parsed = touchdownSchema.safeParse(d);
    assert.ok(parsed.success, "touchdown event follows touchdownSchema");
    return parsed.data as Touchdown;
  });
const ended = (s: SimScript) => s.events("flight.ended") as FlightRecord[];

describe("flight core: complete flight", () => {
  it("walks Boarding → Arrived and records one touchdown", () => {
    const s = new SimScript();
    s.departure(3500);
    s.cruise(120);
    s.landAndPark(-500);
    assert.deepEqual(s.phases(), [
      "TaxiOut",
      "Takeoff",
      "Climb",
      "Cruise",
      "Descent",
      "Approach",
      "Landing",
      "TaxiIn",
      "Arrived",
    ]);
    const [td] = touchdowns(s);
    assert.equal(touchdowns(s).length, 1);
    assert.equal(td?.rateSource, "verticalSpeed");
    assert.equal(td?.rateFpm, -500);
    assert.equal(td?.peakG, 1.25);
    assert.equal(td?.grade, "E");
    const [record] = ended(s);
    assert.equal(record?.status, "completed");
    assert.equal(record?.flags.teleport, false);
    assert.equal(flight(s).active, false);
    assert.equal(s.events("flight.started").length, 1);
  });

  it("uses PLANE TOUCHDOWN NORMAL VELOCITY when the sim reports a fresh value", () => {
    const s = new SimScript();
    s.ac.touchdownVelocityFpm = -333; // stale value from an earlier landing
    s.departure(1500);
    s.cruise(40);
    s.ac.vsFpm = -400;
    s.ac.gsKt = 90;
    s.descendToGround(10);
    s.ac.touchdownVelocityFpm = 2.1 * 60; // the sim latches the new touchdown (ft/s × 60)
    s.run(4, 10, (a) => (a.gsKt = 60));
    const [td] = touchdowns(s);
    assert.equal(td?.rateSource, "touchdownVelocity");
    assert.equal(td?.rateFpm, -126);
    assert.equal(td?.bankDeg, 1.5);
    assert.equal(td?.pitchDeg, -4);
    assert.equal(td?.rateGrade, "B");
  });

  it("falls back to vertical speed when the touchdown SimVar did not change", () => {
    const s = new SimScript();
    s.ac.touchdownVelocityFpm = -333;
    s.departure(1500);
    s.cruise(40);
    s.ac.vsFpm = -150;
    s.ac.gsKt = 90;
    s.descendToGround(10);
    s.run(4, 10, (a) => (a.gsKt = 60));
    const [td] = touchdowns(s);
    assert.equal(td?.rateSource, "verticalSpeed");
    assert.equal(td?.rateFpm, -150);
    assert.equal(td?.bankDeg, null);
  });
});

describe("flight core: touch-and-go and bounce", () => {
  it("re-enters Climb after a touch-and-go and records both touchdowns", () => {
    const s = new SimScript();
    s.departure(2500);
    s.cruise(40);
    s.ac.vsFpm = -400;
    s.ac.gsKt = 80;
    s.descendToGround(10);
    s.run(6, 10, (a) => (a.gsKt = 65)); // roll on the runway
    s.ac.onGround = false;
    s.ac.vsFpm = 700;
    s.run(45, 5); // climb out
    s.cruise(40);
    s.landAndPark(-250);
    const phases = s.phases();
    const landing = phases.indexOf("Landing");
    assert.equal(phases[landing + 1], "Climb", `phases ${phases.join(",")}`);
    assert.equal(phases.at(-1), "Arrived");
    assert.equal(phases.filter((p) => p === "Landing").length, 2);
    assert.ok(!phases.includes("Boarding"), "never back to a ground phase before arrival");
    const tds = touchdowns(s);
    assert.equal(tds.length, 2);
    assert.equal(tds[0]?.rateFpm, -400);
    assert.equal(tds[1]?.rateFpm, -250);
    assert.equal(ended(s)[0]?.landings.length, 2);
    assert.equal(s.events("flight.started").length, 1, "one flight across the touch-and-go");
  });

  it("counts a bounce (AGL above 35 ft, back below 5 ft) without a second touchdown", () => {
    const s = new SimScript();
    s.departure(1500);
    s.cruise(40);
    s.ac.vsFpm = -300;
    s.ac.gsKt = 80;
    s.descendToGround(10);
    s.ac.gForce = 1.5;
    s.run(0.4, 10); // 4 samples on the wheels
    s.ac.gForce = 1;
    s.ac.onGround = false;
    s.ac.vsFpm = 900;
    while (s.aglFt < 45) s.step(10);
    s.ac.vsFpm = -400;
    s.descendToGround(10);
    s.run(5, 10, (a) => (a.gsKt = 60));
    const tds = touchdowns(s);
    assert.equal(tds.length, 1);
    assert.equal(tds[0]?.bounces, 1);
    assert.equal(tds[0]?.rateFpm, -300, "rate of the first contact");
    assert.equal(tds[0]?.peakG, 1.5);
    assert.equal(tds[0]?.gGrade, "C");
    assert.ok(
      !s.phases().includes("Climb") || s.phases().indexOf("Climb") < s.phases().indexOf("Landing"),
    );
  });

  it("ignores a one-sample on-ground glitch in flight", () => {
    const s = new SimScript();
    s.departure(2000);
    s.cruise(60);
    s.step(5, (a) => (a.onGround = true));
    s.step(5, (a) => (a.onGround = false));
    s.cruise(60);
    assert.ok(!s.phases().includes("Landing"));
    assert.equal(touchdowns(s).length, 0);
  });
});

describe("flight core: pause, sim rate, teleport, crash", () => {
  it("stops the mission clock while paused mid-cruise", () => {
    const a = new SimScript();
    a.departure(3000);
    a.cruise(60);
    const blockBefore = flight(a).blockMin ?? 0;
    a.ac.paused = true;
    a.run(120, 5); // two minutes of wall time, paused
    assert.equal(flight(a).flags?.paused, true);
    assert.equal(flight(a).blockMin, blockBefore, "no block time while paused");
    a.ac.paused = false;
    a.cruise(60);
    assert.equal(flight(a).flags?.paused, false);
    assert.equal(flight(a).flags?.teleport, false);
    assert.equal(a.session.flight.fsm.phase, "Cruise");
    assert.ok(Math.abs((flight(a).blockMin ?? 0) - blockBefore - 1) < 0.15);
  });

  it("8× sets noBonus but does not invalidate; time and distance scale with the rate", () => {
    const s = new SimScript();
    s.departure(3000);
    s.cruise(30);
    const before = flight(s);
    s.ac.simRate = 8;
    s.cruise(30); // 30 s of wall time = 4 min of sim time
    const after = flight(s);
    assert.equal(after.flags?.noBonus, true);
    assert.equal(after.flags?.invalidated, false);
    assert.equal(after.flags?.teleport, false, "8× movement is consistent with 8× time");
    const blockDelta = (after.blockMin ?? 0) - (before.blockMin ?? 0);
    assert.ok(Math.abs(blockDelta - 4) < 0.15, `block +${blockDelta} min`);
    const distDelta = (after.distanceNm ?? 0) - (before.distanceNm ?? 0);
    assert.ok(Math.abs(distDelta - 10) < 0.3, `distance +${distDelta} nm (150 kt × 4 min)`);
  });

  it("above 8× invalidates the flight", () => {
    const s = new SimScript();
    s.departure(2000);
    s.ac.simRate = 16;
    s.cruise(10);
    assert.equal(flight(s).flags?.invalidated, true);
    assert.equal(flight(s).flags?.noBonus, true);
  });

  it("flags a teleport and does not count the jump", () => {
    const s = new SimScript();
    s.departure(3000);
    s.cruise(60);
    const before = flight(s).distanceNm ?? 0;
    s.step(5, (a) => (a.lon += 1)); // ~49 nm in 0.2 s
    s.cruise(60);
    const after = flight(s);
    assert.equal(after.flags?.teleport, true);
    const flown = (after.distanceNm ?? 0) - before;
    assert.ok(flown < 3, `the jump is not counted (${flown} nm)`);
  });

  it("a crash fails the flight and keeps it for the logbook", () => {
    const s = new SimScript();
    s.departure(2000);
    s.cruise(30);
    s.source.emit({ type: "event", name: "crash", data: {} });
    const [record] = ended(s);
    assert.equal(record?.status, "failed");
    assert.equal(record?.flags.crashed, true);
    assert.equal(flight(s).active, false);
    assert.equal(flight(s).status, "failed");
  });
});

describe("flight core: commands", () => {
  it("flight.start needs the ground and the parking brake; flight.end needs Arrived or abort", () => {
    const s = new SimScript();
    s.ac.brake = false;
    s.run(1);
    let r = s.command("flight.start");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "brake_not_set");
    s.ac.brake = true;
    s.run(1);
    r = s.command("flight.start");
    assert.equal(r.ok, true);
    assert.equal(flight(s).active, true);
    assert.equal(s.events("flight.started").length, 1);
    r = s.command("flight.start");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "flight_active");
    r = s.command("flight.end");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "not_arrived");
    r = s.command("flight.end", { abort: true });
    assert.equal(r.ok, true);
    assert.equal(ended(s)[0]?.status, "aborted");
    r = s.command("flight.end");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "no_flight");
    r = s.command("job.accept");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "not_implemented");
  });

  it("an explicitly started flight does not start again at takeoff and completes on arrival", () => {
    const s = new SimScript();
    s.run(1);
    assert.equal(s.command("flight.start").ok, true);
    s.departure(2000);
    s.cruise(40);
    s.landAndPark(-200);
    assert.equal(s.events("flight.started").length, 1);
    assert.equal(ended(s)[0]?.status, "completed");
  });

  it("flight.start refuses in the air", () => {
    const s = new SimScript();
    s.departure(1500);
    const r = s.command("flight.start");
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.error.code, "flight_active");
  });
});
