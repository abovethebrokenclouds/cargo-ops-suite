// Effective pause for the live SimConnect link (plan §14.4: Pause / Pause_EX1 misreport in
// some builds, so they are combined with SimStart / SimStop and the "Sim" system state).
//
//   effective paused = (pause flag AND NOT overridden) OR sim not running
//
// - pause flag: the latest Pause or Pause_EX1 report (any non-zero Pause_EX1 = paused).
// - sim running: SimStart → true, SimStop → false, "Sim" system state 1 / 0. Unknown (before
//   the first answer) counts as running: no pause is invented without a report.
// - Stuck pause rule (conservative). A pause flag that never clears must not freeze the
//   flight's clock forever, but a real pause must never be overridden. The flag is
//   overridden only when ALL of these hold:
//     1. a SimStart arrived AFTER the latest pause report (a pause reported after the
//        SimStart is always honoured until the next SimStart);
//     2. the sim is running (no SimStop / "Sim" = 0 since);
//     3. consecutive fresh position frames have shown the aircraft really moving for at
//        least STUCK_PAUSE_MOVING_MS: every frame's position differs from the previous one
//        AND ground speed ≥ STUCK_PAUSE_MIN_GS_KT. A paused sim freezes the position (its
//        ground speed may still read the last value), so one frame with the same position or
//        a lower speed restarts the count.
//   A parked aircraft with a stuck flag therefore stays paused until it moves (nothing is
//   counted that the frames cannot prove). Any later Pause / Pause_EX1 report replaces the
//   flag and clears the override.
//
// Pure and deterministic: callers pass the receive time of each frame.

/** Continuous movement needed before a stuck pause flag is overridden, ms. */
export const STUCK_PAUSE_MOVING_MS = 10_000;
/** Ground speed below which a frame is not evidence of a running sim, kt. */
export const STUCK_PAUSE_MIN_GS_KT = 5;

export interface PauseFrame {
  lat: number;
  lon: number;
  gsKt: number;
}

export interface PauseStateOptions {
  /** Override STUCK_PAUSE_MOVING_MS (tests). */
  stuckPauseMs?: number;
}

export class PauseState {
  private readonly stuckPauseMs: number;
  private reported = false;
  private running: boolean | undefined;
  private isOverridden = false;
  /** Sequence numbers order pause reports and SimStarts without trusting clock ties. */
  private seq = 0;
  private pauseSeq = 0;
  private startSeq = 0;
  private prev: { lat: number; lon: number; atMs: number } | null = null;
  private movingSinceMs: number | null = null;

  constructor(options: PauseStateOptions = {}) {
    this.stuckPauseMs = options.stuckPauseMs ?? STUCK_PAUSE_MOVING_MS;
  }

  /** The effective pause the rest of the connector sees. */
  get paused(): boolean {
    return (this.reported && !this.isOverridden) || this.running === false;
  }

  /** The latest Pause / Pause_EX1 report, as the simulator sent it. */
  get flag(): boolean {
    return this.reported;
  }

  /** True while a stuck pause flag is being ignored (see the header). */
  get overridden(): boolean {
    return this.isOverridden;
  }

  get simRunning(): boolean | undefined {
    return this.running;
  }

  /** A Pause or Pause_EX1 report. Returns whether the effective pause changed. */
  setFlag(paused: boolean): boolean {
    return this.change(() => {
      this.reported = paused;
      this.isOverridden = false;
      if (paused) this.pauseSeq = ++this.seq;
      this.resetMovement();
    });
  }

  simStart(): boolean {
    return this.change(() => {
      this.running = true;
      this.startSeq = ++this.seq;
      this.resetMovement();
    });
  }

  simStop(): boolean {
    return this.change(() => {
      this.running = false;
      this.resetMovement();
    });
  }

  /** The "Sim" system state answer (1 = user in control of the aircraft). */
  systemState(running: boolean): boolean {
    return this.change(() => {
      if (this.running !== running) this.resetMovement();
      this.running = running;
    });
  }

  /**
   * A fresh position frame (receive time `atMs`). Returns true when it made the stuck-pause
   * override take effect (the effective pause went from true to false).
   */
  frame(f: PauseFrame, atMs: number): boolean {
    const armed =
      this.reported && !this.isOverridden && this.running === true && this.startSeq > this.pauseSeq;
    const prev = this.prev;
    this.prev = { lat: f.lat, lon: f.lon, atMs };
    if (!armed || !prev) {
      this.movingSinceMs = null;
      return false;
    }
    const moved =
      Number.isFinite(f.lat) &&
      Number.isFinite(f.lon) &&
      (f.lat !== prev.lat || f.lon !== prev.lon) &&
      Number.isFinite(f.gsKt) &&
      f.gsKt >= STUCK_PAUSE_MIN_GS_KT;
    if (!moved) {
      this.movingSinceMs = null;
      return false;
    }
    this.movingSinceMs ??= prev.atMs;
    if (atMs - this.movingSinceMs < this.stuckPauseMs) return false;
    return this.change(() => {
      this.isOverridden = true;
      this.movingSinceMs = null;
    });
  }

  /** A new connection: nothing is known yet. */
  reset(): void {
    this.reported = false;
    this.running = undefined;
    this.isOverridden = false;
    this.pauseSeq = 0;
    this.startSeq = 0;
    this.resetMovement();
  }

  private resetMovement(): void {
    this.prev = null;
    this.movingSinceMs = null;
  }

  private change(mutate: () => void): boolean {
    const before = this.paused;
    mutate();
    return this.paused !== before;
  }
}
