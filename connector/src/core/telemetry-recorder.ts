// Downsampled telemetry for the flights database (plan §3.3): one row per sim
// second, plus 5 Hz for the last 60 s before each touchdown. Rows are timed in
// sim ms since block-out. Rows taken before the flight has an id (taxi-out before
// takeoff) are held in memory and written when it gets one.

import type { FlightPhase } from "../protocol";
import type { FlightSample } from "./flight-sample";
import type { TelemetryRow } from "../storage/flights";

export interface TelemetryConfig {
  baseIntervalMs: number;
  fineIntervalMs: number;
  fineWindowMs: number;
}

export const DEFAULT_TELEMETRY_CONFIG: TelemetryConfig = {
  baseIntervalMs: 1_000,
  fineIntervalMs: 200,
  fineWindowMs: 60_000,
};

export type TelemetrySink = (flightId: string, rows: TelemetryRow[]) => void;

export function telemetryData(s: FlightSample, phase: FlightPhase | null): Record<string, unknown> {
  return {
    lat: s.lat,
    lon: s.lon,
    altFt: Math.round(s.altFt),
    aglFt: Math.round(s.aglFt),
    iasKt: Math.round(s.iasKt * 10) / 10,
    gsKt: Math.round(s.gsKt * 10) / 10,
    vsFpm: Math.round(s.vsFpm),
    hdgTrueDeg: Math.round(s.hdgTrueDeg * 10) / 10,
    gForce: Math.round(s.gForce * 100) / 100,
    onGround: s.onGround,
    phase,
  };
}

export class TelemetryRecorder {
  private readonly config: TelemetryConfig;
  private originMs: number | null = null;
  private flightId: string | null = null;
  private pending: TelemetryRow[] = [];
  private lastBaseMs = -Infinity;
  private lastFineMs = -Infinity;
  /** Recent 5 Hz rows (relative t), oldest first, trimmed to the fine window. */
  private fine: TelemetryRow[] = [];
  rowsWritten = 0;

  constructor(
    private readonly sink: TelemetrySink,
    config: Partial<TelemetryConfig> = {},
  ) {
    this.config = { ...DEFAULT_TELEMETRY_CONFIG, ...config };
  }

  get recording(): boolean {
    return this.originMs !== null;
  }

  /** Start a leg at sim time `tMs`. */
  begin(tMs: number): void {
    this.originMs = tMs;
    this.flightId = null;
    this.pending = [];
    this.fine = [];
    this.lastBaseMs = -Infinity;
    this.lastFineMs = -Infinity;
  }

  /** The leg became a flight: flush what was held. */
  attach(flightId: string): void {
    this.flightId = flightId;
    this.write(this.pending);
    this.pending = [];
  }

  sample(s: FlightSample, phase: FlightPhase | null): void {
    if (this.originMs === null) return;
    const t = s.tMs - this.originMs;
    const c = this.config;
    if (t - this.lastFineMs >= c.fineIntervalMs) {
      this.lastFineMs = t;
      this.fine.push({ tMs: t, data: telemetryData(s, phase) });
      while (this.fine.length > 0 && t - (this.fine[0]?.tMs ?? t) > c.fineWindowMs) {
        this.fine.shift();
      }
    }
    if (t - this.lastBaseMs >= c.baseIntervalMs) {
      this.lastBaseMs = t;
      this.write([{ tMs: t, data: telemetryData(s, phase) }]);
    }
  }

  /** Touchdown at sim time `tMs`: keep the 5 Hz rows of the preceding 60 s. */
  touchdown(tMs: number): void {
    if (this.originMs === null) return;
    const t = tMs - this.originMs;
    this.write(this.fine.filter((r) => r.tMs <= t && t - r.tMs <= this.config.fineWindowMs));
  }

  end(): void {
    this.originMs = null;
    this.flightId = null;
    this.pending = [];
    this.fine = [];
  }

  private write(rows: TelemetryRow[]): void {
    if (rows.length === 0) return;
    if (this.flightId === null) {
      this.pending.push(...rows);
      return;
    }
    this.sink(this.flightId, rows);
    this.rowsWritten += rows.length;
  }
}
