// Checked-in allow-list of every SimConnect name the connector may request: SimVars (with
// their documented unit), system event names and system state strings. The audit behind it
// is docs/SIMVARS.md. `test/simvar-catalog.test.ts` fails when simvars.ts, ai-traffic.ts or
// simconnect-source.ts asks for anything that is not listed here, or asks for a SimVar in a
// unit that is not dimensionally compatible with the documented one.
//
// To add a SimVar: look it up in the SDK SimVar index (links below), add it here with the
// documented unit and doc page, add a row to docs/SIMVARS.md, then use it.

/** SDK pages (MSFS 2020 SDK; the 2024 SDK keeps the same names under /msfs2024/). */
const SDK = "https://docs.flightsimulator.com/html/Programming_Tools";
export const DOC = {
  units: `${SDK}/SimVars/Simulation_Variable_Units.htm`,
  index2024:
    "https://docs.flightsimulator.com/msfs2024/html/6_Programming_APIs/SimVars/Simulation_Variables.htm",
  aircraftMisc: `${SDK}/SimVars/Aircraft_SimVars/Aircraft_Misc_Variables.htm`,
  flightModel: `${SDK}/SimVars/Aircraft_SimVars/Aircraft_FlightModel_Variables.htm`,
  fuel: `${SDK}/SimVars/Aircraft_SimVars/Aircraft_Fuel_Variables.htm`,
  engine: `${SDK}/SimVars/Aircraft_SimVars/Aircraft_Engine_Variables.htm`,
  system: `${SDK}/SimVars/Aircraft_SimVars/Aircraft_System_Variables.htm`,
  brakes: `${SDK}/SimVars/Aircraft_SimVars/Aircraft_Brake_Landing_Gear_Variables.htm`,
  radioNav: `${SDK}/SimVars/Aircraft_SimVars/Aircraft_RadioNavigation_Variables.htm`,
  misc: `${SDK}/SimVars/Miscellaneous_Variables.htm`,
  environment:
    "https://docs.flightsimulator.com/msfs2024/html/6_Programming_APIs/Environment_Variables.htm",
  systemEvents: `${SDK}/SimConnect/API_Reference/Events_And_Data/SimConnect_SubscribeToSystemEvent.htm`,
  systemState: `${SDK}/SimConnect/API_Reference/General/SimConnect_RequestSystemState.htm`,
} as const;

/**
 * Unit strings SimConnect converts between, grouped by physical dimension (lower case;
 * SimConnect unit names are case-insensitive). Only the spellings we use or document are
 * listed; a request must use one from the dimension of the documented unit.
 */
export const UNIT_DIMENSIONS = {
  length: ["feet", "meters"],
  speed: ["knots", "feet per second", "feet per minute", "meters per second"],
  angle: ["degrees", "radians"],
  weight: ["pounds", "kilograms"],
  volume: ["gallons", "liters"],
  massFlow: ["pounds per hour", "kilograms per second"],
  volumeFlow: ["gallons per hour"],
  time: ["seconds"],
  number: ["number"],
  bool: ["bool"],
  gforce: ["gforce"],
} as const;
export type UnitDimension = keyof typeof UNIT_DIMENSIONS | "string";

export interface CatalogSimVar {
  /** Base name without the `:index` suffix. */
  name: string;
  /** Unit as the SDK SimVar table lists it (null for strings). */
  docUnit: string | null;
  dimension: UnitDimension;
  /** Requires `:N` (engine/station index). */
  indexed: boolean;
  /**
   * Settable: true only where the documented description says so; null = not confirmed in
   * the audit (the sources used did not carry the SDK's settable column). We never set any.
   */
  settable: boolean | null;
  /** Present in the SimVar tables of each simulator's SDK. */
  msfs2020: boolean;
  msfs2024: boolean;
  doc: string;
  note?: string;
}

const v = (
  name: string,
  docUnit: string | null,
  dimension: UnitDimension,
  doc: string,
  extra: Partial<Pick<CatalogSimVar, "indexed" | "settable" | "note">> = {},
): CatalogSimVar => ({
  name,
  docUnit,
  dimension,
  indexed: extra.indexed ?? false,
  settable: extra.settable === undefined ? null : extra.settable,
  msfs2020: true,
  msfs2024: true,
  doc,
  ...(extra.note ? { note: extra.note } : {}),
});

export const SIMVAR_CATALOG: readonly CatalogSimVar[] = [
  // Counts
  v("NUMBER OF ENGINES", "Number", "number", DOC.engine, {
    note: "0..4 per the SDK",
  }),
  v("PAYLOAD STATION COUNT", "Number", "number", DOC.system),
  // Identity
  v("TITLE", null, "string", DOC.aircraftMisc, {
    note: "aircraft.cfg title; what 2024 modular aircraft report is PC-26",
  }),
  v("ATC ID", null, "string", DOC.radioNav, {
    note: "2024 can briefly report an auto-generated registration after a livery change",
  }),
  // Fuel
  v("FUEL TOTAL QUANTITY", "Gallons", "volume", DOC.fuel),
  v("FUEL TOTAL QUANTITY WEIGHT", "Pounds", "weight", DOC.fuel),
  v("ENG FUEL FLOW PPH", "Pounds per hour", "massFlow", DOC.engine, {
    indexed: true,
  }),
  v("ENG FUEL FLOW GPH", "Gallons per hour", "volumeFlow", DOC.engine, {
    indexed: true,
    note: "catalogued alternative; not requested",
  }),
  // Weights
  v("TOTAL WEIGHT", "Pounds", "weight", DOC.flightModel),
  v("EMPTY WEIGHT", "Pounds", "weight", DOC.flightModel),
  v("MAX GROSS WEIGHT", "Pounds", "weight", DOC.flightModel),
  v("PAYLOAD STATION WEIGHT", "Pounds", "weight", DOC.system, { indexed: true }),
  v("PAYLOAD STATION NAME", null, "string", DOC.system, { indexed: true }),
  // Engines, controls
  v("GENERAL ENG COMBUSTION", "Bool", "bool", DOC.engine, { indexed: true, settable: true }),
  v("BRAKE PARKING POSITION", "Bool", "bool", DOC.brakes),
  // Simulation
  v("SIMULATION RATE", "Number", "number", DOC.environment),
  v("ZULU TIME", "Seconds", "time", DOC.environment),
  v("ZULU DAY OF MONTH", "Number", "number", DOC.environment),
  v("ZULU MONTH OF YEAR", "Number", "number", DOC.environment),
  v("ZULU YEAR", "Number", "number", DOC.environment),
  // Position, motion
  v("PLANE LATITUDE", "Radians", "angle", DOC.aircraftMisc),
  v("PLANE LONGITUDE", "Radians", "angle", DOC.aircraftMisc),
  v("INDICATED ALTITUDE", "Feet", "length", DOC.system),
  v("PLANE ALT ABOVE GROUND", "Feet", "length", DOC.aircraftMisc),
  v("AIRSPEED INDICATED", "Knots", "speed", DOC.aircraftMisc),
  v("AIRSPEED TRUE", "Knots", "speed", DOC.aircraftMisc),
  v("GROUND VELOCITY", "Knots", "speed", DOC.aircraftMisc),
  v("PLANE HEADING DEGREES MAGNETIC", "Radians", "angle", DOC.aircraftMisc),
  v("PLANE HEADING DEGREES TRUE", "Radians", "angle", DOC.aircraftMisc),
  v("VERTICAL SPEED", "Feet per second", "speed", DOC.aircraftMisc),
  v("G FORCE", "GForce", "gforce", DOC.flightModel),
  v("SIM ON GROUND", "Bool", "bool", DOC.misc),
  // Touchdown (latched at the last touchdown of the user aircraft)
  v("PLANE TOUCHDOWN NORMAL VELOCITY", "Feet per second", "speed", DOC.aircraftMisc, {
    note: "sign convention not documented",
  }),
  v("PLANE TOUCHDOWN BANK DEGREES", "Degrees", "angle", DOC.aircraftMisc, {
    note: "sign convention not documented",
  }),
  v("PLANE TOUCHDOWN PITCH DEGREES", "Degrees", "angle", DOC.aircraftMisc, {
    note: "sign convention not documented",
  }),
];

/** System event names documented for SimConnect_SubscribeToSystemEvent (case-insensitive). */
export const SYSTEM_EVENT_CATALOG: readonly string[] = [
  "1sec",
  "4sec",
  "6Hz",
  "AircraftLoaded",
  "Crashed",
  "CrashReset",
  "FlightLoaded",
  "FlightSaved",
  "FlightPlanActivated",
  "FlightPlanDeactivated",
  "Frame",
  "Pause",
  "Pause_EX1",
  "Paused",
  "PauseFrame",
  "PositionChanged",
  "Sim",
  "SimStart",
  "SimStop",
  "Sound",
  "Unpaused",
  "View",
];

/** State names documented for SimConnect_RequestSystemState. */
export const SYSTEM_STATE_CATALOG: readonly string[] = [
  "AircraftLoaded",
  "DialogMode",
  "FlightLoaded",
  "FlightPlan",
  "Sim",
];

const byName = new Map(SIMVAR_CATALOG.map((e) => [e.name, e]));

/** Split `NAME:3` into the base name and index (null when not indexed). */
export function splitSimVar(full: string): { base: string; index: number | null } {
  const m = /^(.*?):(\d+)$/.exec(full);
  return m ? { base: m[1]!, index: Number(m[2]) } : { base: full, index: null };
}

/**
 * Why a concrete request (`NAME` or `NAME:n`, unit, string or numeric datum) would not match
 * the catalogue, or null when it does.
 */
export function catalogProblem(
  simvar: string,
  unit: string | null,
  isString: boolean,
): string | null {
  const { base, index } = splitSimVar(simvar);
  const entry = byName.get(base);
  if (!entry) return `${base} is not in the SimVar catalogue`;
  if (entry.indexed && (index === null || index < 1)) return `${base} needs an index :1..n`;
  if (!entry.indexed && index !== null) return `${base} is not indexed`;
  if (entry.dimension === "string") {
    if (!isString) return `${base} is a string SimVar; request it with a STRING datum type`;
    if (unit !== null && unit !== "") return `${base} is a string; its unit must be null`;
    return null;
  }
  if (isString) return `${base} is numeric; request it as FLOAT64`;
  if (unit === null) return `${base} needs a unit`;
  const allowed: readonly string[] = UNIT_DIMENSIONS[entry.dimension];
  if (!allowed.includes(unit.toLowerCase())) {
    return `${base}: unit "${unit}" is not a ${entry.dimension} unit (documented: ${entry.docUnit})`;
  }
  return null;
}
