// SAMPLE TAFs for the in-browser demo and connector replays. They are examples written for
// this project, not forecasts: every report built here carries origin "sample" and the UI
// labels it SAMPLE. Issue times follow the usual 6-hourly schedule (hh:20Z before 00/06/12/
// 18Z) and the validity runs 24 hours from the next of those hours, so the timeline behaves
// like a real one.

import { hashString } from "./hash";
import type { TafReport } from "./report";
import { parseTaf } from "./taf";

type Change =
  | { kind: "FM"; at: number; body: string }
  | { kind: "BECMG" | "TEMPO" | "PROB30" | "PROB40" | "PROB30 TEMPO"; at: number; to: number; body: string };

interface Template {
  base: string;
  changes: Change[];
}

// Initial conditions agree with the sample METARs (samples.ts) for the same station.
const FIXED: Record<string, Template> = {
  KMEM: {
    base: "20009KT P6SM FEW040 SCT250",
    changes: [
      { kind: "FM", at: 6, body: "22012KT P6SM SCT050" },
      { kind: "TEMPO", at: 9, to: 12, body: "4SM -SHRA BKN030" },
      { kind: "FM", at: 14, body: "18006KT P6SM SCT035 BKN100" },
      { kind: "PROB30", at: 18, to: 22, body: "2SM TSRA BKN015CB" },
    ],
  },
  KATL: {
    base: "24012G20KT 4SM -RA BR BKN015 OVC030",
    changes: [
      { kind: "TEMPO", at: 1, to: 4, body: "2SM RA BR OVC009" },
      { kind: "FM", at: 7, body: "27010KT P6SM BKN040" },
      { kind: "BECMG", at: 12, to: 14, body: "VRB04KT SCT050" },
    ],
  },
  KORD: {
    base: "36008KT 2SM BR OVC008",
    changes: [
      { kind: "BECMG", at: 3, to: 5, body: "5SM BR OVC015" },
      { kind: "FM", at: 9, body: "34010KT P6SM BKN035" },
    ],
  },
  KSEA: {
    base: "00000KT 1/2SM FG VV002",
    changes: [
      { kind: "TEMPO", at: 0, to: 3, body: "1/4SM FG VV001" },
      { kind: "FM", at: 4, body: "VRB03KT 3SM BR OVC006" },
      { kind: "FM", at: 8, body: "18008KT P6SM BKN025" },
      { kind: "FM", at: 16, body: "20010KT P6SM SCT040" },
    ],
  },
  KDFW: {
    base: "17014KT P6SM SCT045 BKN250",
    changes: [
      { kind: "FM", at: 10, body: "18016G24KT P6SM BKN040" },
      { kind: "PROB30 TEMPO", at: 20, to: 24, body: "3SM TSRA OVC020CB" },
    ],
  },
  KJFK: {
    base: "05011KT 6SM HZ BKN028",
    changes: [
      { kind: "FM", at: 5, body: "07012KT P6SM BKN040" },
      { kind: "TEMPO", at: 12, to: 16, body: "3SM BR OVC012" },
    ],
  },
};

const GENERIC: Template[] = [
  {
    base: "27008KT P6SM FEW035",
    changes: [
      { kind: "FM", at: 8, body: "29012KT P6SM SCT040" },
      { kind: "TEMPO", at: 14, to: 18, body: "5SM -SHRA BKN025" },
    ],
  },
  {
    base: "VRB04KT P6SM SCT025 BKN060",
    changes: [
      { kind: "BECMG", at: 4, to: 6, body: "4SM BR BKN012" },
      { kind: "FM", at: 12, body: "31010KT P6SM SCT035" },
    ],
  },
  {
    base: "09006KT 3SM -RA BR OVC009",
    changes: [
      { kind: "TEMPO", at: 0, to: 4, body: "1SM RA BR OVC004" },
      { kind: "FM", at: 7, body: "12008KT P6SM BKN030" },
      { kind: "PROB40", at: 16, to: 20, body: "3SM -RA OVC015" },
    ],
  },
];

export const SAMPLE_TAF_NOTE = "Sample TAF for illustration, not a real forecast";
const HOUR = 3600_000;

/** The sample issue time: the most recent 05:20, 11:20, 17:20 or 23:20Z not after `now`. */
export function sampleTafIssueTime(now: Date): Date {
  const t = new Date(now.getTime());
  t.setUTCSeconds(0, 0);
  for (let back = 0; back < 8; back++) {
    const c = new Date(t.getTime() - back * HOUR);
    c.setUTCMinutes(20);
    if (c.getUTCHours() % 6 === 5 && c.getTime() <= now.getTime()) return c;
  }
  return t;
}

const p2 = (n: number) => String(n).padStart(2, "0");
const ddhh = (d: Date) => `${p2(d.getUTCDate())}${p2(d.getUTCHours())}`;
/** End of a range: 00Z is written as hour 24 of the day before. */
const ddhhEnd = (d: Date) =>
  d.getUTCHours() === 0 ? `${p2(new Date(d.getTime() - HOUR).getUTCDate())}24` : ddhh(d);

/** Raw sample TAF text for `station` at `now`. */
export function sampleTafText(station: string, now: Date): string {
  const tpl = FIXED[station] ?? GENERIC[hashString(station) % GENERIC.length] ?? GENERIC[0];
  const t = tpl as Template;
  const issued = sampleTafIssueTime(now);
  const start = new Date(issued.getTime() + 40 * 60_000); // next 00/06/12/18Z
  const end = new Date(start.getTime() + 24 * HOUR);
  const at = (h: number) => new Date(start.getTime() + h * HOUR);
  const parts = [
    "TAF",
    station,
    `${p2(issued.getUTCDate())}${p2(issued.getUTCHours())}${p2(issued.getUTCMinutes())}Z`,
    `${ddhh(start)}/${ddhhEnd(end)}`,
    t.base,
  ];
  for (const c of t.changes) {
    if (c.kind === "FM") parts.push(`FM${ddhh(at(c.at))}00 ${c.body}`);
    else parts.push(`${c.kind} ${ddhh(at(c.at))}/${ddhhEnd(at(c.to))} ${c.body}`);
  }
  return parts.join(" ");
}

/** A decoded SAMPLE TAF (our parser on the sample text). */
export function sampleTaf(station: string, now: Date = new Date()): TafReport | null {
  const rawText = sampleTafText(station, now);
  const decoded = parseTaf(rawText, now);
  if (!decoded) return null;
  return {
    ...decoded,
    origin: "sample",
    rawText,
    decodedBy: "parser",
    fetchedAt: now.toISOString(),
    stale: false,
  };
}
