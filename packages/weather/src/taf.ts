// Small TAF decoder: header (station, issue time, validity) and forecast periods. Pure, no
// dependencies; shared by the connector (live TAFs from aviationweather.gov) and the browser
// (demo SAMPLE TAFs).
//
// Periods:
//   BASE   the initial forecast, from the start of validity to the first FM group
//   FM     "from": replaces all conditions, until the next FM group or the end of validity
//   BECMG  conditions changing gradually during the window; they then persist until the
//          next FM group (we treat them as in force from the start of the window)
//   TEMPO  temporary fluctuations within the window
//   PROB   PROB30/PROB40, optionally "PROB30 TEMPO", within the window
//
// The weather groups of a period (wind, visibility, weather, sky) are decoded with the METAR
// parser. A change group (BECMG/TEMPO/PROB) usually lists only what changes, so its flight
// category is computed from its own groups merged over the prevailing conditions at its
// start. Wind shear (WS), temperature (TX/TN), QNH and remarks are ignored.

import {
  ceilingOf,
  flightCategory,
  parseMetar,
  type CloudLayer,
  type FlightCategory,
  type Wind,
} from "./metar";

export const TAF_PERIOD_KINDS = ["BASE", "FM", "BECMG", "TEMPO", "PROB"] as const;
export type TafPeriodKind = (typeof TAF_PERIOD_KINDS)[number];

export interface TafConditions {
  wind: Wind | null;
  /** Statute miles; null when the period does not state visibility. */
  visibilitySm: number | null;
  visibilityPlus: boolean;
  /** Sky layers; [] for clear (SKC/NSC/CAVOK); null when the period does not state the sky. */
  clouds: CloudLayer[] | null;
  ceilingFt: number | null;
  /** Present weather groups as written; null when none stated (NSW also gives null). */
  weather: string | null;
}

export interface TafPeriod extends TafConditions {
  kind: TafPeriodKind;
  /** 30 or 40 for PROB groups, else null. */
  probability: number | null;
  /** "PROB30 TEMPO": a temporary fluctuation with a probability. */
  tempo: boolean;
  /** Start and end of the period, ISO 8601 UTC. */
  from: string;
  to: string;
  /** Category of the conditions during the period (change groups merged over the prevailing). */
  category: FlightCategory | null;
  /** The period's groups as written, e.g. "TEMPO 1320/1324 2SM -RA BR OVC008". */
  text: string;
}

export interface TafDecoded {
  station: string;
  /** Issue time, ISO 8601 UTC; null when it could not be read. */
  issuedAt: string | null;
  validFrom: string | null;
  validTo: string | null;
  amended: boolean;
  corrected: boolean;
  /** NIL or CNL TAF: no forecast. */
  cancelled: boolean;
  periods: TafPeriod[];
}

const HOUR = 3600_000;

/**
 * Resolve a TAF day/hour(/minute) against an anchor (the issue time): the candidate in the
 * anchor's month or a neighbouring one closest to the anchor. Hour 24 means 00 of the next
 * day. Null when no candidate lies within 20 days.
 */
export function resolveTafTime(
  day: number,
  hour: number,
  minute: number,
  anchor: Date,
): Date | null {
  if (day < 1 || day > 31 || hour > 24 || minute > 59 || (hour === 24 && minute !== 0)) {
    return null;
  }
  let best: Date | null = null;
  for (const off of [-1, 0, 1]) {
    const y = anchor.getUTCFullYear();
    const m = anchor.getUTCMonth() + off;
    const probe = new Date(Date.UTC(y, m, day));
    if (probe.getUTCDate() !== day) continue; // day overflowed the month
    const t = new Date(probe.getTime() + hour * HOUR + minute * 60_000);
    if (
      !best ||
      Math.abs(t.getTime() - anchor.getTime()) < Math.abs(best.getTime() - anchor.getTime())
    ) {
      best = t;
    }
  }
  if (!best || Math.abs(best.getTime() - anchor.getTime()) > 20 * 24 * HOUR) return null;
  return best;
}

const ISSUE_RE = /^(\d{2})(\d{2})(\d{2})Z$/;
const RANGE_RE = /^(\d{2})(\d{2})\/(\d{2})(\d{2})$/;
const FM_RE = /^FM(\d{2})(\d{2})(\d{2})$/;
const PROB_RE = /^PROB(\d{2})$/;

function range(tok: string | undefined, anchor: Date): { from: Date; to: Date } | null {
  const m = RANGE_RE.exec(tok ?? "");
  if (!m) return null;
  const from = resolveTafTime(Number(m[1]), Number(m[2]), 0, anchor);
  const to = from ? resolveTafTime(Number(m[3]), Number(m[4]), 0, from) : null;
  if (!from || !to || to.getTime() < from.getTime()) return null;
  return { from, to };
}

/** Decode the weather groups of one period with the METAR parser. */
function conditions(station: string, tokens: string[], ref: Date): TafConditions {
  const kept = tokens.filter(
    (t) => !/^(TX|TN)M?\d{2}\/\d{4}Z$/.test(t) && !/^WS\d{3}\//.test(t) && !/^QNH/.test(t),
  );
  const d = parseMetar(`${station} ${kept.join(" ")}`, ref);
  return {
    wind: d?.wind ?? null,
    visibilitySm: d?.visibilitySm ?? null,
    visibilityPlus: d?.visibilityPlus ?? false,
    clouds: d?.clouds ?? null,
    ceilingFt: d?.ceilingFt ?? null,
    weather: kept.includes("NSW") ? null : (d?.weather ?? null),
  };
}

/** `over` stated groups replace those of `base`; unstated ones are inherited. */
export function mergeConditions(base: TafConditions | null, over: TafConditions): TafConditions {
  const visibilityStated = over.visibilitySm !== null;
  const clouds = over.clouds ?? base?.clouds ?? null;
  return {
    wind: over.wind ?? base?.wind ?? null,
    visibilitySm: visibilityStated ? over.visibilitySm : (base?.visibilitySm ?? null),
    visibilityPlus: visibilityStated ? over.visibilityPlus : (base?.visibilityPlus ?? false),
    clouds,
    ceilingFt: ceilingOf(clouds),
    weather: over.weather ?? base?.weather ?? null,
  };
}

function categoryOf(c: TafConditions): FlightCategory | null {
  return flightCategory(c.visibilitySm, c.ceilingFt, c.clouds !== null);
}

interface Segment {
  kind: TafPeriodKind;
  probability: number | null;
  tempo: boolean;
  from: Date | null;
  to: Date | null;
  head: string[];
  body: string[];
}

/** Decode a raw TAF. `ref` dates the issue time (default: now). Null when not a TAF. */
export function parseTaf(raw: string, ref: Date = new Date()): TafDecoded | null {
  const all = raw.trim().replace(/=$/, "").split(/\s+/).filter(Boolean);
  const rmk = all.indexOf("RMK");
  const tokens = rmk >= 0 ? all.slice(0, rmk) : all;
  let i = 0;
  let amended = false;
  let corrected = false;
  while (i < tokens.length && /^(TAF|AMD|COR|RTD)$/.test(tokens[i] ?? "")) {
    if (tokens[i] === "AMD") amended = true;
    if (tokens[i] === "COR") corrected = true;
    i++;
  }
  const station = tokens[i];
  if (!station || !/^[A-Z][A-Z0-9]{3}$/.test(station)) return null;
  i++;

  let issued: Date | null = null;
  const im = ISSUE_RE.exec(tokens[i] ?? "");
  if (im) {
    issued = resolveTafTime(Number(im[1]), Number(im[2]), Number(im[3]), ref);
    i++;
  }
  const anchor = issued ?? ref;
  const validity = range(tokens[i], anchor);
  if (validity) i++;

  const out: TafDecoded = {
    station,
    issuedAt: issued ? issued.toISOString() : null,
    validFrom: validity ? validity.from.toISOString() : null,
    validTo: validity ? validity.to.toISOString() : null,
    amended,
    corrected,
    cancelled: false,
    periods: [],
  };
  if (tokens.slice(i).some((t) => t === "NIL" || t === "CNL")) {
    out.cancelled = true;
    return out;
  }

  // Split into segments at change indicators.
  const segments: Segment[] = [];
  let cur: Segment = {
    kind: "BASE",
    probability: null,
    tempo: false,
    from: validity?.from ?? null,
    to: null,
    head: [],
    body: [],
  };
  const push = () => {
    if (cur.kind === "BASE" && cur.body.length === 0) return;
    segments.push(cur);
  };
  for (; i < tokens.length; i++) {
    const tok = tokens[i] as string;
    let m: RegExpExecArray | null;
    if ((m = FM_RE.exec(tok))) {
      push();
      const from = resolveTafTime(Number(m[1]), Number(m[2]), Number(m[3]), anchor);
      cur = { kind: "FM", probability: null, tempo: false, from, to: null, head: [tok], body: [] };
      continue;
    }
    if (tok === "BECMG" || tok === "TEMPO" || PROB_RE.test(tok)) {
      push();
      const head = [tok];
      let probability: number | null = null;
      let tempo = tok === "TEMPO";
      const kind: TafPeriodKind = tok === "BECMG" ? "BECMG" : tok === "TEMPO" ? "TEMPO" : "PROB";
      if (kind === "PROB") {
        probability = Number(PROB_RE.exec(tok)?.[1]);
        if (tokens[i + 1] === "TEMPO") {
          tempo = true;
          head.push("TEMPO");
          i++;
        }
      }
      const r = range(tokens[i + 1], anchor);
      if (r) {
        head.push(tokens[i + 1] as string);
        i++;
      }
      cur = {
        kind,
        probability,
        tempo,
        from: r?.from ?? null,
        to: r?.to ?? null,
        head,
        body: [],
      };
      continue;
    }
    cur.body.push(tok);
  }
  push();

  const end = validity?.to ?? null;
  // Prevailing segments (BASE/FM) end where the next one begins.
  const prevailing = segments.filter((s) => s.kind === "BASE" || s.kind === "FM");
  prevailing.forEach((s, n) => {
    s.to = prevailing[n + 1]?.from ?? end;
  });

  const ref2 = issued ?? ref;
  const decoded = segments
    .filter((s) => s.from && s.to)
    .map((s) => ({ seg: s, cond: conditions(station, s.body, ref2) }));

  const prevailingAt = (t: number): TafConditions | null => {
    let base: TafConditions | null = null;
    let segFrom = -Infinity;
    for (const d of decoded) {
      const k = d.seg.kind;
      if ((k === "BASE" || k === "FM") && (d.seg.from as Date).getTime() <= t) {
        base = d.cond;
        segFrom = (d.seg.from as Date).getTime();
      }
    }
    // BECMG changes inside the current prevailing segment that began before t.
    for (const d of decoded) {
      if (d.seg.kind !== "BECMG") continue;
      const f = (d.seg.from as Date).getTime();
      if (f >= segFrom && f < t) base = mergeConditions(base, d.cond);
    }
    return base;
  };

  for (const { seg, cond } of decoded) {
    const isChange = seg.kind !== "BASE" && seg.kind !== "FM";
    const merged = isChange
      ? mergeConditions(prevailingAt((seg.from as Date).getTime()), cond)
      : cond;
    out.periods.push({
      kind: seg.kind,
      probability: seg.probability,
      tempo: seg.tempo,
      from: (seg.from as Date).toISOString(),
      to: (seg.to as Date).toISOString(),
      ...merged,
      category: categoryOf(merged),
      text: [...seg.head, ...seg.body].join(" "),
    });
  }
  return out;
}

const RANK: Record<FlightCategory, number> = { VFR: 0, MVFR: 1, IFR: 2, LIFR: 3 };

export function worseCategory(
  a: FlightCategory | null,
  b: FlightCategory | null,
): FlightCategory | null {
  if (a === null) return b;
  if (b === null) return a;
  return RANK[b] > RANK[a] ? b : a;
}

export interface TafAt {
  /** Prevailing period (BASE/FM) at the time, or null outside the validity. */
  prevailing: TafPeriod | null;
  /** Category of the prevailing conditions, BECMG changes applied. */
  category: FlightCategory | null;
  /** TEMPO/PROB periods covering the time. */
  changes: TafPeriod[];
  /** Worst of the prevailing category and the covering TEMPO/PROB periods. */
  worst: FlightCategory | null;
}

/** What the TAF forecasts at time `t` (ms). */
export function tafAt(taf: TafDecoded, t: number): TafAt {
  const within = (p: TafPeriod) => Date.parse(p.from) <= t && t < Date.parse(p.to);
  const prevailing =
    taf.periods.find((p) => (p.kind === "BASE" || p.kind === "FM") && within(p)) ?? null;
  let category = prevailing?.category ?? null;
  if (prevailing) {
    // The latest BECMG in this prevailing segment that has started carries the merged state.
    const becmg = taf.periods.filter(
      (p) =>
        p.kind === "BECMG" &&
        Date.parse(p.from) >= Date.parse(prevailing.from) &&
        Date.parse(p.from) <= t,
    );
    const last = becmg[becmg.length - 1];
    if (last) category = last.category;
  }
  const changes = taf.periods.filter((p) => (p.kind === "TEMPO" || p.kind === "PROB") && within(p));
  let worst = category;
  for (const c of changes) worst = worseCategory(worst, c.category);
  return { prevailing, category, changes, worst };
}

/** The TAF's validity has ended at `now` (ms). */
export function isTafExpired(taf: Pick<TafDecoded, "validTo">, now: number): boolean {
  if (!taf.validTo) return false;
  const t = Date.parse(taf.validTo);
  return Number.isFinite(t) && t <= now;
}

/** "13/18Z" for an ISO time (day/hour UTC, TAF style). */
export function formatTafTime(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n: number) => String(n).padStart(2, "0");
  const min = d.getUTCMinutes();
  return `${p(d.getUTCDate())}/${p(d.getUTCHours())}${min ? p(min) : ""}Z`;
}

/** Short label for a period: "FM", "TEMPO", "BECMG", "PROB30", "PROB30 TEMPO", "Initial". */
export function tafPeriodLabel(p: Pick<TafPeriod, "kind" | "probability" | "tempo">): string {
  if (p.kind === "BASE") return "Initial";
  if (p.kind === "PROB") return `PROB${p.probability ?? ""}${p.tempo ? " TEMPO" : ""}`;
  return p.kind;
}
