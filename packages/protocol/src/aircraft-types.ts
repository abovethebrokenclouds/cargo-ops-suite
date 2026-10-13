import { z } from "zod";

// Aircraft type catalogue (plan §7 "Fleet", P3 subset). Every figure below is an
// APPROXIMATE value rounded from public manufacturer spec sheets and general
// references, chosen for gameplay: it is not a performance table, not certified
// data and not copied from any copyrighted dataset. Payload is the usable cargo
// payload with typical fuel, range the practical range with a moderate load,
// cruise a typical cruise TAS, fuel burn a typical cruise burn, and approach a
// typical final-approach speed used as the landing speed-grade reference (§6.3).
// P4 adds engine count, a Vmo/Vne figure for the overspeed detector, a new-aircraft
// price and lease rates: APPROXIMATE gameplay figures (in-house, rounded from public
// list-price reporting), not quotes and not copied from any dataset.

/** Runway surface classes derived from OurAirports surface codes. */
export const SURFACE_CLASSES = ["paved", "gravel", "turf", "dirt", "water", "unknown"] as const;
export const surfaceClassSchema = z.enum(SURFACE_CLASSES);
export type SurfaceClass = z.infer<typeof surfaceClassSchema>;

export const AIRCRAFT_CATEGORIES = [
  "single-piston",
  "single-turboprop",
  "twin-turboprop",
  "regional-turboprop",
  "narrowbody-jet",
  "widebody-jet",
] as const;

export const aircraftTypeSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/),
  name: z.string().min(1),
  category: z.enum(AIRCRAFT_CATEGORIES),
  /** Usable cargo payload, kg (approximate). */
  maxPayloadKg: z.number().positive(),
  /** Practical range with a moderate load, nm (approximate). */
  rangeNm: z.number().positive(),
  /** Typical cruise true airspeed, kt (approximate). */
  cruiseKt: z.number().positive(),
  /** Shortest runway the type is dispatched to, ft (approximate). */
  minRunwayFt: z.number().positive(),
  surfaces: z.array(surfaceClassSchema).min(1),
  /** Typical cruise fuel burn, kg per hour (approximate). */
  fuelBurnKgH: z.number().positive(),
  /** Typical final-approach speed, kt: the landing speed-grade reference. */
  approachKt: z.number().positive(),
  /** Engine count (dry leases bill per engine-hour). */
  engines: z.number().int().positive(),
  /**
   * Maximum operating / never-exceed indicated airspeed, kt (approximate): above it for
   * 3 s of simulator time counts one overspeed event in the wear model.
   */
  vmoKt: z.number().positive(),
  /** New-aircraft catalogue price, USD (approximate, gameplay; not a quote). */
  priceUsd: z.number().positive(),
  /** Dry lease rate, USD per engine-hour of block time (fuel billed separately). */
  dryLeaseUsdPerEngineHour: z.number().positive(),
  /** Wet lease rate, USD per block hour, fuel included. */
  wetLeaseUsdPerBlockHour: z.number().positive(),
  /**
   * TITLE match rules: the type matches when every keyword of ANY group appears in
   * the lower-cased TITLE. Earlier catalogue entries win.
   */
  match: z.array(z.array(z.string().min(1)).min(1)).min(1),
});
export type AircraftType = z.infer<typeof aircraftTypeSchema>;

const UNPAVED: SurfaceClass[] = ["paved", "gravel", "turf", "dirt"];

/** Approximate, for gameplay. See the header comment. */
export const AIRCRAFT_TYPES: readonly AircraftType[] = [
  {
    key: "pc6",
    name: "Pilatus PC-6 Porter",
    category: "single-turboprop",
    maxPayloadKg: 800,
    rangeNm: 500,
    cruiseKt: 115,
    minRunwayFt: 1_000,
    surfaces: UNPAVED,
    fuelBurnKgH: 110,
    approachKt: 60,
    engines: 1,
    vmoKt: 151,
    priceUsd: 2_300_000,
    dryLeaseUsdPerEngineHour: 280,
    wetLeaseUsdPerBlockHour: 650,
    match: [["porter"], ["pc-6"], ["pc6"]],
  },
  {
    key: "kodiak100",
    name: "Daher Kodiak 100",
    category: "single-turboprop",
    maxPayloadKg: 1_000,
    rangeNm: 1_000,
    cruiseKt: 170,
    minRunwayFt: 1_500,
    surfaces: UNPAVED,
    fuelBurnKgH: 150,
    approachKt: 70,
    engines: 1,
    vmoKt: 182,
    priceUsd: 2_600_000,
    dryLeaseUsdPerEngineHour: 300,
    wetLeaseUsdPerBlockHour: 750,
    match: [["kodiak"]],
  },
  {
    key: "c208b",
    name: "Cessna 208B Grand Caravan",
    category: "single-turboprop",
    maxPayloadKg: 1_360,
    rangeNm: 900,
    cruiseKt: 170,
    minRunwayFt: 2_500,
    surfaces: UNPAVED,
    fuelBurnKgH: 170,
    approachKt: 80,
    engines: 1,
    vmoKt: 175,
    priceUsd: 2_700_000,
    dryLeaseUsdPerEngineHour: 320,
    wetLeaseUsdPerBlockHour: 800,
    match: [["208"], ["caravan"]],
  },
  {
    key: "dhc6",
    name: "DHC-6 Twin Otter",
    category: "twin-turboprop",
    maxPayloadKg: 1_800,
    rangeNm: 750,
    cruiseKt: 170,
    minRunwayFt: 1_500,
    surfaces: UNPAVED,
    fuelBurnKgH: 280,
    approachKt: 75,
    engines: 2,
    vmoKt: 170,
    priceUsd: 7_000_000,
    dryLeaseUsdPerEngineHour: 380,
    wetLeaseUsdPerBlockHour: 1_600,
    match: [["twin otter"], ["dhc-6"], ["dhc6"]],
  },
  {
    key: "pc12",
    name: "Pilatus PC-12",
    category: "single-turboprop",
    maxPayloadKg: 1_100,
    rangeNm: 1_700,
    cruiseKt: 270,
    minRunwayFt: 2_600,
    surfaces: ["paved", "gravel", "turf"],
    fuelBurnKgH: 230,
    approachKt: 85,
    engines: 1,
    vmoKt: 240,
    priceUsd: 5_500_000,
    dryLeaseUsdPerEngineHour: 520,
    wetLeaseUsdPerBlockHour: 1_150,
    match: [["pc-12"], ["pc12"]],
  },
  {
    key: "kingair350",
    name: "Beechcraft King Air 350",
    category: "twin-turboprop",
    maxPayloadKg: 1_500,
    rangeNm: 1_700,
    cruiseKt: 300,
    minRunwayFt: 3_300,
    surfaces: ["paved", "gravel"],
    fuelBurnKgH: 300,
    approachKt: 100,
    engines: 2,
    vmoKt: 263,
    priceUsd: 8_000_000,
    dryLeaseUsdPerEngineHour: 420,
    wetLeaseUsdPerBlockHour: 1_700,
    match: [["king air"], ["kingair"], ["b350"]],
  },
  {
    key: "atr72f",
    name: "ATR 72-600F",
    category: "regional-turboprop",
    maxPayloadKg: 8_900,
    rangeNm: 900,
    cruiseKt: 275,
    minRunwayFt: 4_500,
    surfaces: ["paved"],
    fuelBurnKgH: 750,
    approachKt: 115,
    engines: 2,
    vmoKt: 250,
    priceUsd: 20_000_000,
    dryLeaseUsdPerEngineHour: 650,
    wetLeaseUsdPerBlockHour: 3_400,
    match: [["atr 72"], ["atr72"], ["atr-72"], ["atr 42"], ["atr42"]],
  },
  {
    key: "dash8-400",
    name: "De Havilland Dash 8-400",
    category: "regional-turboprop",
    maxPayloadKg: 8_000,
    rangeNm: 1_100,
    cruiseKt: 350,
    minRunwayFt: 4_600,
    surfaces: ["paved"],
    fuelBurnKgH: 1_000,
    approachKt: 125,
    engines: 2,
    vmoKt: 286,
    priceUsd: 25_000_000,
    dryLeaseUsdPerEngineHour: 750,
    wetLeaseUsdPerBlockHour: 4_000,
    match: [["dash 8"], ["dash8"], ["dhc-8"], ["q400"]],
  },
  {
    key: "a320p2f",
    name: "Airbus A320P2F",
    category: "narrowbody-jet",
    maxPayloadKg: 20_000,
    rangeNm: 1_800,
    cruiseKt: 450,
    minRunwayFt: 6_500,
    surfaces: ["paved"],
    fuelBurnKgH: 2_500,
    approachKt: 135,
    engines: 2,
    vmoKt: 350,
    priceUsd: 35_000_000,
    dryLeaseUsdPerEngineHour: 1_300,
    wetLeaseUsdPerBlockHour: 8_500,
    match: [["a320"], ["a321"]],
  },
  {
    key: "b738bcf",
    name: "Boeing 737-800BCF",
    category: "narrowbody-jet",
    maxPayloadKg: 23_000,
    rangeNm: 2_000,
    cruiseKt: 450,
    minRunwayFt: 7_000,
    surfaces: ["paved"],
    fuelBurnKgH: 2_500,
    approachKt: 145,
    engines: 2,
    vmoKt: 340,
    priceUsd: 40_000_000,
    dryLeaseUsdPerEngineHour: 1_400,
    wetLeaseUsdPerBlockHour: 9_000,
    match: [["737"], ["b738"]],
  },
  {
    key: "b748f",
    name: "Boeing 747-8F",
    category: "widebody-jet",
    maxPayloadKg: 130_000,
    rangeNm: 4_100,
    cruiseKt: 490,
    minRunwayFt: 10_000,
    surfaces: ["paved"],
    fuelBurnKgH: 10_000,
    approachKt: 160,
    engines: 4,
    vmoKt: 365,
    priceUsd: 180_000_000,
    dryLeaseUsdPerEngineHour: 3_500,
    wetLeaseUsdPerBlockHour: 30_000,
    match: [["747"], ["b748"]],
  },
];

/** Type used when the TITLE matches nothing and no override is set. */
export const DEFAULT_AIRCRAFT_TYPE_KEY = "c208b";

export function aircraftTypeByKey(key: string | null | undefined): AircraftType | null {
  if (!key) return null;
  return AIRCRAFT_TYPES.find((t) => t.key === key) ?? null;
}

/** Case-insensitive keyword match of a sim TITLE against the catalogue; null when none. */
export function matchAircraftType(title: string | null | undefined): AircraftType | null {
  if (!title) return null;
  const lower = title.toLowerCase();
  for (const type of AIRCRAFT_TYPES) {
    if (type.match.some((group) => group.every((kw) => lower.includes(kw)))) return type;
  }
  return null;
}

/** override: manual type; fleet: the selected fleet aircraft (P4); title: TITLE match. */
export const AIRCRAFT_TYPE_SOURCES = ["override", "fleet", "title", "default"] as const;
export type AircraftTypeSource = (typeof AIRCRAFT_TYPE_SOURCES)[number];

/** Resolve the active type: manual override → TITLE match → default. */
export function resolveAircraftType(
  title: string | null | undefined,
  overrideKey: string | null | undefined,
): { type: AircraftType; source: AircraftTypeSource } {
  const override = aircraftTypeByKey(overrideKey);
  if (override) return { type: override, source: "override" };
  const matched = matchAircraftType(title);
  if (matched) return { type: matched, source: "title" };
  const fallback = aircraftTypeByKey(DEFAULT_AIRCRAFT_TYPE_KEY) ?? AIRCRAFT_TYPES[0];
  if (!fallback) throw new Error("empty aircraft catalogue");
  return { type: fallback, source: "default" };
}

/** OurAirports surface code (e.g. "ASP", "CON", "GRVL-DIRT-F", "TURF") → surface class. */
export function surfaceClass(raw: string | null | undefined): SurfaceClass {
  if (!raw) return "unknown";
  const s = raw.toUpperCase();
  const first = s.split(/[-/ ,]/)[0] ?? s;
  const test = (code: string): SurfaceClass | null => {
    if (/^(ASP|ASPH|CON|CONC|PEM|BIT|PAV|PAVED|TAR|MAC|ASFALT|BITUMEN|CEMENT)/.test(code))
      return "paved";
    if (/^(GRV|GRVL|GRAVEL|COP|CORAL|PSP)/.test(code)) return "gravel";
    if (/^(TURF|GRS|GRASS|GRE|GRAS)/.test(code)) return "turf";
    if (/^(DIRT|SAND|CLAY|SOIL|LAT|GND|EARTH|UNPAVED)/.test(code)) return "dirt";
    if (/^(WATER|WAT)/.test(code)) return "water";
    return null;
  };
  return test(first) ?? test(s) ?? "unknown";
}
