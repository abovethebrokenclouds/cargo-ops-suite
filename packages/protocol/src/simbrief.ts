import { z } from "zod";

// P6 (optional, OFF by default): import the player's latest SimBrief OFP as a "planned
// flight" the job board can match. The connector fetches it from SimBrief's public fetch
// endpoint with the player's OWN username or pilot ID (no key, no OAuth); the browser
// never talks to simbrief.com. Endpoint and field names follow the publicly documented
// format (developers.navigraph.com/docs/simbrief); this environment could not reach those
// hosts, so the mapping is tested against a HAND-MADE sample and stays unverified until a
// real OFP is fetched on the PC (docs/VERIFICATION.md).

/** Documented fetch endpoint; `json=1` selects JSON instead of XML. */
export const SIMBRIEF_FETCH_URL = "https://www.simbrief.com/api/xml.fetcher.php";

/** Settings kept in the connector's settings table (never in the repository). */
export const simbriefSettingsSchema = z.object({
  enabled: z.boolean(),
  /** SimBrief username (alias). */
  username: z.string().nullable(),
  /** SimBrief pilot ID (numeric); preferred over the username when both are set. */
  userId: z.string().nullable(),
});
export type SimbriefSettings = z.infer<typeof simbriefSettingsSchema>;

export const DEFAULT_SIMBRIEF_SETTINGS: SimbriefSettings = {
  enabled: false,
  username: null,
  userId: null,
};

/** What a settings update may contain. Usernames are SimBrief aliases: letters, digits, _ . - */
export const simbriefSettingsUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    username: z
      .string()
      .trim()
      .max(64)
      .regex(/^[A-Za-z0-9_.-]*$/, "letters, digits, _ . - only")
      .nullable()
      .optional(),
    userId: z.string().trim().max(12).regex(/^\d*$/, "digits only").nullable().optional(),
  })
  .strict();
export type SimbriefSettingsUpdate = z.infer<typeof simbriefSettingsUpdateSchema>;

/** The planned flight derived from an OFP. Weights in kg whatever the OFP's units. */
export const plannedFlightSchema = z.object({
  source: z.literal("simbrief"),
  origin: z.string().min(2).max(8),
  destination: z.string().min(2).max(8),
  alternate: z.string().nullable(),
  /** ATC route string as planned (may be empty for a direct flight). */
  route: z.string(),
  aircraftIcao: z.string().nullable(),
  aircraftName: z.string().nullable(),
  registration: z.string().nullable(),
  flightNumber: z.string().nullable(),
  plannedFuelKg: z.number().finite().nonnegative().nullable(),
  payloadKg: z.number().finite().nonnegative().nullable(),
  distanceNm: z.number().finite().nonnegative().nullable(),
  eteMin: z.number().finite().nonnegative().nullable(),
  /** Units the OFP was planned in. */
  units: z.enum(["kg", "lb"]).nullable(),
  /** When SimBrief generated the OFP (ISO), if stated. */
  generatedAt: z.string().nullable(),
  requestId: z.string().nullable(),
  /** When the connector fetched it (ISO). */
  fetchedAt: z.string(),
});
export type PlannedFlight = z.infer<typeof plannedFlightSchema>;

const LB_TO_KG = 0.45359237;

// Every OFP value arrives as a string (or occasionally a number); objects may be missing.
const str = z.union([z.string(), z.number()]).transform((v) => String(v).trim());
const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape).partial().passthrough();

const ofpSchema = loose({
  fetch: loose({ status: str }),
  params: loose({ request_id: str, time_generated: str, units: str }),
  general: loose({
    icao_airline: str,
    flight_number: str,
    route: str,
    air_distance: str,
    route_distance: str,
  }),
  origin: loose({ icao_code: str }),
  destination: loose({ icao_code: str }),
  alternate: loose({ icao_code: str }),
  aircraft: loose({ icaocode: str, icao_code: str, name: str, reg: str }),
  fuel: loose({ plan_ramp: str }),
  weights: loose({ payload: str, cargo: str }),
  times: loose({ est_time_enroute: str }),
});

export type SimbriefMapResult =
  | { ok: true; plan: PlannedFlight }
  | { ok: false; code: "simbrief_error" | "simbrief_invalid"; message: string };

function num(v: string | undefined): number | null {
  if (v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function text(v: string | undefined): string | null {
  return v === undefined || v === "" ? null : v;
}

const ICAO = /^[A-Z0-9]{2,8}$/;

/** Map a SimBrief OFP JSON document to a planned flight (pure; `fetchedAt` is ISO). */
export function mapSimbriefOfp(raw: unknown, fetchedAt: string): SimbriefMapResult {
  const parsed = ofpSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, code: "simbrief_invalid", message: "Not a SimBrief OFP document" };
  }
  const o = parsed.data;
  const status = o.fetch?.status;
  if (status !== undefined && status.toLowerCase() !== "success") {
    // SimBrief reports problems (unknown user, no OFP yet) in fetch.status.
    return { ok: false, code: "simbrief_error", message: status.slice(0, 200) };
  }
  const origin = o.origin?.icao_code?.toUpperCase();
  const destination = o.destination?.icao_code?.toUpperCase();
  if (!origin || !destination || !ICAO.test(origin) || !ICAO.test(destination)) {
    return {
      ok: false,
      code: "simbrief_invalid",
      message: "The OFP has no origin/destination ICAO codes",
    };
  }
  const unitsRaw = o.params?.units?.toLowerCase();
  const units = unitsRaw?.startsWith("lb") ? "lb" : unitsRaw?.startsWith("kg") ? "kg" : null;
  // No units stated: treat as pounds (assumption, unverified; real OFPs state params.units).
  const toKg = (v: number | null) =>
    v === null ? null : Math.round((units === "kg" ? v : v * LB_TO_KG) * 10) / 10;
  const payload = num(o.weights?.payload) ?? num(o.weights?.cargo);
  const generatedSec = num(o.params?.time_generated);
  const eteSec = num(o.times?.est_time_enroute);
  const airline = text(o.general?.icao_airline);
  const flightNo = text(o.general?.flight_number);
  const alternate = o.alternate?.icao_code?.toUpperCase() ?? null;
  const plan: PlannedFlight = {
    source: "simbrief",
    origin,
    destination,
    alternate: alternate && ICAO.test(alternate) ? alternate : null,
    route: (o.general?.route ?? "").slice(0, 2_000),
    aircraftIcao: text(o.aircraft?.icaocode ?? o.aircraft?.icao_code),
    aircraftName: text(o.aircraft?.name),
    registration: text(o.aircraft?.reg),
    flightNumber: flightNo ? `${airline ?? ""}${flightNo}` : null,
    plannedFuelKg: toKg(num(o.fuel?.plan_ramp)),
    payloadKg: toKg(payload),
    distanceNm: num(o.general?.route_distance) ?? num(o.general?.air_distance),
    eteMin: eteSec === null ? null : Math.round(eteSec / 60),
    units,
    generatedAt: generatedSec === null ? null : new Date(generatedSec * 1000).toISOString(),
    requestId: text(o.params?.request_id),
    fetchedAt,
  };
  return { ok: true, plan };
}

/** The fetch URL for the player's own account (user ID preferred). Null when neither is set. */
export function simbriefFetchUrl(settings: SimbriefSettings): string | null {
  const url = new URL(SIMBRIEF_FETCH_URL);
  if (settings.userId) url.searchParams.set("userid", settings.userId);
  else if (settings.username) url.searchParams.set("username", settings.username);
  else return null;
  url.searchParams.set("json", "1");
  return url.toString();
}
