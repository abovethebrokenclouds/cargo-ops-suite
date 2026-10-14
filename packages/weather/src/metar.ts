// Small METAR decoder: station, observation time, wind, visibility, sky, temperature,
// altimeter and the FAA flight category. Pure, no dependencies; shared by the connector
// (fallback when the aviationweather.gov JSON lacks a decoded field) and the browser
// (demo-mode sample METARs). Remarks (RMK …) are ignored.

export const FLIGHT_CATEGORIES = ["VFR", "MVFR", "IFR", "LIFR"] as const;
export type FlightCategory = (typeof FLIGHT_CATEGORIES)[number];

export const CLOUD_COVERS = ["FEW", "SCT", "BKN", "OVC", "OVX", "VV"] as const;
export type CloudCover = (typeof CLOUD_COVERS)[number];

export interface CloudLayer {
  cover: CloudCover;
  /** Base above ground level, feet; null when not reported (`///`). */
  baseFt: number | null;
}

export interface Wind {
  /** True direction, degrees; null when variable (VRB). 0 with speed 0 is calm. */
  directionDeg: number | null;
  speedKt: number;
  gustKt: number | null;
  /** Direction varying between two headings (`250V310`). */
  varyingFromDeg: number | null;
  varyingToDeg: number | null;
}

export interface MetarDecoded {
  station: string;
  /** Observation time, ISO 8601 UTC; null when it could not be read. */
  observedAt: string | null;
  wind: Wind | null;
  /** Prevailing visibility, statute miles; null when not reported. */
  visibilitySm: number | null;
  /** Visibility is "more than" the value (P6SM, 9999, CAVOK, "10+"). */
  visibilityPlus: boolean;
  /** Cloud layers; [] for clear (CLR/SKC/NSC/NCD/CAVOK); null when the sky is not reported. */
  clouds: CloudLayer[] | null;
  /** Lowest BKN/OVC/OVX layer or vertical visibility, feet AGL; null = no ceiling or unknown. */
  ceilingFt: number | null;
  tempC: number | null;
  dewpointC: number | null;
  altimeterHpa: number | null;
  /** Present weather groups as written (`-RA BR`); null when none. */
  weather: string | null;
  category: FlightCategory | null;
}

const KMH_TO_KT = 0.539957;
const MPS_TO_KT = 1.943844;
const METRES_PER_SM = 1609.344;
const HPA_PER_INHG = 33.8639;

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Parse a visibility fraction or mixed number ("1/2", "1 1/2", "3"). */
export function parseFraction(text: string): number | null {
  const t = text.trim();
  const mixed = /^(\d+)\s+(\d+)\/(\d+)$/.exec(t);
  if (mixed) {
    const den = Number(mixed[3]);
    return den > 0 ? Number(mixed[1]) + Number(mixed[2]) / den : null;
  }
  const frac = /^(\d+)\/(\d+)$/.exec(t);
  if (frac) {
    const den = Number(frac[2]);
    return den > 0 ? Number(frac[1]) / den : null;
  }
  if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
  return null;
}

/** Lowest broken/overcast layer (or vertical visibility), feet AGL. */
export function ceilingOf(clouds: readonly CloudLayer[] | null): number | null {
  if (!clouds) return null;
  let lowest: number | null = null;
  for (const c of clouds) {
    if (c.cover === "BKN" || c.cover === "OVC" || c.cover === "OVX" || c.cover === "VV") {
      if (c.baseFt !== null && (lowest === null || c.baseFt < lowest)) lowest = c.baseFt;
    }
  }
  return lowest;
}

const RANK: Record<FlightCategory, number> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

/**
 * FAA flight category (AIM 7-1-7 / aviationweather.gov):
 * LIFR ceiling < 500 ft or visibility < 1 SM; IFR ceiling 500 to < 1,000 ft or visibility
 * 1 to < 3 SM; MVFR ceiling 1,000 to 3,000 ft or visibility 3 to 5 SM; VFR otherwise.
 * `ceilingFt` null means no ceiling; `skyKnown` false means the sky was not reported.
 * Null when neither visibility nor sky is known.
 */
export function flightCategory(
  visibilitySm: number | null,
  ceilingFt: number | null,
  skyKnown = true,
): FlightCategory | null {
  if (visibilitySm === null && !skyKnown) return null;
  let worst: FlightCategory = "VFR";
  const take = (c: FlightCategory) => {
    if (RANK[c] > RANK[worst]) worst = c;
  };
  if (visibilitySm !== null) {
    take(visibilitySm < 1 ? "LIFR" : visibilitySm < 3 ? "IFR" : visibilitySm <= 5 ? "MVFR" : "VFR");
  }
  if (skyKnown && ceilingFt !== null) {
    take(ceilingFt < 500 ? "LIFR" : ceilingFt < 1000 ? "IFR" : ceilingFt <= 3000 ? "MVFR" : "VFR");
  }
  return worst;
}

export function isFlightCategory(v: unknown): v is FlightCategory {
  return typeof v === "string" && (FLIGHT_CATEGORIES as readonly string[]).includes(v);
}

/**
 * Resolve a METAR `DDHHMMZ` group against a reference time: the latest such moment that is
 * not more than a day after `ref` (so reports from the end of last month resolve correctly).
 */
export function resolveDayTime(day: number, hour: number, minute: number, ref: Date): Date | null {
  if (day < 1 || day > 31 || hour > 23 || minute > 59) return null;
  for (let back = 0; back < 3; back++) {
    const y = ref.getUTCFullYear();
    const m = ref.getUTCMonth() - back;
    const d = new Date(Date.UTC(y, m, day, hour, minute));
    // Day overflowed the month (e.g. 31 in a 30-day month): try the month before.
    if (d.getUTCDate() !== day) continue;
    if (d.getTime() <= ref.getTime() + 24 * 3600_000) return d;
  }
  return null;
}

const WX_RE =
  /^(?:-|\+|VC)?(?:MI|PR|BC|DR|BL|SH|TS|FZ)?(?:DZ|RA|SN|SG|IC|PL|GR|GS|UP|BR|FG|FU|VA|DU|SA|HZ|PY|PO|SQ|FC|SS|DS)*$/;

function isWeatherGroup(tok: string): boolean {
  if (tok.length < 2 || !WX_RE.test(tok)) return false;
  // Must carry a phenomenon or a descriptor such as TS/SH on its own.
  return /[A-Z]{2}/.test(tok.replace(/^(-|\+|VC)/, ""));
}

/** Decode a raw METAR/SPECI. `ref` dates the DDHHMMZ group (default: now). */
export function parseMetar(raw: string, ref: Date = new Date()): MetarDecoded | null {
  const all = raw.trim().replace(/=$/, "").split(/\s+/);
  const rmk = all.indexOf("RMK");
  const tokens = rmk >= 0 ? all.slice(0, rmk) : all;
  let i = 0;
  while (i < tokens.length && /^(METAR|SPECI)$/.test(tokens[i] ?? "")) i++;
  const station = tokens[i];
  if (!station || !/^[A-Z][A-Z0-9]{3}$/.test(station)) return null;
  i++;

  const out: MetarDecoded = {
    station,
    observedAt: null,
    wind: null,
    visibilitySm: null,
    visibilityPlus: false,
    clouds: null,
    ceilingFt: null,
    tempC: null,
    dewpointC: null,
    altimeterHpa: null,
    weather: null,
    category: null,
  };
  const wx: string[] = [];
  const clouds: CloudLayer[] = [];
  let skyReported = false;

  for (; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    let m: RegExpExecArray | null;
    if (tok === "COR" || tok === "AUTO" || tok === "NIL") continue;
    if ((m = /^(\d{2})(\d{2})(\d{2})Z$/.exec(tok))) {
      const d = resolveDayTime(Number(m[1]), Number(m[2]), Number(m[3]), ref);
      out.observedAt = d ? d.toISOString() : null;
      continue;
    }
    if ((m = /^(\d{3}|VRB)(\d{2,3})(?:G(\d{2,3}))?(KT|MPS|KMH)$/.exec(tok))) {
      const k = m[4] === "KT" ? 1 : m[4] === "MPS" ? MPS_TO_KT : KMH_TO_KT;
      out.wind = {
        directionDeg: m[1] === "VRB" ? null : Number(m[1]),
        speedKt: Math.round(Number(m[2]) * k),
        gustKt: m[3] ? Math.round(Number(m[3]) * k) : null,
        varyingFromDeg: null,
        varyingToDeg: null,
      };
      continue;
    }
    if ((m = /^(\d{3})V(\d{3})$/.exec(tok)) && out.wind) {
      out.wind.varyingFromDeg = Number(m[1]);
      out.wind.varyingToDeg = Number(m[2]);
      continue;
    }
    if (tok === "CAVOK") {
      out.visibilitySm = round1(10_000 / METRES_PER_SM);
      out.visibilityPlus = true;
      skyReported = true;
      continue;
    }
    // Statute miles, possibly split over two tokens: "1 1/2SM".
    const next = tokens[i + 1];
    if (/^\d+$/.test(tok) && tok.length <= 2 && next && /^\d\/\d+SM$/.test(next)) {
      const v = parseFraction(`${tok} ${next.slice(0, -2)}`);
      if (v !== null) out.visibilitySm = round1(v);
      i++;
      continue;
    }
    if ((m = /^([PM])?(\d+(?:\/\d+)?)SM$/.exec(tok))) {
      const v = parseFraction(m[2] as string);
      if (v !== null) {
        out.visibilitySm = m[1] === "M" ? Math.min(v, 0.25) : Math.round(v * 100) / 100;
        out.visibilityPlus = m[1] === "P";
      }
      continue;
    }
    if ((m = /^(\d{4})(NDV)?$/.exec(tok)) && out.visibilitySm === null && !skyReported) {
      const metres = Number(m[1]);
      out.visibilitySm =
        metres >= 9999 ? round1(10_000 / METRES_PER_SM) : round1(metres / METRES_PER_SM);
      out.visibilityPlus = metres >= 9999;
      continue;
    }
    if (/^R\d{2}[LCR]?\//.test(tok)) continue; // runway visual range
    if ((m = /^(FEW|SCT|BKN|OVC|VV)(\d{3}|\/\/\/)(CB|TCU|\/\/\/)?$/.exec(tok))) {
      skyReported = true;
      clouds.push({
        cover: m[1] as CloudCover,
        baseFt: m[2] === "///" ? null : Number(m[2]) * 100,
      });
      continue;
    }
    if (/^(CLR|SKC|NSC|NCD)$/.test(tok)) {
      skyReported = true;
      continue;
    }
    if ((m = /^(M?\d{2})\/(M?\d{2})?$/.exec(tok))) {
      const t = (s: string) => (s.startsWith("M") ? -Number(s.slice(1)) : Number(s));
      out.tempC = t(m[1] as string);
      out.dewpointC = m[2] ? t(m[2]) : null;
      continue;
    }
    if ((m = /^A(\d{4})$/.exec(tok))) {
      out.altimeterHpa = round1((Number(m[1]) / 100) * HPA_PER_INHG);
      continue;
    }
    if ((m = /^Q(\d{4})$/.exec(tok))) {
      out.altimeterHpa = Number(m[1]);
      continue;
    }
    if (isWeatherGroup(tok)) wx.push(tok);
  }

  out.clouds = skyReported ? clouds : null;
  out.ceilingFt = ceilingOf(out.clouds);
  out.weather = wx.length ? wx.join(" ") : null;
  out.category = flightCategory(out.visibilitySm, out.ceilingFt, out.clouds !== null);
  return out;
}

/** hPa → inches of mercury, two decimals. */
export function hpaToInHg(hpa: number): number {
  return Math.round((hpa / HPA_PER_INHG) * 100) / 100;
}
