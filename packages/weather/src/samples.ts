// SAMPLE METARs for the in-browser demo and connector replays. They are examples written
// for this project, not observations: every report built here carries origin "sample" and
// the UI labels it SAMPLE. The observation time is placed at the last :53 past the hour
// so the age readout behaves like a real report.

import { hashString } from "./hash";
import { parseMetar } from "./metar";
import type { MetarReport } from "./report";

/** Body after "<station> <DDHHMMZ> " for a few demo stations, one per flight category. */
const FIXED: Record<string, string> = {
  KMEM: "20009KT 10SM FEW040 SCT250 28/19 A2993",
  KATL: "24012G20KT 4SM -RA BR BKN015 OVC030 21/18 A2985",
  KORD: "36008KT 2SM BR OVC008 12/11 A3001",
  KSEA: "00000KT 1/2SM FG VV002 09/09 A3012",
  KDFW: "17014KT 10SM SCT045 BKN250 31/18 A2990",
  KJFK: "05011KT 6SM HZ BKN028 19/14 A3008",
};

/** Bodies for any other station, picked deterministically from the station id. */
const GENERIC = [
  "27008KT 10SM FEW035 22/12 A3002",
  "VRB04KT 7SM SCT025 BKN060 18/13 A2997",
  "31015G24KT 5SM BR BKN022 15/11 A2984",
  "09006KT 2 1/2SM -RA BR OVC009 13/12 A2979",
  "21010KT P6SM SKC 25/09 A3005",
];

export const SAMPLE_NOTE = "Sample METAR for demonstration, not real weather";

/** The sample observation time: the most recent hh:53Z not after `now`. */
export function sampleObservationTime(now: Date): Date {
  const t = new Date(now.getTime());
  t.setUTCSeconds(0, 0);
  if (t.getUTCMinutes() < 53) t.setUTCHours(t.getUTCHours() - 1);
  t.setUTCMinutes(53);
  return t;
}

function dayTimeGroup(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
}

/** Raw sample METAR text for `station` at `now`. */
export function sampleMetarText(station: string, now: Date): string {
  const body = FIXED[station] ?? GENERIC[hashString(station) % GENERIC.length] ?? GENERIC[0];
  return `${station} ${dayTimeGroup(sampleObservationTime(now))} ${body}`;
}

/** A decoded SAMPLE report (our parser on the sample text). */
export function sampleMetar(station: string, now: Date = new Date()): MetarReport | null {
  const rawText = sampleMetarText(station, now);
  const decoded = parseMetar(rawText, now);
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
