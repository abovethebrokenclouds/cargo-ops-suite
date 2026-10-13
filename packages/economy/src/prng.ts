// Seeded, deterministic pseudo-random numbers for the job generator. mulberry32 is a
// tiny public-domain 32-bit generator (Tommy Ettinger); written here, no dependency.

/** mulberry32: returns a function yielding floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32-bit hash of a string (unsigned). */
export function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Combine parts into one unsigned 32-bit seed. */
export function seedFrom(...parts: Array<string | number>): number {
  return hashString(parts.map(String).join("|"));
}

export class Rng {
  private readonly next01: () => number;

  constructor(seed: number) {
    this.next01 = mulberry32(seed);
  }

  /** Float in [0, 1). */
  next(): number {
    return this.next01();
  }

  /** Float in [min, max). */
  range(min: number, max: number): number {
    return min + (max - min) * this.next01();
  }

  /** Integer in [min, max] (inclusive). */
  int(min: number, max: number): number {
    return Math.min(max, Math.floor(this.range(min, max + 1)));
  }

  /** Weighted choice; items with weight ≤ 0 are never picked. Null for an empty choice. */
  weighted<T>(items: readonly T[], weight: (item: T) => number): T | null {
    let total = 0;
    for (const item of items) total += Math.max(0, weight(item));
    if (total <= 0) return null;
    let r = this.next01() * total;
    let last: T | null = null;
    for (const item of items) {
      const w = Math.max(0, weight(item));
      if (w <= 0) continue;
      last = item;
      if (r < w) return item;
      r -= w;
    }
    // Floating-point tail.
    return last;
  }
}
