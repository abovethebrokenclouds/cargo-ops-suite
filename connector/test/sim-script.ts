// Test helper: a tiny kinematic "simulator" that feeds hand-built frame sequences
// into a real ConnectorSession through a stub live source. Receive time advances
// by 1/hz per frame; with sim rate r the aircraft moves r times as far, like the
// real simulator. Nothing here is a recording; it exists to exercise the core.

import {
  PROTOCOL_VERSION,
  type Command,
  type Frame,
  type Result,
  type SimState,
} from "../src/protocol";
import { ConnectorSession, type SessionOptions } from "../src/core/session";
import { SimEmitter, type SimLinkInfo, type SimSource, type SimUpdate } from "../src/sim/source";

export class StubSource implements SimSource {
  readonly mode = "live" as const;
  readonly frameSource = "sim" as const;
  private readonly emitter = new SimEmitter();
  connected = true;
  link(): SimLinkInfo {
    return this.connected ? { connected: true, name: "Test" } : { connected: false };
  }
  subscribe(listener: (u: SimUpdate) => void) {
    return this.emitter.subscribe(listener);
  }
  start() {}
  async stop() {}
  emit(update: SimUpdate) {
    if (update.type === "connected") this.connected = true;
    if (update.type === "disconnected") this.connected = false;
    this.emitter.emit(update);
  }
}

export interface Aircraft {
  lat: number;
  lon: number;
  altFt: number;
  groundElevFt: number;
  gsKt: number;
  vsFpm: number;
  gForce: number;
  onGround: boolean;
  brake: boolean;
  engines: boolean;
  paused: boolean;
  simRate: number;
  fuelLb: number;
  /** PLANE TOUCHDOWN NORMAL VELOCITY ×60 as the sim would report it; undefined = not reported. */
  touchdownVelocityFpm?: number;
}

export class SimScript {
  readonly source = new StubSource();
  readonly session: ConnectorSession;
  readonly frames: Frame[] = [];
  /** Receive clock, ms. */
  t = 0;
  ac: Aircraft = {
    lat: 35,
    lon: -90,
    altFt: 300,
    groundElevFt: 300,
    gsKt: 0,
    vsFpm: 0,
    gForce: 1,
    onGround: true,
    brake: true,
    engines: true,
    paused: false,
    simRate: 1,
    fuelLb: 1000,
  };
  private commandId = 0;

  constructor(options: SessionOptions = {}) {
    let n = 0;
    this.session = new ConnectorSession(this.source, () => {}, {
      now: () => Date.UTC(2026, 9, 13, 12, 0, 0),
      newId: () => `f${++n}`,
      ...options,
    });
    this.session.store.subscribe((f) => this.frames.push(f));
    this.session.start();
    this.source.emit({ type: "reset", state: this.state(), at: this.t });
  }

  get aglFt(): number {
    return this.ac.onGround ? 0 : Math.max(0, this.ac.altFt - this.ac.groundElevFt);
  }

  state(): SimState {
    const a = this.ac;
    return {
      sim: { connected: true, paused: a.paused, simRate: a.simRate },
      position: { lat: a.lat, lon: a.lon, altFt: a.altFt, aglFt: this.aglFt },
      motion: {
        iasKt: a.gsKt,
        tasKt: a.gsKt,
        gsKt: a.gsKt,
        hdgMagDeg: 90,
        hdgTrueDeg: 90,
        vsFpm: a.onGround ? 0 : a.vsFpm,
        gForce: a.gForce,
        onGround: a.onGround,
        ...(a.touchdownVelocityFpm !== undefined
          ? {
              touchdownVelocityFpm: a.touchdownVelocityFpm,
              touchdownBankDeg: 1.5,
              touchdownPitchDeg: -4,
            }
          : {}),
      },
      controls: { parkingBrake: a.brake },
      engines: { running: [a.engines] },
      fuel: { totalGal: a.fuelLb / 6.7, totalLb: a.fuelLb, flowPph: [a.engines ? 300 : 0] },
    };
  }

  /** Emit one frame after advancing the receive clock by 1/hz s. */
  step(hz = 5, mutate?: (a: Aircraft) => void): void {
    const dtMs = 1000 / hz;
    this.t += dtMs;
    mutate?.(this.ac);
    const a = this.ac;
    if (!a.paused) {
      const simSec = (dtMs / 1000) * a.simRate;
      // Fly east: 1 nm = 1/60 degree of latitude; longitude scaled by cos(lat).
      a.lon += (a.gsKt * simSec) / 3600 / 60 / Math.cos((a.lat * Math.PI) / 180);
      if (!a.onGround) a.altFt += (a.vsFpm * simSec) / 60;
      if (a.engines) a.fuelLb = Math.max(0, a.fuelLb - (300 * simSec) / 3600);
    }
    const s = this.state();
    this.source.emit({
      type: "data",
      at: this.t,
      patch: {
        sim: s.sim ?? null,
        position: s.position ?? null,
        motion: s.motion ?? null,
        controls: s.controls ?? null,
        engines: s.engines ?? null,
        fuel: s.fuel ?? null,
      },
    });
  }

  /** Run `seconds` of receive time at `hz`. */
  run(seconds: number, hz = 5, mutate?: (a: Aircraft) => void): void {
    const n = Math.round(seconds * hz);
    for (let i = 0; i < n; i++) this.step(hz, mutate);
  }

  /** Fly until AGL reaches the ground, then put the wheels down. */
  descendToGround(hz = 10): void {
    for (let i = 0; i < 100_000 && !this.ac.onGround; i++) {
      this.step(hz, (a) => {
        if (a.altFt + (a.vsFpm / 60) * (1 / hz) * a.simRate <= a.groundElevFt) {
          a.altFt = a.groundElevFt;
          a.onGround = true;
        }
      });
    }
  }

  /** The simulator link drops (MSFS quit or crashed); no frames until reconnect(). */
  drop(reason = "simulator quit"): void {
    this.source.emit({ type: "event", name: "sim.disconnected", data: { reason } });
    this.source.emit({ type: "disconnected", reason });
  }

  /** The simulator is back: a new SimConnect session opens (frames follow with step/run). */
  reconnect(): void {
    this.source.emit({ type: "connected", simName: "Test", protocol: "SunRise" });
  }

  command(name: string, args: unknown = {}): Result {
    const cmd: Command = {
      type: "command",
      v: PROTOCOL_VERSION,
      id: `c${++this.commandId}`,
      name,
      args,
    };
    return this.session.command(cmd);
  }

  events(name: string): unknown[] {
    return this.frames.flatMap((f) => (f.type === "event" && f.name === name ? [f.data] : []));
  }

  phases(): string[] {
    return (this.events("phase.changed") as Array<{ to: string }>).map((d) => d.to);
  }

  // ---- canned segments ----

  /** Brake released, taxi, take-off roll, liftoff and climb to `climbFt` AGL. */
  departure(climbFt = 3000): void {
    this.run(5); // boarding
    this.ac.brake = false;
    this.run(20, 5, (a) => (a.gsKt = 12));
    this.run(15, 5, (a) => (a.gsKt = Math.min(70, a.gsKt + 4)));
    this.ac.onGround = false;
    this.ac.vsFpm = 800;
    this.ac.gsKt = 90;
    while (this.aglFt < climbFt) this.step(5);
  }

  /** Level flight for `seconds`. */
  cruise(seconds: number, hz = 5): void {
    this.ac.vsFpm = 0;
    this.ac.gsKt = 150;
    this.run(seconds, hz);
  }

  /** Descend at `vsFpm` to the ground at 10 Hz, then roll to a stop, taxi in and park. */
  landAndPark(vsFpm = -500): void {
    this.ac.vsFpm = vsFpm;
    this.ac.gsKt = 90;
    this.descendToGround(10);
    this.ac.gForce = 1.25;
    this.step(10);
    this.ac.gForce = 1;
    this.run(10, 10, (a) => (a.gsKt = Math.max(15, a.gsKt - 6)));
    this.run(20, 5, (a) => (a.gsKt = 12));
    this.run(3, 5, (a) => {
      a.gsKt = 0;
      a.brake = true;
      a.engines = false;
    });
  }
}
