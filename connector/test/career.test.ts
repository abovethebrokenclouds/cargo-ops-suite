// /api routes for cargo operations: logbook, missions, jobs, CSV/GPX/JSON exports and
// the JSON career import (validated, refused mid-flight, round-trips).

import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { PROTOCOL_VERSION, type Command, type JobsState, type Mission } from "../src/protocol";
import { startConnector, type RunningConnector } from "../src/cli/app";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import {
  careerExportSchema,
  csvField,
  importCareer,
  type CareerExport,
} from "../src/storage/career";
import { openStorage } from "../src/storage/db";
import { EconomyRepo } from "../src/storage/economy";
import { tempDir } from "./helpers";

const FIXTURE = join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl");

async function start(dir: string): Promise<{ c: RunningConnector; source: FakeSource }> {
  const source = new FakeSource({ frames: loadFixture(FIXTURE), manual: true });
  const c = await startConnector({
    sim: "fake",
    dataDir: dir,
    port: 0,
    quiet: true,
    source,
    economySeed: 4242,
  });
  return { c, source };
}

function command(c: RunningConnector, name: string, args: unknown = {}) {
  const r = c.session.command({
    type: "command",
    v: PROTOCOL_VERSION,
    id: name,
    name,
    args,
  } as Command);
  if (!r.ok) assert.fail(`${name}: ${r.error.code}`);
  return r.data;
}

async function api(c: RunningConnector, path: string, init: RequestInit = {}) {
  return fetch(`${c.server.url}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${c.token}`, ...(init.headers ?? {}) },
  });
}

function flyMission(c: RunningConnector, source: FakeSource): Mission {
  command(c, "jobs.refresh", { airport: "KMEM", destination: "KATL" });
  const jobs = c.session.store.getDomain("jobs") as JobsState;
  const job = jobs.available.find((j) => j.destination === "KATL");
  assert.ok(job);
  command(c, "job.accept", { jobId: job.id });
  command(c, "mission.load", { jobIds: [job.id] });
  source.playAll();
  const m = c.session.store.getDomain("mission") as Mission;
  assert.equal(m.status, "delivered");
  return m;
}

describe("cargo /api routes and career export/import", () => {
  it("logbook, missions and jobs need the bearer token and return the delivered mission", async () => {
    const tmp = tempDir();
    const { c, source } = await start(join(tmp.dir, "a"));
    try {
      const m = flyMission(c, source);
      const anon = await fetch(`${c.server.url}/api/logbook`);
      assert.equal(anon.status, 401);
      const log = (await (await api(c, "/api/logbook")).json()) as {
        flights: Array<{
          id: string;
          mission: { payout: number } | null;
          landing: { grade: string };
        }>;
      };
      assert.equal(log.flights.length, 1);
      assert.equal(log.flights[0]?.mission?.payout, 7124);
      assert.equal(log.flights[0]?.landing.grade, "B");
      const missions = (await (await api(c, "/api/missions")).json()) as { missions: Mission[] };
      assert.equal(missions.missions[0]?.id, m.id);
      const jobs = (await (await api(c, "/api/jobs")).json()) as JobsState;
      assert.equal(jobs.boards[0]?.origin, "KMEM");
      assert.equal((await api(c, "/api/jobs", { method: "POST" })).status, 405);
    } finally {
      await c.stop();
      tmp.cleanup();
    }
  });

  it("exports CSV and GPX", async () => {
    const tmp = tempDir();
    const { c, source } = await start(join(tmp.dir, "a"));
    try {
      flyMission(c, source);
      const csv = await api(c, "/api/export/csv");
      assert.equal(csv.status, 200);
      assert.match(csv.headers.get("content-type") ?? "", /text\/csv/);
      assert.match(
        csv.headers.get("content-disposition") ?? "",
        /attachment; filename="cargo-ops-logbook-demo-/,
      );
      const lines = (await csv.text()).trim().split("\r\n");
      assert.equal(lines.length, 2);
      assert.ok(lines[0]?.startsWith("date,flight_id,status,source,origin,destination"));
      assert.match(lines[1] ?? "", /,completed,replay,KMEM,KATL,/);
      assert.match(lines[1] ?? "", /,delivered,7124$/);

      const flightId = (c.session.store.getDomain("mission") as Mission).flightId ?? "";
      const gpx = await api(c, `/api/export/gpx?flight=${flightId}`);
      assert.equal(gpx.status, 200);
      assert.match(gpx.headers.get("content-type") ?? "", /application\/gpx\+xml/);
      const text = await gpx.text();
      assert.ok(text.startsWith('<?xml version="1.0" encoding="UTF-8"?>'));
      assert.match(
        text,
        /<gpx version="1.1" creator="Cargo Ops" xmlns="http:\/\/www.topografix.com\/GPX\/1\/1">/,
      );
      const points = text.match(/<trkpt /g) ?? [];
      assert.ok(points.length > 100, `${points.length} points`);
      assert.match(
        text,
        /<trkpt lat="35\.04\d{4}" lon="-89\.9\d{5}"><ele>\d+\.\d<\/ele><time>\d{4}-/,
      );
      assert.equal((await api(c, "/api/export/gpx")).status, 400);
      assert.equal((await api(c, "/api/export/gpx?flight=nope")).status, 404);
      assert.equal(csvField('a,"b"'), '"a,""b"""');
    } finally {
      await c.stop();
      tmp.cleanup();
    }
  });

  it("JSON export → import into a fresh database → identical export", async () => {
    const tmp = tempDir();
    const a = await start(join(tmp.dir, "a"));
    const b = await start(join(tmp.dir, "b"));
    try {
      flyMission(a.c, a.source);
      const exported = (await (await api(a.c, "/api/export/json")).json()) as CareerExport;
      assert.equal(careerExportSchema.safeParse(exported).success, true);
      assert.equal(exported.missions.length, 1);
      // P4: payout, fuel and landing fee; the starter aircraft and its events travel too.
      assert.equal(exported.version, 3);
      assert.deepEqual(
        exported.ledger.map((e) => e.category),
        ["mission_payout", "fuel", "landing_fee"],
      );
      assert.equal(exported.fleet.length, 1);
      assert.equal(exported.fleet[0]?.location, "KATL");
      assert.ok(exported.aircraftEvents.length >= 2);
      assert.equal(exported.flights.length, 1);

      const res = await api(b.c, "/api/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(exported),
      });
      assert.equal(res.status, 200, await res.clone().text());
      const again = (await (await api(b.c, "/api/export/json")).json()) as CareerExport;
      const strip = (x: CareerExport) => ({ ...x, exportedAt: "" });
      assert.deepEqual(strip(again), strip(exported));
      // The importing connector now shows the imported company.
      const company = b.c.session.store.getDomain("company") as { cash: number };
      const source = a.c.session.store.getDomain("company") as { cash: number };
      assert.equal(company.cash, source.cash);
      assert.ok(company.cash < 250_000 + 7124 && company.cash > 250_000 + 6000);
      const fleet = b.c.session.store.getDomain("fleet") as {
        aircraft: Array<{ location: string }>;
      };
      assert.equal(fleet.aircraft[0]?.location, "KATL");

      const bad = await api(b.c, "/api/import", {
        method: "POST",
        body: JSON.stringify({ format: "x" }),
      });
      assert.equal(bad.status, 400);
      assert.equal(((await bad.json()) as { error: string }).error, "invalid_export");
      const junk = await api(b.c, "/api/import", { method: "POST", body: "{not json" });
      assert.equal(junk.status, 400);
    } finally {
      await a.c.stop();
      await b.c.stop();
      tmp.cleanup();
    }
  });

  it("refuses an import while a flight is active, and replay flights into the live database", async () => {
    const tmp = tempDir();
    const { c, source } = await start(join(tmp.dir, "a"));
    try {
      const exported = (await (await api(c, "/api/export/json")).json()) as CareerExport;
      source.playRange(0, 120); // airborne
      assert.equal(c.session.flight.tracker.active, true);
      const res = await api(c, "/api/import", { method: "POST", body: JSON.stringify(exported) });
      assert.equal(res.status, 409);
      assert.equal(((await res.json()) as { error: string }).error, "flight_active");

      source.playRange(120);
      const withFlight = (await (await api(c, "/api/export/json")).json()) as CareerExport;
      const live = openStorage(join(tmp.dir, "live"), "live");
      const result = importCareer(new EconomyRepo(live), "live", withFlight);
      assert.equal(result.ok, false);
      if (!result.ok) assert.equal(result.code, "demo_data_in_live");
      live.close();
    } finally {
      await c.stop();
      tmp.cleanup();
    }
  });
});
