import { getToggle, setToggle, useToggle } from "./online-toggle";

// Per-browser UI preference: may the map fetch the online OpenFreeMap basemap?

export const ONLINE_MAPS_KEY = "cargo-ops.map.online";

/** Online maps are allowed unless the user turned them off. */
export function getOnlineMapsEnabled(): boolean {
  return getToggle(ONLINE_MAPS_KEY);
}

export function setOnlineMapsEnabled(enabled: boolean): void {
  setToggle(ONLINE_MAPS_KEY, enabled);
}

/** [enabled, setEnabled]; `enabled` is null until mounted. */
export function useOnlineMapsSetting(): [boolean | null, (enabled: boolean) => void] {
  return useToggle(ONLINE_MAPS_KEY);
}
