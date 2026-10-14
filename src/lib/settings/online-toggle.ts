import { useCallback, useEffect, useState } from "react";

// Per-browser on/off preferences for optional online services (maps, weather). Stored in
// localStorage as "on"/"off"; default on. Every access is guarded (private mode, blocked
// storage, SSR).

const CHANGE_EVENT = "cargo-ops:settings";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** On unless the user turned it off. */
export function getToggle(key: string): boolean {
  try {
    return storage()?.getItem(key) !== "off";
  } catch {
    return true;
  }
}

export function setToggle(key: string, enabled: boolean): void {
  try {
    storage()?.setItem(key, enabled ? "on" : "off");
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * [enabled, setEnabled]. `enabled` is null until mounted, so server and first client
 * render agree and nothing reads storage during SSR.
 */
export function useToggle(key: string): [boolean | null, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    const sync = () => setEnabled(getToggle(key));
    sync();
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, [key]);
  const update = useCallback((value: boolean) => setToggle(key, value), [key]);
  return [enabled, update];
}
