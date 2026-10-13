import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import { parseFixture } from "../src/protocol";
import { Recorder } from "../src/core/recorder";
import { StateStore } from "../src/core/store";
import { FakeSource, loadFixture } from "../src/sim/fake-source";
import { tempDir } from "./helpers";

describe("Recorder", () => {
  it("writes parseable JSONL starting with a snapshot, with non-decreasing t", () => {
    const tmp = tempDir();
    try {
      const store = new StateStore("sim");
      store.apply({ controls: { parkingBrake: true } });
      let clock = 1000;
      const path = join(tmp.dir, "nested", "flight.jsonl");
      const recorder = new Recorder(path, store, () => clock);
      clock += 200;
      store.apply({ controls: { parkingBrake: false } });
      clock += 300;
      store.event("sim.paused", { paused: true });
      recorder.close();
      store.apply({ controls: { parkingBrake: true } }); // after close: not written

      const parsed = parseFixture(readFileSync(path, "utf8"));
      assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
      if (!parsed.ok) return;
      assert.deepEqual(
        parsed.frames.map((f) => [f.t, f.msg.type]),
        [
          [0, "snapshot"],
          [200, "delta"],
          [500, "event"],
        ],
      );
      assert.equal(recorder.lines, 3);
      for (const f of parsed.frames) {
        if (f.msg.type === "snapshot" || f.msg.type === "delta" || f.msg.type === "event") {
          assert.equal(f.msg.source, "sim");
        }
      }
      // The recording replays through FakeSource.
      assert.equal(loadFixture(path).length, 3);
    } finally {
      tmp.cleanup();
    }
  });

  it("refuses to append to an existing recording", () => {
    const tmp = tempDir();
    try {
      const path = join(tmp.dir, "old.jsonl");
      writeFileSync(path, "{}\n");
      assert.throws(() => new Recorder(path, new StateStore("sim")), /already exists/);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("FakeSource", () => {
  it("replays the synced demo fixture as reset/data/event updates", async () => {
    const frames = loadFixture(
      join(__dirname, "..", "..", "..", "fixtures", "demo-kmem-katl.jsonl"),
    );
    assert.ok(frames.length > 100);
    const source = new FakeSource({ frames: frames.slice(0, 5), speed: 1000 });
    assert.equal(source.mode, "replay");
    assert.equal(source.frameSource, "replay");
    assert.deepEqual(source.link(), { connected: false });
    const types: string[] = [];
    source.subscribe((u) => types.push(u.type));
    source.start();
    await new Promise((r) => setTimeout(r, 100));
    await source.stop();
    assert.equal(types[0], "reset");
    // The fixture's authored flight.started event (frame 3) is stripped: derived data
    // comes from the connector's flight core only.
    assert.deepEqual(types, ["reset", "data", "data", "data"]);
    assert.equal(source.loops, 1);
  });

  it("honours the speed multiplier and loops", async () => {
    const frames = [
      {
        t: 0,
        msg: {
          type: "snapshot" as const,
          v: 1 as const,
          seq: 0,
          source: "demo" as const,
          state: {},
        },
      },
      {
        t: 1000,
        msg: {
          type: "event" as const,
          v: 1 as const,
          seq: 1,
          source: "demo" as const,
          name: "sim.paused" as const,
          data: { paused: true },
        },
      },
    ];
    const source = new FakeSource({ frames, speed: 20, loop: true, loopGapMs: 200 });
    const seen: number[] = [];
    const started = Date.now();
    source.subscribe((u) => {
      if (u.type === "event") seen.push(Date.now() - started);
    });
    source.start();
    await new Promise((r) => setTimeout(r, 250));
    await source.stop();
    // 1000 ms of fixture at 20x = 50 ms; loop gap 200/20 = 10 ms → several passes in 250 ms.
    assert.ok(seen.length >= 2, `expected looping, saw ${seen.length}`);
    assert.ok((seen[0] ?? 0) >= 40, `first event too early (${seen[0]} ms)`);
  });

  it("rejects bad options", () => {
    assert.throws(() => new FakeSource({}));
    assert.throws(() => new FakeSource({ frames: [] }));
  });
});
