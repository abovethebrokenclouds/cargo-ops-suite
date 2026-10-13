import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function mediaQuery(): MediaQueryList | null {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(QUERY)
      : null;
  } catch {
    return null;
  }
}

/** True when the user asked for reduced motion, or when it cannot be known (SSR, no matchMedia). */
export function prefersReducedMotion(): boolean {
  const mql = mediaQuery();
  return mql ? mql.matches : true;
}

function subscribe(onChange: () => void): () => void {
  const mql = mediaQuery();
  if (!mql) return () => {};
  if (typeof mql.addEventListener === "function") {
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }
  // Older engines.
  mql.addListener(onChange);
  return () => mql.removeListener(onChange);
}

/**
 * Live `prefers-reduced-motion`. The server snapshot is `true`, so nothing animates during
 * SSR or hydration and server and client markup agree.
 */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribe, prefersReducedMotion, () => true);
}
