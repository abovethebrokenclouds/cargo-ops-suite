// Company clock (in-game time). It advances with real time while the connector runs
// and with simulator time during a flight:
//
//   per tick: game Δ = max(wall Δ capped at 60 s, simulator Δ since the last tick)
//
// so a flight at 4× sim rate moves the company clock 4× faster, a paused sim still lets
// real time run, and a sleeping PC or stopped connector adds at most 60 s. Loans and
// leases bill on 30-day in-game months; repairs complete in in-game hours. Tests inject
// the wall clock and feed simulator deltas directly.

import type { CompanyClock } from "../../protocol/src/company";
import { CLOCK_MAX_WALL_STEP_MS, GAME_DAY_MS, GAME_MONTH_MS } from "./company-constants";

export class GameClockTicker {
  private lastWall: number | null = null;
  private pendingSimMs = 0;

  /** Simulator time that passed (ms, pauses excluded). */
  addSim(ms: number): void {
    if (Number.isFinite(ms) && ms > 0) this.pendingSimMs += ms;
  }

  /** In-game ms to add at this wall-clock time. */
  tick(wallNow: number): number {
    const wall =
      this.lastWall === null
        ? 0
        : Math.max(0, Math.min(CLOCK_MAX_WALL_STEP_MS, wallNow - this.lastWall));
    this.lastWall = wallNow;
    const sim = this.pendingSimMs;
    this.pendingSimMs = 0;
    return Math.max(wall, sim);
  }

  reset(): void {
    this.lastWall = null;
    this.pendingSimMs = 0;
  }
}

export function gameMonthIndex(gameMs: number): number {
  return Math.floor(Math.max(0, gameMs) / GAME_MONTH_MS);
}

/** 1-based month and day of the company clock (30-day months). */
export function companyClock(gameMs: number): CompanyClock {
  const ms = Math.max(0, gameMs);
  return {
    gameMs: Math.floor(ms),
    month: gameMonthIndex(ms) + 1,
    day: Math.floor((ms % GAME_MONTH_MS) / GAME_DAY_MS) + 1,
  };
}

/** "Month 3 · Day 12 · 14:05" */
export function formatGameTime(gameMs: number): string {
  const c = companyClock(gameMs);
  const inDay = Math.max(0, gameMs) % GAME_DAY_MS;
  const h = Math.floor(inDay / 3_600_000);
  const m = Math.floor((inDay % 3_600_000) / 60_000);
  return `Month ${c.month} · Day ${c.day} · ${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}
