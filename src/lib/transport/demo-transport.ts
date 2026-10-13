import {
  PROTOCOL_VERSION,
  isFrame,
  type ClientMessage,
  type FixtureFrame,
  type Frame,
  type Welcome,
} from "@cargo-ops/protocol";
import {
  Emitter,
  defaultTimers,
  type Timers,
  type Transport,
  type TransportListener,
} from "./types";

export interface DemoTransportOptions {
  /** Fixture frames, or a loader called on first connect. */
  frames: FixtureFrame[] | (() => FixtureFrame[]);
  timers?: Timers;
  /** Restart from the first frame when the fixture ends. Default true. */
  loop?: boolean;
  /** Pause between loops, ms. Default 3000. */
  loopGapMs?: number;
}

/**
 * Replays a JSONL fixture in the browser. It always announces `mode: "demo"` with
 * `sim.connected: false` and forces `source: "demo"` on every frame, so demo data
 * can never be mistaken for a live simulator.
 */
export class DemoTransport implements Transport {
  private readonly emitter = new Emitter();
  private readonly timers: Timers;
  private readonly loop: boolean;
  private readonly loopGapMs: number;
  private frames: Frame[] | null = null;
  private times: number[] = [];
  private readonly handles = new Set<unknown>();
  private active = false;
  private index = 0;
  private nextSeq = 0;
  private sessions = 0;

  constructor(private readonly options: DemoTransportOptions) {
    this.timers = options.timers ?? defaultTimers;
    this.loop = options.loop ?? true;
    this.loopGapMs = options.loopGapMs ?? 3000;
  }

  subscribe(listener: TransportListener): () => void {
    return this.emitter.subscribe(listener);
  }

  connect(): void {
    if (this.active) return;
    this.active = true;
    this.emitter.emit({ type: "status", status: "connecting" });
    this.schedule(() => this.start(), 0);
  }

  disconnect(): void {
    if (!this.active) return;
    this.active = false;
    this.clear();
    this.emitter.emit({ type: "status", status: "disconnected" });
  }

  send(msg: ClientMessage): void {
    if (!this.active || msg.type !== "command") return;
    // Commands are not executed against demo data.
    this.schedule(() => {
      this.emitter.emit({
        type: "message",
        msg: {
          type: "result",
          v: PROTOCOL_VERSION,
          id: msg.id,
          ok: false,
          error: { code: "demo_mode", message: "Commands are unavailable in demo mode." },
        },
      });
    }, 0);
  }

  private load(): Frame[] {
    if (!this.frames) {
      const source = this.options.frames;
      const all = typeof source === "function" ? source() : source;
      const frames = all.filter((f) => isFrame(f.msg));
      this.frames = frames.map((f) => f.msg as Frame);
      this.times = frames.map((f) => f.t);
    }
    return this.frames;
  }

  private start(): void {
    let frames: Frame[];
    try {
      frames = this.load();
    } catch (err) {
      this.active = false;
      this.emitter.emit({
        type: "status",
        status: "error",
        error: err instanceof Error ? err.message : "demo fixture failed to load",
      });
      return;
    }
    this.emitter.emit({ type: "status", status: "open" });
    const welcome: Welcome = {
      type: "welcome",
      v: PROTOCOL_VERSION,
      session: `demo-${++this.sessions}`,
      mode: "demo",
      sim: { connected: false },
    };
    this.emitter.emit({ type: "message", msg: welcome });
    this.index = 0;
    this.nextSeq = 0;
    if (frames.length) this.step();
  }

  private step(): void {
    const frames = this.frames ?? [];
    const frame = frames[this.index];
    if (!this.active || !frame) return;
    // Frames sharing a timestamp (e.g. a delta and its event) go out together.
    const at = this.times[this.index] ?? 0;
    while (this.active && this.index < frames.length && (this.times[this.index] ?? 0) === at) {
      const next = frames[this.index];
      if (next) this.emitter.emit({ type: "message", msg: this.restamp(next) });
      this.index++;
    }
    if (!this.active) return;
    if (this.index < frames.length) {
      const wait = (this.times[this.index] ?? 0) - (this.times[this.index - 1] ?? 0);
      this.schedule(() => this.step(), Math.max(0, wait));
    } else if (this.loop) {
      this.index = 0;
      this.schedule(() => this.step(), this.loopGapMs);
    }
  }

  /** Monotonic seq across loops, source forced to demo, sim never reported as connected. */
  private restamp(frame: Frame): Frame {
    const seq = this.nextSeq++;
    if (frame.type === "snapshot") {
      const state = frame.state.sim
        ? { ...frame.state, sim: { ...frame.state.sim, connected: false } }
        : frame.state;
      return { ...frame, seq, source: "demo", state };
    }
    if (frame.type === "delta") {
      const patch = frame.patch.sim
        ? { ...frame.patch, sim: { ...frame.patch.sim, connected: false } }
        : frame.patch;
      return { ...frame, seq, source: "demo", patch };
    }
    return { ...frame, seq, source: "demo" };
  }

  private schedule(fn: () => void, ms: number): void {
    const handle = this.timers.setTimeout(() => {
      this.handles.delete(handle);
      fn();
    }, ms);
    this.handles.add(handle);
  }

  private clear(): void {
    for (const handle of this.handles) this.timers.clearTimeout(handle);
    this.handles.clear();
  }
}
