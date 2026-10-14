// Authenticated /api routes for weather (the server checks the bearer token first).
//
//   GET /api/weather/metar?ids=KMEM,KATL&online=1
//       → MetarResponse { mode, onlineAllowed, stations: [{ station, report, note }], … }
//   GET /api/weather/taf?ids=KATL&online=1
//       → TafResponse (same envelope, TAF reports with decoded forecast periods)
//
// `online` is the page's per-browser "online weather" switch: with online=0 (or missing)
// the connector makes no request to aviationweather.gov.

import { MAX_STATIONS, normalizeStations } from "../weather";
import type { WeatherService } from "../core/weather";
import type { ApiRequest, ApiResult } from "./server";

const ROUTES = {
  "/api/weather/metar": "metar",
  "/api/weather/taf": "taf",
} as const;

export function weatherApi(weather: WeatherService) {
  return async (req: ApiRequest): Promise<ApiResult | null> => {
    const product = (ROUTES as Record<string, "metar" | "taf" | undefined>)[req.pathname];
    if (!product) return null;
    if (req.method !== "GET") return { status: 405, body: { error: "method_not_allowed" } };
    const stations = normalizeStations((req.query.get("ids") ?? "").split(","));
    if (stations.length === 0) {
      return {
        status: 400,
        body: {
          error: "bad_request",
          message: `ids must list 1–${MAX_STATIONS} ICAO station ids, comma separated`,
        },
      };
    }
    const online = req.query.get("online") === "1";
    const body =
      product === "metar"
        ? await weather.metar(stations, online)
        : await weather.taf(stations, online);
    return { status: 200, body };
  };
}
