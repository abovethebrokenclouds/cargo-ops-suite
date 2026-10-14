// THE SimVar table (plan §6.1). Every SimVar the connector reads is listed here
// once, with the unit it is requested in and the key the mapping code uses.
// After testing on the Windows PC, fix names/units HERE ONLY; the data
// definitions, the frame reader and the pure mapping functions all derive from
// this table.
//
// Every name/unit here must also be in simvar-catalog.ts (the checked-in allow-list,
// audited in docs/SIMVARS.md); a test enforces it.
//
// `verified: false` marks entries whose behaviour still needs the PC check (§14.12:
// docs/SIMVARS.md lists what exactly) or that differ between MSFS 2020 and 2024. If the simulator
// rejects a name, SimConnectSource drops that entry (it logs the SimConnect
// exception) and the dependent domain is simply not reported. Nothing is filled
// in with a guessed value.

/** How a value is requested and read from the SimConnect buffer. */
export type SimVarType = "f64" | "string64" | "string256";

/**
 * Which data definition the entry belongs to.
 * - `counts`: requested once per aircraft load; sizes the indexed entries.
 * - `slow`:   1 Hz (SimConnectPeriod.SECOND).
 * - `fast`:   every sim frame, throttled to 5 Hz (10 Hz below 1,000 ft AGL).
 */
export type SimVarGroup = "counts" | "slow" | "fast";

/** Indexed SimVars are expanded to `NAME:1`..`NAME:n` using the named count. */
export type SimVarIndex = "engine" | "station";

export interface SimVarSpec {
  key: string;
  name: string;
  /** SimConnect unit string; null for strings. */
  unit: string | null;
  type: SimVarType;
  group: SimVarGroup;
  index?: SimVarIndex;
  verified: boolean;
  note?: string;
}

/** Upper bounds for indexed SimVars so a bad count can never explode a definition. */
export const MAX_ENGINES = 4;
export const MAX_STATIONS = 20;

export const SIMVARS: readonly SimVarSpec[] = [
  // ---- counts (once per aircraft) ----
  {
    key: "engineCount",
    name: "NUMBER OF ENGINES",
    unit: "number",
    type: "f64",
    group: "counts",
    verified: true,
  },
  {
    key: "stationCount",
    name: "PAYLOAD STATION COUNT",
    unit: "number",
    type: "f64",
    group: "counts",
    verified: true,
  },

  // ---- slow (1 Hz) ----
  { key: "title", name: "TITLE", unit: null, type: "string256", group: "slow", verified: true },
  { key: "atcId", name: "ATC ID", unit: null, type: "string64", group: "slow", verified: true },
  {
    key: "fuelGal",
    name: "FUEL TOTAL QUANTITY",
    unit: "gallons",
    type: "f64",
    group: "slow",
    verified: true,
  },
  {
    key: "fuelLb",
    name: "FUEL TOTAL QUANTITY WEIGHT",
    unit: "pounds",
    type: "f64",
    group: "slow",
    verified: true,
    note: "legacy fuel system SimVar; may mismatch some 2024 aircraft (§14.2)",
  },
  {
    key: "fuelFlowPph",
    name: "ENG FUEL FLOW PPH",
    unit: "pounds per hour",
    type: "f64",
    group: "slow",
    index: "engine",
    verified: false,
    note: "documented in both SDKs (Pounds per hour); values on 2024 fuel-system aircraft need the PC check",
  },
  {
    key: "totalWeightLb",
    name: "TOTAL WEIGHT",
    unit: "pounds",
    type: "f64",
    group: "slow",
    verified: true,
  },
  {
    key: "emptyWeightLb",
    name: "EMPTY WEIGHT",
    unit: "pounds",
    type: "f64",
    group: "slow",
    verified: true,
  },
  {
    key: "maxGrossWeightLb",
    name: "MAX GROSS WEIGHT",
    unit: "pounds",
    type: "f64",
    group: "slow",
    verified: true,
  },
  {
    key: "stationWeightLb",
    name: "PAYLOAD STATION WEIGHT",
    unit: "pounds",
    type: "f64",
    group: "slow",
    index: "station",
    verified: false,
    note: "documented unit Pounds; per-station values need the PC check",
  },
  {
    key: "stationName",
    name: "PAYLOAD STATION NAME",
    unit: null,
    type: "string64",
    group: "slow",
    index: "station",
    verified: false,
    note: "documented as a string; length not documented, read as STRING64",
  },
  {
    key: "engineCombustion",
    name: "GENERAL ENG COMBUSTION",
    unit: "bool",
    type: "f64",
    group: "slow",
    index: "engine",
    verified: true,
  },
  {
    key: "parkingBrake",
    name: "BRAKE PARKING POSITION",
    unit: "bool",
    type: "f64",
    group: "slow",
    verified: true,
  },
  {
    key: "simRate",
    name: "SIMULATION RATE",
    unit: "number",
    type: "f64",
    group: "slow",
    verified: false,
    note: "documented (Number, read-only); behaviour on rate changes needs the PC check",
  },
  {
    key: "zuluTimeSec",
    name: "ZULU TIME",
    unit: "seconds",
    type: "f64",
    group: "slow",
    verified: true,
  },
  {
    key: "zuluDay",
    name: "ZULU DAY OF MONTH",
    unit: "number",
    type: "f64",
    group: "slow",
    verified: true,
  },
  {
    key: "zuluMonth",
    name: "ZULU MONTH OF YEAR",
    unit: "number",
    type: "f64",
    group: "slow",
    verified: true,
  },
  {
    key: "zuluYear",
    name: "ZULU YEAR",
    unit: "number",
    type: "f64",
    group: "slow",
    verified: true,
  },

  // ---- fast (5/10 Hz) ----
  {
    key: "lat",
    name: "PLANE LATITUDE",
    unit: "degrees",
    type: "f64",
    group: "fast",
    verified: true,
  },
  {
    key: "lon",
    name: "PLANE LONGITUDE",
    unit: "degrees",
    type: "f64",
    group: "fast",
    verified: true,
  },
  {
    key: "altFt",
    name: "INDICATED ALTITUDE",
    unit: "feet",
    type: "f64",
    group: "fast",
    verified: true,
  },
  {
    key: "aglFt",
    name: "PLANE ALT ABOVE GROUND",
    unit: "feet",
    type: "f64",
    group: "fast",
    verified: true,
  },
  {
    key: "iasKt",
    name: "AIRSPEED INDICATED",
    unit: "knots",
    type: "f64",
    group: "fast",
    verified: true,
  },
  {
    key: "tasKt",
    name: "AIRSPEED TRUE",
    unit: "knots",
    type: "f64",
    group: "fast",
    verified: true,
  },
  {
    key: "gsKt",
    name: "GROUND VELOCITY",
    unit: "knots",
    type: "f64",
    group: "fast",
    verified: true,
  },
  {
    key: "hdgMagDeg",
    name: "PLANE HEADING DEGREES MAGNETIC",
    unit: "degrees",
    type: "f64",
    group: "fast",
    verified: true,
  },
  {
    key: "hdgTrueDeg",
    name: "PLANE HEADING DEGREES TRUE",
    unit: "degrees",
    type: "f64",
    group: "fast",
    verified: true,
  },
  {
    key: "vsFpm",
    name: "VERTICAL SPEED",
    unit: "feet per minute",
    type: "f64",
    group: "fast",
    verified: true,
  },
  { key: "gForce", name: "G FORCE", unit: "GForce", type: "f64", group: "fast", verified: true },
  {
    key: "touchdownNormalFps",
    name: "PLANE TOUCHDOWN NORMAL VELOCITY",
    unit: "feet per second",
    type: "f64",
    group: "fast",
    verified: false,
    note: "latched at the last touchdown; ×60 → fpm in mapping; sign not documented, the analyser uses the magnitude",
  },
  {
    key: "touchdownBankDeg",
    name: "PLANE TOUCHDOWN BANK DEGREES",
    unit: "degrees",
    type: "f64",
    group: "fast",
    verified: false,
    note: "latched at the last touchdown; sign convention not documented",
  },
  {
    key: "touchdownPitchDeg",
    name: "PLANE TOUCHDOWN PITCH DEGREES",
    unit: "degrees",
    type: "f64",
    group: "fast",
    verified: false,
    note: "latched at the last touchdown; sign convention not documented; reported as the sim gives it",
  },
  {
    key: "simOnGround",
    name: "SIM ON GROUND",
    unit: "bool",
    type: "f64",
    group: "fast",
    verified: true,
    note: "documented on-ground flag in both SDKs (docs/SIMVARS.md); IS ON GROUND is not in either SimVar table",
  },
];

/** One concrete datum in a data definition, after index expansion. */
export interface DatumSpec {
  /** Key for the raw value record: `key` or `key:i` for indexed entries. */
  rawKey: string;
  /** Full SimVar name including `:i` for indexed entries. */
  simvar: string;
  unit: string | null;
  type: SimVarType;
  spec: SimVarSpec;
}

export interface IndexCounts {
  engines: number;
  stations: number;
}

/** Clamp a raw count reported by the sim to [0, max]. */
export function clampCount(value: unknown, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(max, Math.floor(value)));
}

/**
 * Expand the table entries of a group into concrete datums, in a stable order.
 * `disabled` holds raw keys or base keys the simulator rejected.
 */
export function buildDatums(
  group: SimVarGroup,
  counts: IndexCounts,
  disabled: ReadonlySet<string> = new Set(),
): DatumSpec[] {
  const out: DatumSpec[] = [];
  for (const spec of SIMVARS) {
    if (spec.group !== group || disabled.has(spec.key)) continue;
    if (!spec.index) {
      out.push({ rawKey: spec.key, simvar: spec.name, unit: spec.unit, type: spec.type, spec });
      continue;
    }
    const n = spec.index === "engine" ? counts.engines : counts.stations;
    for (let i = 1; i <= n; i++) {
      const rawKey = `${spec.key}:${i}`;
      if (disabled.has(rawKey)) continue;
      out.push({ rawKey, simvar: `${spec.name}:${i}`, unit: spec.unit, type: spec.type, spec });
    }
  }
  return out;
}

/** Raw values read from one SimConnect frame, keyed by DatumSpec.rawKey. */
export type RawValues = Record<string, number | string>;

/** SimVars the plan flags as unverified, for logs and the setup docs. */
export function unverifiedSimVars(): string[] {
  return SIMVARS.filter((s) => !s.verified).map((s) => s.name);
}
