import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseServerMessage, type Frame } from "../src/protocol";
import { StateStore } from "../src/core/store";

const motion = {
  iasKt: 100,
  tasKt: 105,
  gsKt: 110,
  hdgMagDeg: 90,
  hdgTrueDeg: 91,
  vsFpm: 0,
  gForce: 1,
  onGround: false,
};

function collect(store: StateStore): Frame[] {
  const frames: Frame[] = [];
  store.subscribe((f) => frames.push(f));
  return frames;
}

describe("StateStore", () => {
  it("starts empty at seq 0 with the configured source", () => {
    const store = new StateStore("sim");
    assert.deepEqual(store.snapshot(), {
      type: "snapshot",
      v: 1,
      seq: 0,
      source: "sim",
      state: {},
    });
  });

  it("emits the full domain the first time, then only changed fields", () => {
    const store = new StateStore("sim");
    const frames = collect(store);
    store.apply({ motion });
    store.apply({ motion: { ...motion, gsKt: 120 } });
    store.apply({ motion: { ...motion, gsKt: 120 } }); // no change → no frame
    assert.equal(frames.length, 2);
    assert.deepEqual(frames[0], { type: "delta", v: 1, seq: 1, source: "sim", patch: { motion } });
    assert.deepEqual(frames[1], {
      type: "delta",
      v: 1,
      seq: 2,
      source: "sim",
      patch: { motion: { gsKt: 120 } },
    });
    for (const f of frames) assert.ok(parseServerMessage(f).ok);
  });

  it("only includes changed domains", () => {
    const store = new StateStore("replay");
    store.apply({ motion, controls: { parkingBrake: true } });
    const frames = collect(store);
    store.apply({ motion, controls: { parkingBrake: false } });
    assert.equal(frames.length, 1);
    const frame = frames[0];
    assert.ok(frame && frame.type === "delta");
    if (frame?.type === "delta")
      assert.deepEqual(frame.patch, { controls: { parkingBrake: false } });
  });

  it("drops a partial patch for a domain it has no data for", () => {
    const rejected: string[] = [];
    const store = new StateStore("sim", (domain) => rejected.push(domain));
    const frames = collect(store);
    assert.equal(store.apply({ motion: { gsKt: 3 } }), null);
    assert.equal(frames.length, 0);
    assert.deepEqual(rejected, ["motion"]);
    assert.equal(store.stats().rejectedPatches, 1);
  });

  it("clears a domain with null, once", () => {
    const store = new StateStore("sim");
    store.apply({ motion });
    const frames = collect(store);
    store.apply({ motion: null });
    store.apply({ motion: null });
    assert.equal(frames.length, 1);
    assert.equal(store.snapshot().state.motion, null);
  });

  it("shares one monotonic seq between deltas, events and reset snapshots", () => {
    const store = new StateStore("replay");
    const frames = collect(store);
    store.apply({ motion });
    store.event("sim.paused", { paused: true });
    store.reset({ controls: { parkingBrake: true } });
    store.apply({ controls: { parkingBrake: false } });
    assert.deepEqual(
      frames.map((f) => [f.type, f.seq]),
      [
        ["delta", 1],
        ["event", 2],
        ["snapshot", 3],
        ["delta", 4],
      ],
    );
    // A per-client snapshot does not advance seq.
    assert.equal(store.snapshot().seq, 4);
    assert.equal(store.currentSeq, 4);
  });

  it("reset replaces state and drops invalid domains", () => {
    const store = new StateStore("replay");
    store.apply({ motion });
    store.reset({ controls: { parkingBrake: true }, position: { lat: 999 } as never });
    assert.deepEqual(store.snapshot().state, { controls: { parkingBrake: true } });
  });

  it("snapshots are copies, not live references", () => {
    const store = new StateStore("sim");
    store.apply({ motion });
    const snap = store.snapshot();
    store.apply({ motion: { ...motion, gsKt: 1 } });
    assert.equal(snap.state.motion?.gsKt, 110);
  });
});
