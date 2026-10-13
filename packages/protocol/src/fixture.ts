import { parseServerMessage, type ServerMessage } from "./messages";

/** One JSONL fixture line: a server message and when it was sent, ms since recording start. */
export interface FixtureFrame {
  t: number;
  msg: ServerMessage;
}

export type FixtureParseResult =
  { ok: true; frames: FixtureFrame[] } | { ok: false; error: string };

/**
 * Parse a JSONL fixture. Blank lines are skipped; any invalid line fails the whole
 * fixture (with its 1-based line number) so a bad recording never replays partially.
 * `t` must be a non-negative number and must not go backwards.
 */
export function parseFixture(text: string): FixtureParseResult {
  const frames: FixtureFrame[] = [];
  const lines = text.split(/\r?\n/);
  let lastT = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] ?? "").trim();
    if (!line) continue;
    const at = `line ${i + 1}`;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return { ok: false, error: `${at}: invalid JSON` };
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { ok: false, error: `${at}: expected an object with t and msg` };
    }
    const record = value as Record<string, unknown>;
    const t = record["t"];
    if (typeof t !== "number" || !Number.isFinite(t) || t < 0) {
      return { ok: false, error: `${at}: t must be a non-negative number` };
    }
    if (t < lastT) return { ok: false, error: `${at}: t went backwards (${t} < ${lastT})` };
    const parsed = parseServerMessage(record["msg"]);
    if (!parsed.ok) return { ok: false, error: `${at}: ${parsed.error}` };
    frames.push({ t, msg: parsed.msg });
    lastT = t;
  }
  return { ok: true, frames };
}

export function encodeFixtureLine(frame: FixtureFrame): string {
  return JSON.stringify({ t: frame.t, msg: frame.msg });
}
