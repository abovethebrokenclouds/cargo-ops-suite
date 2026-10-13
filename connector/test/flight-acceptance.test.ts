// P2 acceptance (plan §5): replaying the KMEM → KATL fixture through FakeSource and
// the real ConnectorSession yields the expected phases, exactly one touchdown with
// the grade the raw telemetry implies, and a distance within ±3 % of the route.
// Playback is synchronous (FakeSource.playAll) and the core is timed by the
// fixture's own clock, so the result is deterministic.

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  FLIGHT_PHASES,
  touchdownSchema,
  type FixtureFrame,
  type Frame,
  type FlightState,
  type Touchdown,
} from "../src/protocol";
import { ConnectorSession } from "../src/core/session";
import { greatCircleNm } from "../src/core/flight-sample";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import { openStorage } from "../src/storage/db";
import { FlightRepo } from "../src/storage/flights";
import type { FlightRecord } from "../src/core/flight-tracker";
import { tempDir } from "./helpers";

const FIXTURE = join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl");
const KMEM = { lat: 35.0424, lon: -89.9767 };
const KATL = { lat: 33.6367, lon: -84.4281 };

function replay(frames: FixtureFrame[], repo?: FlightRepo) {
  const source = new FakeSource({ frames, manual: true });
  let id = 0;
  const session = new ConnectorSession(source, () => {}, {
    ...(repo ? { repo } : {}),
    now: () => Date.UTC(2026, 9, 13, 12, 0, 0),
    newId: () => `flight-${++id}`,
  });
  const out: Frame[] = [];
  session.store.subscribe((f) => out.push(f));
  session.start();
  source.playAll();
  return { session, out };
}

const eventsNamed = (frames: Frame[], name: string) =>
  frames.flatMap((f) => (f.type === "event" && f.name === name ? [f] : []));

describe("acceptance: demo-kmem-katl.jsonl replay", () => {
  const frames = loadFixture(FIXTURE);

  it("recomputes the phase sequence from raw telemetry", () => {
    const { session, out } = replay(frames);
    const changes = eventsNamed(out, "phase.changed").map(
      (f) => f.data as { from: string; to: string },
    );
    assert.deepEqual(["Boarding", ...changes.map((c) => c.to)], [...FLIGHT_PHASES]);
    for (const [i, c] of changes.entries()) {
      assert.equal(c.from, i === 0 ? "Boarding" : changes[i - 1]?.to);
    }
    assert.equal(session.flight.fsm.phase, "Arrived");
    assert.deepEqual(session.store.getDomain("phase"), { current: "Arrived" });
  });

  it("ignores the fixture's authored derived events", () => {
    const authored = frames.filter(
      (f) => f.msg.type === "event" && ["phase.changed", "touchdown"].includes(f.msg.name),
    ).length;
    assert.ok(authored > 0, "the fixture does contain authored events");
    const { out } = replay(frames);
    // Exactly as many phase changes as the FSM produced (9) and one touchdown, all from the core.
    assert.equal(eventsNamed(out, "phase.changed").length, FLIGHT_PHASES.length - 1);
    assert.equal(eventsNamed(out, "touchdown").length, 1);
    assert.equal(eventsNamed(out, "flight.started").length, 1);
    assert.equal(eventsNamed(out, "flight.ended").length, 1);
  });

  it("finds exactly one touchdown with the rate and G the telemetry encodes", () => {
    const { out } = replay(frames);
    const [td] = eventsNamed(out, "touchdown");
    const parsed = touchdownSchema.safeParse(td?.data);
    assert.ok(parsed.success, "touchdown follows touchdownSchema");
    const t = parsed.data as Touchdown;
    // The fixture has no PLANE TOUCHDOWN NORMAL VELOCITY: the last airborne VS is used.
    assert.equal(t.rateSource, "verticalSpeed");
    assert.ok(Math.abs(t.rateFpm - -142) <= 5, `rate ${t.rateFpm}`);
    assert.ok(Math.abs(t.peakG - 1.18) <= 0.01, `peak G ${t.peakG}`);
    assert.equal(t.rateGrade, "B");
    assert.equal(t.gGrade, "A");
    assert.equal(t.grade, "B");
    assert.equal(t.bounces, 0);
    assert.equal(t.bankDeg, null);
    assert.equal(t.pitchDeg, null);
    assert.ok(Math.abs(t.gsKt - 72) <= 1, `GS ${t.gsKt}`);
    assert.ok(greatCircleNm(t, KATL) < 3, "touchdown within 3 nm of KATL");
  });

  it("integrates the distance within ±3 % of the great-circle route", () => {
    const { session, out } = replay(frames);
    const route = greatCircleNm(KMEM, KATL);
    const [ended] = eventsNamed(out, "flight.ended");
    const record = ended?.data as FlightRecord;
    assert.equal(record.status, "completed");
    const err = Math.abs(record.distanceNm - route) / route;
    assert.ok(err <= 0.03, `distance ${record.distanceNm} nm vs ${route.toFixed(1)} nm`);
    assert.deepEqual(record.flags, {
      teleport: false,
      noBonus: false,
      invalidated: false,
      crashed: false,
      paused: false,
    });
    // Times come from the fixture's sim clock (~126 min block), not the 6-minute replay.
    assert.ok(record.blockMin > 100 && record.blockMin < 130, `block ${record.blockMin}`);
    assert.ok(record.airborneMin > 80 && record.airborneMin < record.blockMin);
    assert.ok(record.maxAltFt >= 9500 && record.maxAltFt < 9600);
    assert.ok(record.fuelUsedLb > 0);
    assert.equal(record.origin, "KMEM");
    assert.equal(record.destination, "KATL");
    assert.equal(record.landings.length, 1);
    const domain = session.store.getDomain("flight") as FlightState;
    assert.equal(domain.active, false);
    assert.equal(domain.status, "completed");
    assert.equal(domain.distanceNm, record.distanceNm);
  });

  it("is deterministic", () => {
    const strip = (fs: Frame[]) =>
      JSON.stringify(fs.map((f) => (f.type === "event" ? [f.name, f.data] : f.seq)));
    assert.equal(strip(replay(frames).out), strip(replay(frames).out));
  });

  it("persists the flight and a downsampled track to the session database", () => {
    const tmp = tempDir();
    try {
      const storage = openStorage(tmp.dir, "demo");
      const repo = new FlightRepo(storage, "replay");
      replay(frames, repo);
      const list = repo.list();
      assert.equal(list.length, 1);
      const flight = list[0];
      assert.equal(flight?.status, "completed");
      assert.equal(flight?.source, "replay");
      assert.equal(flight?.landing?.grade, "B");
      const track = repo.track(flight?.id ?? "");
      assert.ok(track && track.points.length > 100, `track points ${track?.points.length}`);
      const ts = track.points.map((p) => p.t);
      assert.deepEqual(
        ts,
        [...ts].sort((a, b) => a - b),
      );
      storage.close();
    } finally {
      tmp.cleanup();
    }
  });
});
