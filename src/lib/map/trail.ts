import type { LonLat } from "./geo";

/** Default trail length: about 33 minutes at 1 Hz, or 6–7 minutes at 5 Hz. */
export const TRAIL_CAPACITY = 2000;

/**
 * Fixed-capacity ring buffer of [lon, lat] positions. When full, the oldest point is
 * overwritten. Consecutive duplicates are skipped so a parked aircraft does not fill it.
 */
export class TrailBuffer {
  private readonly lons: Float64Array;
  private readonly lats: Float64Array;
  private start = 0;
  private count = 0;

  constructor(readonly capacity: number = TRAIL_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError("trail capacity must be a positive integer");
    }
    this.lons = new Float64Array(capacity);
    this.lats = new Float64Array(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Append a position. Returns false when it was skipped (invalid or same as the last). */
  push(lon: number, lat: number): boolean {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) return false;
    if (this.count > 0) {
      const last = (this.start + this.count - 1) % this.capacity;
      if (this.lons[last] === lon && this.lats[last] === lat) return false;
    }
    const index = (this.start + this.count) % this.capacity;
    this.lons[index] = lon;
    this.lats[index] = lat;
    if (this.count < this.capacity) this.count++;
    else this.start = (this.start + 1) % this.capacity;
    return true;
  }

  clear(): void {
    this.start = 0;
    this.count = 0;
  }

  /** Points oldest first. */
  toArray(): LonLat[] {
    const out: LonLat[] = new Array<LonLat>(this.count);
    for (let i = 0; i < this.count; i++) {
      const index = (this.start + i) % this.capacity;
      out[i] = [this.lons[index] ?? 0, this.lats[index] ?? 0];
    }
    return out;
  }
}
