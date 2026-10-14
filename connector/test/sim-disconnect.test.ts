// Simulator link loss (MSFS quit / crashed / pipe broken) while the connector keeps
// running. Nothing sim-derived may outlive the link: commands that need the aircraft's
// state are refused while offline, the phase/flight domains are cleared, and the offline
// time is never counted. An active flight is suspended, not ended, and resumes on the
// next real sample after the simulator is back.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FlightState, PhaseState } from "../src/protocol";
import type { FlightRecord } from "../src/core/flight-tracker";
import { SimScript } from "./sim-script";

const flight = (s: SimScript) =>
  (s.session.store.getDomain("flight") ?? null) as FlightState | null;
const phase = (s: SimScript) => (s.session.store.getDomain("phase") ?? null) as PhaseState | null;
const code = (r: ReturnType<SimScript["command"]>) => (r.ok ? "ok" : r.error.code);

describe("simulator disconnect: commands", () => {
  it("flight.start is refused with sim_offline, not accepted on the last on-ground/brake sample", () => {
    const s = new SimScript();
    s.run(2); // parked, brake set: a start would be accepted now
    s.drop();
    const r = s.command("flight.start");
    assert.equal(code(r), "sim_offline");
    if (!r.ok) assert.match(r.error.message, /simulator is not connected/i);
    assert.equal(s.events("flight.started").length, 0);

    // Back, but no frame yet: still nothing to check against.
    s.reconnect();
    assert.equal(code(s.command("flight.start")), "no_data");
    s.run(1);
    assert.equal(code(s.command("flight.start")), "ok");
  });

  it("flight.end needs the sim to verify Arrived; an abort is still allowed while offline", () => {
    const s = new SimScript();
    s.departure(1500);
    s.cruise(40);
    s.drop();
    const phasesBefore = s.phases().length;
    assert.equal(code(s.command("flight.end")), "sim_offline");
    const r = s.command("flight.end", { abort: true });
    assert.equal(code(r), "ok");
    const [record] = s.events("flight.ended") as FlightRecord[];
    assert.equal(record?.status, "aborted");
    // The aborted summary is not published as live data while the sim is gone…
    assert.equal(flight(s), null);
    // …and comes back with the next real frames.
    s.reconnect();
    s.ac.onGround = true; // MSFS restarted at an airport
    s.ac.altFt = s.ac.groundElevFt;
    s.ac.gsKt = 0;
    s.ac.brake = true;
    s.run(1);
    assert.equal(flight(s)?.status, "aborted");
    // The old flight's phase is not carried over: the new session starts fresh.
    assert.equal(phase(s)?.current, "Boarding");
    assert.equal(s.phases().length, phasesBefore, "no Landing/TaxiIn invented after the drop");
  });
});

describe("simulator disconnect: phase and flight domains", () => {
  it("clears phase and flight with the other sim domains (no 'Cruise' after MSFS quits)", () => {
    const s = new SimScript();
    s.departure(1500);
    s.cruise(60);
    assert.equal(phase(s)?.current, "Cruise");
    assert.equal(flight(s)?.active, true);
    s.drop();
    assert.equal(phase(s), null);
    assert.equal(flight(s), null);
    const snap = s.session.store.snapshot().state;
    for (const domain of ["sim", "position", "motion", "controls", "phase", "flight"] as const) {
      assert.equal(snap[domain], null, `${domain} cleared`);
    }
    const last = s.frames.at(-1);
    assert.ok(last?.type === "delta");
    assert.equal(last.patch.phase, null);
    assert.equal(last.patch.flight, null);
  });

  it("an active flight survives a drop and reconnect; the offline time is not counted", () => {
    const s = new SimScript();
    s.departure(1500);
    s.cruise(60);
    const before = flight(s);
    assert.ok(before?.active && before.id);
    s.drop();
    s.t += 10 * 60_000; // ten minutes with MSFS closed
    s.reconnect();
    assert.equal(flight(s), null, "nothing published before the first real frame");
    s.cruise(10);
    const after = flight(s);
    assert.equal(after?.id, before.id, "same flight");
    assert.equal(after?.active, true);
    assert.equal(s.events("flight.started").length, 1);
    assert.equal(s.events("flight.ended").length, 0);
    const elapsed = (after?.elapsedSec ?? 0) - (before.elapsedSec ?? 0);
    assert.ok(elapsed >= 9 && elapsed <= 11, `elapsed across the drop ${elapsed} s (not 600+)`);
    assert.equal(after?.flags?.teleport, false);
    assert.equal(phase(s)?.current, "Cruise", "phase republished on the first frame");
    // Still a running flight: a second start is refused for that reason.
    assert.equal(code(s.command("flight.start")), "flight_active");
  });

  it("an aircraft that reappears somewhere else flags a teleport on the suspended flight", () => {
    const s = new SimScript();
    s.departure(1500);
    s.cruise(30);
    s.drop();
    s.ac.lon += 2; // reloaded ~100 nm away
    s.reconnect();
    s.cruise(5);
    assert.equal(flight(s)?.flags?.teleport, true);
  });

  it("without an active flight a drop forgets the phase and the half-taxied leg", () => {
    const s = new SimScript();
    s.run(5);
    s.ac.brake = false;
    s.run(10, 5, (a) => (a.gsKt = 12)); // TaxiOut
    assert.equal(phase(s)?.current, "TaxiOut");
    s.drop();
    assert.equal(phase(s), null);
    s.t += 60_000;
    s.ac.gsKt = 0;
    s.ac.brake = true;
    s.reconnect();
    s.run(1);
    assert.equal(phase(s)?.current, "Boarding", "fresh phase from the new session");
    assert.equal(code(s.command("flight.start")), "ok");
    const started = flight(s);
    assert.equal(started?.blockMin, 0, "no taxi time carried over from before the drop");
  });
});
