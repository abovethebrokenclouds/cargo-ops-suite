import { useEffect, useRef, useState } from "react";

import { usePrefersReducedMotion } from "./use-reduced-motion";

export const COUNTER_DURATION_MS = 650;

/** easeOutCubic: fast start, gentle landing. */
export function easeOutCubic(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

/** The value shown `elapsed` ms into a counter animation from `from` to `to`. Pure. */
export function counterValue(from: number, to: number, elapsed: number, duration: number): number {
  if (duration <= 0 || elapsed >= duration) return to;
  return from + (to - from) * easeOutCubic(elapsed / duration);
}

/**
 * A number that eases from its previous value to `target` (giant metric counters, plan §4
 * "Motion"). Rules that keep it honest:
 *  - the first value, and any change from or to null, is shown immediately (never a count-up
 *    from zero that would display numbers nobody reported);
 *  - with `prefers-reduced-motion`, during SSR, or when `enabled` is false, it returns
 *    `target` unchanged;
 *  - only for economy figures (cash, totals): live telemetry is never interpolated.
 */
export function useAnimatedNumber(
  target: number | null,
  enabled = true,
  duration = COUNTER_DURATION_MS,
): number | null {
  const reduced = usePrefersReducedMotion();
  const animate = enabled && !reduced;
  const [shown, setShown] = useState<number | null>(target);
  const shownRef = useRef<number | null>(target);

  useEffect(() => {
    const from = shownRef.current;
    const canAnimate =
      animate &&
      target !== null &&
      from !== null &&
      Number.isFinite(target) &&
      Number.isFinite(from) &&
      typeof requestAnimationFrame === "function";
    if (!canAnimate) {
      shownRef.current = target;
      setShown(target);
      return;
    }
    if (from === target) return;
    let frame = 0;
    let start: number | null = null;
    const step = (now: number) => {
      start ??= now;
      const v = counterValue(from, target, now - start, duration);
      shownRef.current = v;
      setShown(v);
      if (v !== target) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [target, animate, duration]);

  return !animate || target === null || shown === null ? target : shown;
}
