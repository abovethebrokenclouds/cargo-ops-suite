// Authenticated /api routes for cargo operations (the server checks the bearer
// token before any of these run):
//
//   GET  /api/jobs                 → jobs domain (boards, available, accepted, aircraft)
//   GET  /api/missions             → { missions } newest first (≤ 50)
//   GET  /api/logbook              → { flights } joined with their mission and payout
//   GET  /api/export/csv           → logbook CSV (text/csv)
//   GET  /api/export/gpx?flight=ID → one flight's track (application/gpx+xml)
//   GET  /api/export/json          → JSON career export
//   POST /api/import               → JSON career import (refused while a flight is active)

import type { ConnectorSession } from "../core/session";
import type { DatabaseKind } from "../storage/db";
import { exportCareer, flightGpx, importCareer, logbookCsv } from "../storage/career";
import type { EconomyRepo } from "../storage/economy";
import type { FlightRepo } from "../storage/flights";
import type { ApiRequest, ApiResult } from "./server";

export interface EconomyApiOptions {
  session: ConnectorSession;
  repo: EconomyRepo;
  flights: FlightRepo;
  database: DatabaseKind;
  now?: () => number;
}

const methodNotAllowed: ApiResult = { status: 405, body: { error: "method_not_allowed" } };

export function economyApi(options: EconomyApiOptions) {
  const { session, repo, flights, database } = options;
  const now = options.now ?? Date.now;
  const stamp = () => new Date(now()).toISOString().slice(0, 10);

  return (req: ApiRequest): ApiResult | null => {
    const { method, pathname, query } = req;
    switch (pathname) {
      case "/api/jobs":
        if (method !== "GET") return methodNotAllowed;
        if (!session.economy) return { status: 404, body: { error: "not_found" } };
        return { status: 200, body: session.economy.jobsDomain() };
      case "/api/missions":
        if (method !== "GET") return methodNotAllowed;
        return { status: 200, body: { missions: repo.listMissions(50) } };
      case "/api/logbook":
        if (method !== "GET") return methodNotAllowed;
        return { status: 200, body: { flights: repo.logbook(200) } };
      case "/api/export/csv":
        if (method !== "GET") return methodNotAllowed;
        return {
          status: 200,
          text: logbookCsv(repo.logbook(5_000)),
          contentType: "text/csv; charset=utf-8",
          filename: `cargo-ops-logbook-${database}-${stamp()}.csv`,
        };
      case "/api/export/gpx": {
        if (method !== "GET") return methodNotAllowed;
        const id = query.get("flight");
        if (!id || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
          return {
            status: 400,
            body: { error: "bad_request", message: "?flight=<id> is required" },
          };
        }
        const track = flights.track(id);
        const entry = repo.logbook(5_000).find((e) => e.id === id);
        if (!track || !entry) return { status: 404, body: { error: "not_found" } };
        return {
          status: 200,
          text: flightGpx(track, {
            origin: entry.origin,
            destination: entry.destination,
            startedAt: entry.startedAt,
            source: entry.source,
          }),
          contentType: "application/gpx+xml; charset=utf-8",
          filename: `cargo-ops-${id}.gpx`,
        };
      }
      case "/api/export/json":
        if (method !== "GET") return methodNotAllowed;
        return {
          status: 200,
          text: JSON.stringify(exportCareer(repo, database, now()), null, 2),
          contentType: "application/json; charset=utf-8",
          filename: `cargo-ops-career-${database}-${stamp()}.json`,
        };
      case "/api/import": {
        if (method !== "POST") return methodNotAllowed;
        if (session.flight.tracker.active || session.economy?.missionInProgress) {
          return {
            status: 409,
            body: {
              error: "flight_active",
              message: "Finish or end the current flight before importing",
            },
          };
        }
        const result = importCareer(repo, database, req.body);
        if (!result.ok)
          return { status: result.status, body: { error: result.code, message: result.message } };
        session.economy?.reload();
        return { status: 200, body: { ok: true, counts: result.counts } };
      }
      default:
        return null;
    }
  };
}
