// Client-side frame-rate measurement. The reducer only keeps the last seq and the
// time of the last frame, so a sample is recorded each time `lastSeq` advances; the
// seq step counts frames that arrived in the same render batch (e.g. a delta and
// its event).

export const FRAME_RATE_WINDOW_MS = 5000;

export interface FrameSample {
  /** Client clock when the frame was applied, ms. */
  at: number;
  /** Frames represented by this sample (seq step since the previous sample, ≥ 1). */
  frames: number;
}

/**
 * Add a sample for a new `lastSeq`, dropping samples outside the window. `prevSeq`
 * is the seq of the previous sample (-1 for none); a seq that went backwards (new
 * session or demo loop) counts as one frame.
 */
export function addFrameSample(
  samples: readonly FrameSample[],
  prevSeq: number,
  seq: number,
  at: number,
  windowMs = FRAME_RATE_WINDOW_MS,
): FrameSample[] {
  const step = prevSeq >= 0 && seq > prevSeq ? seq - prevSeq : 1;
  const kept = samples.filter((s) => at - s.at <= windowMs);
  kept.push({ at, frames: step });
  return kept;
}

/** Frames per second over the window ending at `now`, or null with no samples. */
export function framesPerSecond(
  samples: readonly FrameSample[],
  now: number,
  windowMs = FRAME_RATE_WINDOW_MS,
): number | null {
  if (samples.length === 0) return null;
  const frames = samples
    .filter((s) => now - s.at <= windowMs && s.at <= now)
    .reduce((sum, s) => sum + s.frames, 0);
  return frames / (windowMs / 1000);
}
