import { describe, expect, it } from "vitest";
import { encodeFixtureLine, parseFixture, type FixtureFrame } from "./index";

const snapshotLine = JSON.stringify({
  t: 0,
  msg: { type: "snapshot", v: 1, seq: 0, source: "demo", state: {} },
});
const deltaLine = JSON.stringify({
  t: 1000,
  msg: { type: "delta", v: 1, seq: 1, source: "demo", patch: { motion: { gsKt: 4 } } },
});

describe("parseFixture", () => {
  it("parses JSONL, skipping blank lines and CRLF endings", () => {
    const parsed = parseFixture(`${snapshotLine}\r\n\r\n${deltaLine}\n`);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.frames.map((f) => f.t)).toEqual([0, 1000]);
      expect(parsed.frames[1]?.msg.type).toBe("delta");
    }
  });

  it("returns an empty list for empty text", () => {
    expect(parseFixture("")).toEqual({ ok: true, frames: [] });
  });

  it("reports the line number of invalid JSON", () => {
    expect(parseFixture(`${snapshotLine}\n{oops`)).toEqual({
      ok: false,
      error: "line 2: invalid JSON",
    });
  });

  it("rejects lines with invalid messages", () => {
    const bad = JSON.stringify({ t: 5, msg: { type: "delta", v: 1, seq: 1, patch: {} } });
    const parsed = parseFixture(`${snapshotLine}\n${bad}`);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toMatch(/^line 2: delta: source/);
  });

  it("rejects a version mismatch inside a fixture", () => {
    const bad = JSON.stringify({
      t: 0,
      msg: { type: "snapshot", v: 2, seq: 0, source: "demo", state: {} },
    });
    expect(parseFixture(bad).ok).toBe(false);
  });

  it("rejects missing, negative or backwards t", () => {
    const msg = { type: "ping", v: 1, t: 0 };
    expect(parseFixture(JSON.stringify({ msg })).ok).toBe(false);
    expect(parseFixture(JSON.stringify({ t: -1, msg })).ok).toBe(false);
    expect(parseFixture(`${deltaLine}\n${snapshotLine}`)).toMatchObject({
      ok: false,
      error: expect.stringContaining("line 2: t went backwards"),
    });
    expect(parseFixture("[1,2]").ok).toBe(false);
  });

  it("round-trips encodeFixtureLine", () => {
    const frame: FixtureFrame = {
      t: 250,
      msg: { type: "event", v: 1, seq: 3, source: "replay", name: "flight.ended", data: {} },
    };
    expect(parseFixture(encodeFixtureLine(frame))).toEqual({ ok: true, frames: [frame] });
  });
});
