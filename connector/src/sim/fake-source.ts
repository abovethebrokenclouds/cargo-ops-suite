// FakeSource: replays a JSONL fixture (protocol FixtureFrame lines) with real
// timing. It is the cloud/test mode (`--sim fake`). The welcome announces
// `mode: "replay"` with `sim.connected: false`, and the core stamps
// `source: "replay"` on every frame, whatever the fixture recorded.
//
// Derived data is stripped: the `phase` and `flight` domains and the
// phase.changed / touchdown / flight.started / flight.ended events in a fixture
// (authored by the demo generator, or recorded from an earlier connector run)
// never reach the store. The connector's flight core recomputes them from the raw
// telemetry, so it is the only source of truth. Each update carries the frame's
// recorded `t` as its receive clock, so results do not depend on --speed.

import { readFileSync } from "node:fs";
import {
  parseFixture,
  type EventName,
  type FixtureFrame,
  type SimState,
  type SimStatePatch,
} from "../protocol";
import {
  SimEmitter,
  type LogFn,
  type SimLinkInfo,
  type SimListener,
  type SimSource,
} from "./source";

export interface FakeSourceOptions {
  /** Parsed fixture frames, or a JSONL file path. */
  frames?: FixtureFrame[];
  fixturePath?: string;
  /** Playback speed multiplier (2 = twice as fast). Default 1. */
  speed?: number;
  /** Restart from the first frame after the last one. Default false. */
  loop?: boolean;
  /** Pause before restarting a loop, ms of fixture time. Default 2000. */
  loopGapMs?: number;
  /** Do not schedule playback on start(); tests drive it with playAll(). */
  manual?: boolean;
  log?: LogFn;
}

/** Events the connector derives itself; dropped from fixtures. */
export const DERIVED_EVENTS: ReadonlySet<EventName> = new Set<EventName>([
  "phase.changed",
  "touchdown",
  "flight.started",
  "flight.ended",
]);
/** Domains the connector derives (flight core) or owns (economy); dropped from fixtures. */
export const DERIVED_DOMAINS = ["phase", "flight", "company", "jobs", "mission"] as const;

function stripDerived<T extends SimState | SimStatePatch>(value: T): T {
  const out = { ...value };
  for (const domain of DERIVED_DOMAINS) delete out[domain];
  return out;
}

export function loadFixture(path: string): FixtureFrame[] {
  const parsed = parseFixture(readFileSync(path, "utf8"));
  if (!parsed.ok) throw new Error(`Invalid fixture ${path}: ${parsed.error}`);
  if (parsed.frames.length === 0) throw new Error(`Fixture ${path} has no frames`);
  return parsed.frames;
}

export class FakeSource implements SimSource {
  readonly mode = "replay" as const;
  readonly frameSource = "replay" as const;

  private readonly emitter = new SimEmitter();
  private readonly frames: FixtureFrame[];
  private readonly speed: number;
  private readonly loop: boolean;
  private readonly loopGapMs: number;
  private readonly log: LogFn;
  private readonly manual: boolean;
  private timer: NodeJS.Timeout | null = null;
  private index = 0;
  private startedAt = 0;
  private running = false;
  /** Completed passes through the fixture. */
  loops = 0;

  constructor(options: FakeSourceOptions) {
    if (options.frames) this.frames = options.frames;
    else if (options.fixturePath) this.frames = loadFixture(options.fixturePath);
    else throw new Error("FakeSource needs frames or a fixturePath");
    if (this.frames.length === 0) throw new Error("FakeSource fixture has no frames");
    const speed = options.speed ?? 1;
    if (!(speed > 0) || !Number.isFinite(speed)) throw new Error("speed must be a positive number");
    this.speed = speed;
    this.loop = options.loop ?? false;
    this.loopGapMs = options.loopGapMs ?? 2000;
    this.log = options.log ?? (() => {});
    this.manual = options.manual ?? false;
  }

  link(): SimLinkInfo {
    // A replay is never a simulator connection.
    return { connected: false };
  }

  subscribe(listener: SimListener): () => void {
    return this.emitter.subscribe(listener);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    if (!this.manual) this.beginPass();
  }

  /** Emit every frame synchronously, in order (tests; deterministic). */
  playAll(): void {
    for (const frame of this.frames) this.play(frame);
    this.loops++;
  }

  /** Emit frames [from, to) synchronously (tests: stop mid-flight to send commands). */
  playRange(from: number, to: number = this.frames.length): void {
    for (const frame of this.frames.slice(from, to)) this.play(frame);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private beginPass(): void {
    this.index = 0;
    this.startedAt = Date.now();
    this.pump();
  }

  /** Emit every frame that is due, then sleep until the next one. */
  private pump(): void {
    this.timer = null;
    if (!this.running) return;
    const elapsed = (Date.now() - this.startedAt) * this.speed;
    while (this.index < this.frames.length) {
      const frame = this.frames[this.index];
      if (!frame || frame.t > elapsed) break;
      this.index++;
      this.play(frame);
      if (!this.running) return;
    }
    if (this.index < this.frames.length) {
      const next = this.frames[this.index];
      const wait = next ? Math.max(0, (next.t - elapsed) / this.speed) : 0;
      this.timer = setTimeout(() => this.pump(), wait);
      return;
    }
    this.loops++;
    if (!this.loop) {
      this.log("info", "Fixture replay finished");
      return;
    }
    this.timer = setTimeout(() => this.beginPass(), this.loopGapMs / this.speed);
  }

  private play(frame: FixtureFrame): void {
    const msg = frame.msg;
    switch (msg.type) {
      case "snapshot":
        this.emitter.emit({ type: "reset", state: stripDerived(msg.state), at: frame.t });
        break;
      case "delta": {
        const patch = stripDerived(msg.patch);
        if (Object.keys(patch).length > 0) {
          this.emitter.emit({ type: "data", patch, at: frame.t });
        }
        break;
      }
      case "event":
        if (DERIVED_EVENTS.has(msg.name)) break;
        this.emitter.emit({ type: "event", name: msg.name, data: msg.data });
        break;
      default:
        // welcome/result/ping/pong lines are session chatter, not state.
        break;
    }
  }
}
