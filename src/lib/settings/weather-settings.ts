import { getToggle, setToggle, useToggle } from "./online-toggle";

// Per-browser UI preference, like online maps: may the connector fetch live METARs from
// aviationweather.gov for this page? Off = the page asks with online=0 and the connector
// makes no request. The in-browser demo never goes online (it shows SAMPLE reports).

export const ONLINE_WEATHER_KEY = "cargo-ops.weather.online";

export function getOnlineWeatherEnabled(): boolean {
  return getToggle(ONLINE_WEATHER_KEY);
}

export function setOnlineWeatherEnabled(enabled: boolean): void {
  setToggle(ONLINE_WEATHER_KEY, enabled);
}

/** [enabled, setEnabled]; `enabled` is null until mounted. */
export function useOnlineWeatherSetting(): [boolean | null, (enabled: boolean) => void] {
  return useToggle(ONLINE_WEATHER_KEY);
}
