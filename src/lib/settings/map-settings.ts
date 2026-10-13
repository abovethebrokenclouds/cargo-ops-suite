import { useCallback, useEffect, useState } from "react";

// Per-browser UI preference: may the map fetch the online OpenFreeMap basemap?
// Stored in localStorage; every access is guarded (private mode, blocked storage, SSR).

export const ONLINE_MAPS_KEY = "cargo-ops.map.online";
const CHANGE_EVENT = "cargo-ops:settings";

function storage(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.localStorage : null;
  } catch {
    return null;
  }
}

/** Online maps are allowed unless the user turned them off. */
export function getOnlineMapsEnabled(): boolean {
  try {
    return storage()?.getItem(ONLINE_MAPS_KEY) !== "off";
  } catch {
    return true;
  }
}

export function setOnlineMapsEnabled(enabled: boolean): void {
  try {
    storage()?.setItem(ONLINE_MAPS_KEY, enabled ? "on" : "off");
  } catch {
    // Storage unavailable: the choice lasts for this page only.
  }
  if (typeof window !== "undefined") window.dispatchEvent(new Event(CHANGE_EVENT));
}

/**
 * [enabled, setEnabled]. `enabled` is null until mounted, so server and first client
 * render agree and nothing reads storage during SSR.
 */
export function useOnlineMapsSetting(): [boolean | null, (enabled: boolean) => void] {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  useEffect(() => {
    const sync = () => setEnabled(getOnlineMapsEnabled());
    sync();
    window.addEventListener(CHANGE_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(CHANGE_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  const update = useCallback((value: boolean) => setOnlineMapsEnabled(value), []);
  return [enabled, update];
}
