// METARs for a list of stations, from the right place for this page:
//  - in-browser demo (no connector): built-in SAMPLE reports, no network at all;
//  - served by the connector: GET /api/weather/metar, passing the per-browser
//    "online weather" switch so the connector only goes online when it is on.
// Browser-only (effects); refreshed every 5 minutes while mounted (the connector caches
// live reports for 10 minutes, so most refreshes cost no request upstream).

import { useEffect, useMemo, useState } from "react";
import {
  AWC_ATTRIBUTION,
  AWC_METAR_URL,
  normalizeStations,
  sampleMetar,
  SAMPLE_NOTE,
  type MetarResponse,
} from "@cargo-ops/weather";

import { useOnlineWeatherSetting } from "@/lib/settings/weather-settings";
import { connectorJson } from "@/lib/transport/connector-api";
import { useSimConnection } from "@/lib/transport/useSimConnection";

export const METAR_REFRESH_MS = 5 * 60_000;

export type MetarState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; data: MetarResponse };

/** The demo's SAMPLE response (also used by tests). */
export function sampleResponse(stations: readonly string[], now: Date = new Date()): MetarResponse {
  return {
    mode: "sample",
    onlineAllowed: false,
    stations: stations.map((station) => ({
      station,
      report: sampleMetar(station, now),
      note: SAMPLE_NOTE,
    })),
    attribution: AWC_ATTRIBUTION,
    endpoint: AWC_METAR_URL,
  };
}

export function useMetar(ids: readonly (string | null | undefined)[]): MetarState {
  const { state, transportKind } = useSimConnection();
  const [online] = useOnlineWeatherSetting();
  const key = normalizeStations(ids).join(",");
  const stations = useMemo(() => (key ? key.split(",") : []), [key]);
  const connected = state.connection === "live" || state.connection === "replay";
  const demo = transportKind === "demo";
  const [result, setResult] = useState<MetarState>({ status: "idle" });

  useEffect(() => {
    if (stations.length === 0) {
      setResult({ status: "idle" });
      return;
    }
    if (transportKind === null) {
      setResult({ status: "loading" });
      return;
    }
    if (demo) {
      const build = () => setResult({ status: "ready", data: sampleResponse(stations) });
      build();
      const timer = globalThis.setInterval(build, METAR_REFRESH_MS);
      return () => globalThis.clearInterval(timer);
    }
    if (!connected) {
      setResult({ status: "unavailable", message: "Weather needs the connector." });
      return;
    }
    if (online === null) return;
    let alive = true;
    const load = () =>
      connectorJson<MetarResponse>(
        `/api/weather/metar?ids=${stations.join(",")}&online=${online ? 1 : 0}`,
      )
        .then((data) => alive && setResult({ status: "ready", data }))
        .catch(
          (err: unknown) =>
            alive &&
            setResult({
              status: "error",
              message: err instanceof Error ? err.message : "Weather request failed",
            }),
        );
    setResult((r) => (r.status === "ready" ? r : { status: "loading" }));
    void load();
    const timer = globalThis.setInterval(() => void load(), METAR_REFRESH_MS);
    return () => {
      alive = false;
      globalThis.clearInterval(timer);
    };
  }, [stations, transportKind, demo, connected, online]);

  return result;
}
