// Logbook data from the connector's /api/logbook (flights joined with missions).
// Only fetched when a connector session exists; the browser demo never invents flights.

import { useEffect, useState } from "react";
import type { Mission, PayloadCheck, Touchdown } from "@cargo-ops/protocol";
import type { ClientSimState } from "@/lib/sim-state";
import { connectorJson } from "@/lib/transport/connector-api";

export interface LogbookEntry {
  id: string;
  status: string;
  source: string;
  startedAt: string | null;
  endedAt: string | null;
  origin: string | null;
  destination: string | null;
  aircraftTitle: string | null;
  distanceNm: number | null;
  blockMin: number | null;
  airborneMin: number | null;
  fuelUsedKg: number | null;
  payloadKg: number | null;
  landing: Touchdown | null;
  flags: Record<string, boolean> | null;
  mission: {
    id: string;
    status: string;
    origin: string;
    destination: string;
    payout: number | null;
    jobs: Array<{ id: string; kind: string; weightKg: number }>;
    failure: { code: string; message: string } | null;
    /** Cargo vs sim payload frozen at departure; absent on older connectors/missions. */
    payloadCheck?: PayloadCheck | null;
  } | null;
}

const REFRESH_EVENTS = new Set([
  "flight.ended",
  "flight.started",
  "mission.delivered",
  "mission.failed",
]);

export interface LogbookView {
  entries: LogbookEntry[] | null;
  missions: Mission[];
  error: string | null;
  connector: boolean;
}

export function useLogbook(state: ClientSimState): LogbookView {
  const connector = state.connection === "live" || state.connection === "replay";
  const [entries, setEntries] = useState<LogbookEntry[] | null>(null);
  const [missions, setMissions] = useState<Mission[]>([]);
  const [error, setError] = useState<string | null>(null);
  const lastEvent = state.events.at(-1);
  const trigger =
    lastEvent && REFRESH_EVENTS.has(lastEvent.msg.name) ? lastEvent.msg.seq : "initial";

  useEffect(() => {
    if (!connector) return;
    let alive = true;
    const load = () =>
      Promise.all([
        connectorJson<{ flights: LogbookEntry[] }>("/api/logbook"),
        connectorJson<{ missions: Mission[] }>("/api/missions"),
      ])
        .then(([log, ms]) => {
          if (!alive) return;
          setEntries(log.flights);
          setMissions(ms.missions);
          setError(null);
        })
        .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : "failed"));
    void load();
    const id = globalThis.setInterval(() => void load(), 15_000);
    return () => {
      alive = false;
      globalThis.clearInterval(id);
    };
  }, [connector, trigger]);

  return { entries: connector ? entries : null, missions, error, connector };
}

export function useTrack(flightId: string | null): Array<{ lat: number; lon: number }> | null {
  const [points, setPoints] = useState<Array<{ lat: number; lon: number }> | null>(null);
  useEffect(() => {
    setPoints(null);
    if (!flightId) return;
    let alive = true;
    connectorJson<{ points: Array<Record<string, unknown>> }>(
      `/api/flights/${encodeURIComponent(flightId)}/track`,
    )
      .then((t) => {
        if (!alive) return;
        setPoints(
          t.points.flatMap((p) =>
            typeof p["lat"] === "number" && typeof p["lon"] === "number"
              ? [{ lat: p["lat"], lon: p["lon"] }]
              : [],
          ),
        );
      })
      .catch(() => alive && setPoints([]));
    return () => {
      alive = false;
    };
  }, [flightId]);
  return points;
}
