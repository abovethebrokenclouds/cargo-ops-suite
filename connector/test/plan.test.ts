// The `plan` domain: GPS flight plan mapping (best effort), manual destination and mission
// destination, in that precedence, through a real ConnectorSession (plan §6.1, §14.1).

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { greatCircleNm } from "../src/economy";
import { loadAirportsData } from "../src/core/economy/airports-data";
import { MIN_ETE_GS_KT } from "../src/core/plan";
import type { Frame, JobsState, Mission, PlanState } from "../src/protocol";
import { ConnectorSession } from "../src/core/session";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import { mapPlan, mapSlow } from "../src/sim/mapping";
import { SimScript } from "./sim-script";

const AIRPORTS = loadAirportsData().airports;
const KATL = AIRPORTS.find((a) => a.ident === "KATL")!;
const KBNA = AIRPORTS.find((a) => a.ident === "KBNA")!;
const FIXTURE = join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl");

function plan(s: { session: ConnectorSession }): PlanState | null {
  return (s.session.store.getDomain("plan") ?? null) as PlanState | null;
}

function planFrames(frames: Frame[]): Frame[] {
  return frames.filter(
    (f) => f.type === "delta" && (f.patch as Record<string, unknown>)["plan"] !== undefined,
  );
}

/** A GPS plan as the SimConnect source reports it (mapPlan output). */
const GPS_ENROUTE: PlanState = {
  active: true,
  basis: "gps",
  wpCount: 4,
  wpIndex: 1,
  nextWpId: "VUZ",
  nextWpDistanceNm: 41.2,
  nextWpEteSec: 1100,
  eteSec: 5400,
};

describe("mapPlan (GPS SimVars → plan domain)", () => {
  const active = {
    gpsPlanActive: 1,
    gpsWpCount: 3,
    gpsWpIndex: 2,
    gpsNextWpId: "KATL\u0000\u0000",
    gpsNextWpLat: 33.6367,
    gpsNextWpLon: -84.4281,
    gpsWpDistanceNm: 12.345,
    gpsWpEteSec: 290.4,
    gpsEteSec: 290.4,
    gpsApproachAirportId: "",
  };

  it("last leg: the next waypoint is the destination and its distance is what remains", () => {
    assert.deepEqual(mapPlan(active), {
      active: true,
      basis: "gps",
      wpCount: 3,
      wpIndex: 2,
      nextWpId: "KATL",
      nextWpLat: 33.6367,
      nextWpLon: -84.4281,
      nextWpDistanceNm: 12.3,
      nextWpEteSec: 290,
      eteSec: 290,
      destination: "KATL",
      destDistanceNm: 12.3,
    });
  });

  it("en route: no destination ident unless an approach is loaded; never a guessed distance", () => {
    const enroute = mapPlan({ ...active, gpsWpIndex: 1, gpsNextWpId: "VUZ" });
    assert.equal(enroute?.destination, undefined);
    assert.equal(enroute?.destDistanceNm, undefined);
    assert.equal(enroute?.eteSec, 290);
    const approach = mapPlan({
      ...active,
      gpsWpIndex: 1,
      gpsNextWpId: "VUZ",
      gpsApproachAirportId: "KATL",
    });
    assert.equal(approach?.destination, "KATL");
    assert.equal(approach?.destDistanceNm, undefined);
  });

  it("inactive, no waypoints, an empty next waypoint (stale EFB plan) or no flag → no plan", () => {
    assert.equal(mapPlan({ ...active, gpsPlanActive: 0 }), null);
    assert.equal(mapPlan({ ...active, gpsWpCount: 0 }), null);
    assert.equal(mapPlan({ ...active, gpsNextWpId: "" }), null);
    assert.equal(mapPlan({ ...active, gpsNextWpId: "\u0000\u0000" }), null);
    const { gpsPlanActive: _, ...noFlag } = active;
    assert.equal(mapPlan(noFlag), null);
  });

  it("zero or missing optional values stay absent (rejected SimVars, no GPS ETE)", () => {
    const sparse = mapPlan({ gpsPlanActive: 1, gpsEteSec: 0, gpsNextWpLat: 0, gpsNextWpLon: 0 });
    assert.deepEqual(sparse, { active: true, basis: "gps" });
  });

  it("mapSlow always reports the plan: an object or null", () => {
    const counts = { engines: 0, stations: 0 };
    assert.equal(mapSlow({}, counts).plan, null);
    assert.equal(mapSlow(active, counts).plan?.destination, "KATL");
  });
});

describe("plan resolver through the session", () => {
  it("manual destination: connector distance/ETE from the live position, origin where parked", () => {
    const s = new SimScript({ airports: AIRPORTS });
    s.run(2);
    assert.equal(plan(s), null, "no plan without GPS, manual or mission");

    const r = s.command("plan.destination", { icao: "katl" });
    assert.ok(r.ok);
    assert.deepEqual(r.data, { destination: "KATL", basis: "manual" });
    const p = plan(s);
    assert.equal(p?.basis, "manual");
    assert.equal(p?.destination, "KATL");
    assert.equal(p?.origin, "KMEM", "parked within 3 nm of KMEM");
    const expected = Math.round(greatCircleNm({ lat: 35, lon: -90 }, KATL) * 10) / 10;
    assert.equal(p?.destDistanceNm, expected);
    assert.equal(p?.eteSec, undefined, `no ETE below ${MIN_ETE_GS_KT} kt`);
    assert.equal(p?.nextWpId, undefined, "never GPS fields");
    const deltas = planFrames(s.frames);
    assert.ok(deltas.length > 0);
    assert.ok(deltas.every((f) => f.source === "sim"));

    s.departure();
    s.cruise(30);
    const flying = plan(s)!;
    assert.ok(flying.destDistanceNm! < expected, "remaining distance shrinks");
    const ete = (flying.destDistanceNm! / 150) * 3600;
    assert.ok(Math.abs(flying.eteSec! - ete) < 30, `ETE ${flying.eteSec} ≈ ${ete}`);
    const started = s.events("flight.started")[0] as { destination?: string; origin?: string };
    assert.equal(started.destination, "KATL");
    assert.equal(started.origin, "KMEM");
    const flight = s.session.store.getDomain("flight") as { plannedDistanceNm?: number };
    assert.ok(flight.plannedDistanceNm! > expected - 1);
  });

  it("refuses unknown airports and malformed arguments; null clears the choice", () => {
    const s = new SimScript({ airports: AIRPORTS });
    s.run(1);
    const unknown = s.command("plan.destination", { icao: "ZZZZ" });
    assert.equal(!unknown.ok && unknown.error.code, "unknown_airport");
    const bad = s.command("plan.destination", { icao: "<b>" });
    assert.equal(!bad.ok && bad.error.code, "invalid_args");
    const extra = s.command("plan.destination", { icao: "KATL", eteSec: 1 });
    assert.equal(!extra.ok && extra.error.code, "invalid_args");
    assert.equal(plan(s), null);
    assert.ok(s.command("plan.destination", { icao: "KATL" }).ok);
    assert.equal(plan(s)?.destination, "KATL");
    assert.ok(s.command("plan.destination", { icao: null }).ok);
    assert.equal(plan(s), null);
    // Without airport data there is nothing to compute from.
    const none = new SimScript();
    const r = none.command("plan.destination", { icao: "KATL" });
    assert.equal(!r.ok && r.error.code, "no_airport_data");
  });

  it("GPS plan wins over the manual choice; GPS inactive falls back to it with no GPS leftovers", () => {
    const s = new SimScript({ airports: AIRPORTS });
    s.run(1);
    assert.ok(s.command("plan.destination", { icao: "KATL" }).ok);
    s.source.emit({ type: "data", at: s.t + 1, patch: { plan: GPS_ENROUTE } });
    assert.deepEqual(plan(s), GPS_ENROUTE, "manual destination/distance do not leak into GPS");
    const r = s.command("plan.destination", { icao: "KBNA" });
    assert.ok(r.ok);
    assert.deepEqual(r.data, { destination: "KBNA", basis: "gps" }, "the reply says GPS is in use");
    assert.equal(plan(s)?.basis, "gps");

    // The GPS plan goes inactive (the source reports null): the manual choice is back.
    s.source.emit({ type: "data", at: s.t + 2, patch: { plan: null } });
    const back = plan(s)!;
    assert.equal(back.basis, "manual");
    assert.equal(back.destination, "KBNA");
    assert.equal(back.nextWpId, undefined);
    assert.equal(back.wpCount, undefined);
    assert.equal(back.eteSec, undefined, "GPS ETE gone; on the ground no computed ETE");
    assert.equal(
      back.destDistanceNm,
      Math.round(greatCircleNm({ lat: 35, lon: -90 }, KBNA) * 10) / 10,
    );
  });

  it("a recorded manual/mission plan in the source is not taken for a GPS plan", () => {
    const s = new SimScript({ airports: AIRPORTS });
    s.run(1);
    s.source.emit({
      type: "data",
      at: s.t + 1,
      patch: { plan: { active: true, basis: "manual", destination: "KATL", destDistanceNm: 300 } },
    });
    assert.equal(plan(s), null);
  });

  it("the manual choice lasts for the current flight: kept over a disconnect, cleared at the end", () => {
    const s = new SimScript({ airports: AIRPORTS });
    s.run(1);
    assert.ok(s.command("plan.destination", { icao: "KATL" }).ok);
    s.departure();
    s.cruise(10);
    assert.equal(plan(s)?.basis, "manual");

    s.drop();
    assert.equal(plan(s), null, "cleared with the other sim-derived domains");
    // Accepted while offline, published only with real data again.
    assert.ok(s.command("plan.destination", { icao: "KATL" }).ok);
    assert.equal(plan(s), null);
    s.reconnect();
    s.cruise(2);
    assert.equal(plan(s)?.destination, "KATL");

    s.cruise(10);
    s.landAndPark();
    assert.equal(s.events("flight.ended").length, 1);
    s.run(2);
    assert.equal(plan(s), null, "no destination carried into the next flight");
    assert.equal(s.session.plan.manualDestination, null);
  });

  it("mission destination by default; manual overrides it; clearing returns to the mission", () => {
    const s = new SimScript({ airports: AIRPORTS, economy: { airports: AIRPORTS, seed: 4242 } });
    s.run(2);
    const refresh = s.command("jobs.refresh", { airport: "KMEM", destination: "KATL" });
    assert.ok(refresh.ok, JSON.stringify(refresh));
    const jobs = s.session.store.getDomain("jobs") as JobsState;
    const job = jobs.available.find((j) => j.destination === "KATL");
    assert.ok(job, "a KATL job");
    assert.ok(s.command("job.accept", { jobId: job.id }).ok);
    const loaded = s.command("mission.load", { jobIds: [job.id] });
    assert.ok(loaded.ok, JSON.stringify(loaded));
    const m = s.session.store.getDomain("mission") as Mission;

    const fromMission = plan(s)!;
    assert.equal(fromMission.basis, "mission");
    assert.equal(fromMission.origin, m.origin);
    assert.equal(fromMission.destination, "KATL");
    assert.ok(fromMission.destDistanceNm! > 0);

    assert.ok(s.command("plan.destination", { icao: "KBNA" }).ok);
    assert.equal(plan(s)?.basis, "manual");
    assert.equal(plan(s)?.destination, "KBNA");

    assert.ok(s.command("plan.destination", { icao: null }).ok);
    assert.equal(plan(s)?.basis, "mission");
    assert.equal(plan(s)?.destination, "KATL");

    // Unloading the mission removes it at once.
    assert.ok(s.command("mission.unload").ok);
    assert.equal(plan(s), null);
  });

  it("replay: the fixture's GPS plan wins over a loaded mission and is labelled gps", () => {
    const source = new FakeSource({ frames: loadFixture(FIXTURE), manual: true });
    const session = new ConnectorSession(source, () => {}, {
      economy: { airports: AIRPORTS, seed: 4242, replay: true },
    });
    const frames: Frame[] = [];
    session.store.subscribe((f) => frames.push(f));
    session.start();
    source.playRange(0, 40);
    const p = plan({ session })!;
    assert.equal(p.basis, "gps");
    assert.equal(p.destination, "KATL");
    assert.equal(p.origin, "KMEM");
    const refresh = session.command({
      type: "command",
      v: 1,
      id: "r",
      name: "jobs.refresh",
      args: { airport: "KMEM", destination: "KATL" },
    });
    assert.ok(refresh.ok);
    source.playRange(40);
    assert.equal(plan({ session })?.basis, "gps");
    const snapshots = frames.filter((f) => f.type === "snapshot");
    assert.ok(planFrames(frames).length > 0);
    assert.ok([...snapshots, ...planFrames(frames)].every((f) => f.source === "replay"));
    const started = frames.find((f) => f.type === "event" && f.name === "flight.started");
    assert.ok(started && started.type === "event");
    assert.equal((started.data as { destination?: string }).destination, "KATL");
  });
});
