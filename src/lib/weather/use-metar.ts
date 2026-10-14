// METARs and TAFs for a list of stations, from the right place for this page:
//  - in-browser demo (no connector): built-in SAMPLE reports, no network at all;
//  - served by the connector: GET /api/weather/metar or /api/weather/taf, passing the
//    per-browser "online weather" switch so the connector only goes online when it is on.
// Browser-only (effects). METARs refresh every 5 minutes while mounted (the connector caches
// live reports for 10 minutes), TAFs every 15 minutes (cached 30 minutes), so most refreshes
// cost no request upstream. All components on the page share one cache per product
// (weather-store.ts): a station another component already loaded is not asked for again, and
// stations requested in the same tick go to the connector in one request.

import { useEffect, useMemo, useState } from "react";
import {
  AWC_ATTRIBUTION,
  AWC_METAR_URL,
  AWC_TAF_ATTRIBUTION,
  AWC_TAF_URL,
  normalizeStations,
  sampleMetar,
  sampleTaf,
  SAMPLE_NOTE,
  SAMPLE_TAF_NOTE,
  type MetarReport,
  type MetarResponse,
  type TafReport,
  type TafResponse,
  type WeatherResponse,
} from "@cargo-ops/weather";

import { useOnlineWeatherSetting } from "@/lib/settings/weather-settings";
import { useSimConnection } from "@/lib/transport/useSimConnection";

import { StationStore } from "./weather-store";

export const METAR_REFRESH_MS = 5 * 60_000;
export const TAF_REFRESH_MS = 15 * 60_000;

export type WeatherState<T> =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "unavailable"; message: string }
  | { status: "error"; message: string }
  | { status: "ready"; data: T };

export type MetarState = WeatherState<MetarResponse>;
export type TafState = WeatherState<TafResponse>;

/** The demo's SAMPLE METAR response (also used by tests). */
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

/** The demo's SAMPLE TAF response (also used by tests). */
export function sampleTafResponse(
  stations: readonly string[],
  now: Date = new Date(),
): TafResponse {
  return {
    mode: "sample",
    onlineAllowed: false,
    stations: stations.map((station) => ({
      station,
      report: sampleTaf(station, now),
      note: SAMPLE_TAF_NOTE,
    })),
    attribution: AWC_TAF_ATTRIBUTION,
    endpoint: AWC_TAF_URL,
  };
}

interface Product<R> {
  store: StationStore<R>;
  refreshMs: number;
  sample: (stations: readonly string[]) => WeatherResponse<R>;
}

function useStationWeather<R>(
  ids: readonly (string | null | undefined)[],
  product: Product<R>,
): WeatherState<WeatherResponse<R>> {
  const { state, transportKind } = useSimConnection();
  const [online] = useOnlineWeatherSetting();
  const key = normalizeStations(ids).join(",");
  const stations = useMemo(() => (key ? key.split(",") : []), [key]);
  const connected = state.connection === "live" || state.connection === "replay";
  const demo = transportKind === "demo";
  const [result, setResult] = useState<WeatherState<WeatherResponse<R>>>({ status: "idle" });
  const { store, refreshMs, sample } = product;

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
      const build = () => setResult({ status: "ready", data: sample(stations) });
      build();
      const timer = globalThis.setInterval(build, refreshMs);
      return () => globalThis.clearInterval(timer);
    }
    if (!connected) {
      setResult({ status: "unavailable", message: "Weather needs the connector." });
      return;
    }
    if (online === null) return;
    let alive = true;
    const load = () =>
      store
        .load(stations, online)
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
    const timer = globalThis.setInterval(() => void load(), refreshMs);
    return () => {
      alive = false;
      globalThis.clearInterval(timer);
    };
  }, [stations, transportKind, demo, connected, online, store, refreshMs, sample]);

  return result;
}

/** Shared per page; a result counts as current until shortly before the next poll is due. */
export const metarStore = new StationStore<MetarReport>(
  "/api/weather/metar",
  METAR_REFRESH_MS - 15_000,
);
export const tafStore = new StationStore<TafReport>("/api/weather/taf", TAF_REFRESH_MS - 15_000);

/** Clear both shared caches (tests). */
export function resetWeatherStores(): void {
  metarStore.reset();
  tafStore.reset();
}

const METAR_PRODUCT: Product<MetarReport> = {
  store: metarStore,
  refreshMs: METAR_REFRESH_MS,
  sample: (stations) => sampleResponse(stations),
};

const TAF_PRODUCT: Product<TafReport> = {
  store: tafStore,
  refreshMs: TAF_REFRESH_MS,
  sample: (stations) => sampleTafResponse(stations),
};

export function useMetar(ids: readonly (string | null | undefined)[]): MetarState {
  return useStationWeather(ids, METAR_PRODUCT);
}

export function useTaf(ids: readonly (string | null | undefined)[]): TafState {
  return useStationWeather(ids, TAF_PRODUCT);
}
