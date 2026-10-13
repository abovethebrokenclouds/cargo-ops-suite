import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Frame } from "../src/protocol";
import { ConnectorSession } from "../src/core/session";
import { SimEmitter, type SimLinkInfo, type SimSource, type SimUpdate } from "../src/sim/source";

/** A live-mode source driven by the test, standing in for SimConnectSource. */
class StubLiveSource implements SimSource {
  readonly mode = "live" as const;
  readonly frameSource = "sim" as const;
  private readonly emitter = new SimEmitter();
  info: SimLinkInfo = { connected: false };
  link() {
    return { ...this.info };
  }
  subscribe(listener: (u: SimUpdate) => void) {
    return this.emitter.subscribe(listener);
  }
  start() {}
  async stop() {}
  emit(update: SimUpdate) {
    if (update.type === "connected") {
      this.info = {
        connected: true,
        name: update.simName,
        protocol: update.protocol,
        ...(update.version ? { version: update.version } : {}),
      };
    }
    if (update.type === "disconnected") this.info = { connected: false };
    this.emitter.emit(update);
  }
}

describe("ConnectorSession", () => {
  it("reports connected only after the source connected, then clears sim data on loss", () => {
    const source = new StubLiveSource();
    const session = new ConnectorSession(source, () => {});
    const frames: Frame[] = [];
    let linkChanges = 0;
    session.store.subscribe((f) => frames.push(f));
    session.onLinkChange(() => linkChanges++);
    session.start();

    assert.deepEqual(session.welcome().sim, { connected: false });
    assert.equal(session.welcome().mode, "live");

    source.emit({
      type: "connected",
      simName: "MSFS 2024",
      protocol: "SunRise",
      version: "12.1.0.0",
    });
    assert.deepEqual(session.welcome().sim, {
      connected: true,
      name: "MSFS 2024",
      protocol: "SunRise",
      version: "12.1.0.0",
    });
    assert.equal(linkChanges, 1);

    source.emit({ type: "data", patch: { controls: { parkingBrake: true } } });
    source.emit({ type: "event", name: "sim.paused", data: { paused: true } });
    source.emit({ type: "disconnected", reason: "simulator quit" });
    assert.equal(linkChanges, 2);
    assert.deepEqual(session.welcome().sim, { connected: false });
    assert.equal(session.store.snapshot().state.controls, null, "stale sim data is cleared");
    assert.deepEqual(
      frames.map((f) => [f.type, f.seq, f.source]),
      [
        ["delta", 1, "sim"],
        ["event", 2, "sim"],
        ["delta", 3, "sim"],
      ],
    );
  });
});
