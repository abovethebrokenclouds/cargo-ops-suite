import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  clientMessageSchema,
  encode,
  isFrame,
  parseClientMessage,
  parseServerMessage,
  serverMessageSchema,
  type ClientMessage,
  type ServerMessage,
} from "./index";

const welcome = {
  type: "welcome",
  v: 1,
  session: "s1",
  mode: "live",
  sim: { connected: true, name: "MSFS 2024", version: "1.4", protocol: "SunRise" },
};

const snapshot = {
  type: "snapshot",
  v: 1,
  seq: 0,
  source: "sim",
  state: {
    sim: { connected: true, paused: false, simRate: 1, name: "MSFS 2024" },
    aircraft: { title: "Cessna 208B Grand Caravan EX", atcId: "N401CO" },
    position: { lat: 35.04, lon: -89.98, altFt: 341, aglFt: 0 },
    motion: {
      iasKt: 0,
      tasKt: 0,
      gsKt: 0,
      hdgMagDeg: 180,
      hdgTrueDeg: 178,
      vsFpm: 0,
      gForce: 1,
      onGround: true,
    },
    fuel: { totalGal: 250, totalLb: 1675, flowPph: [0] },
    weights: { totalLb: 8400, emptyLb: 4730, maxGrossLb: 8750, payloadLb: 2000 },
    engines: { running: [false] },
    controls: { parkingBrake: true },
    phase: { current: "Boarding" },
    plan: null,
  },
};

const delta = {
  type: "delta",
  v: 1,
  seq: 1,
  source: "sim",
  patch: { position: { lat: 35.05 }, motion: { gsKt: 6 } },
};

const event = {
  type: "event",
  v: 1,
  seq: 2,
  source: "sim",
  name: "phase.changed",
  data: { from: "Boarding", to: "TaxiOut" },
};

describe("parseServerMessage", () => {
  it.each([
    ["welcome", welcome],
    ["snapshot", snapshot],
    ["delta", delta],
    ["event", event],
    ["result ok", { type: "result", v: 1, id: "c1", ok: true, data: { accepted: true } }],
    [
      "result error",
      { type: "result", v: 1, id: "c1", ok: false, error: { code: "E_STATE", message: "no" } },
    ],
    ["ping", { type: "ping", v: 1, t: 123 }],
    ["pong", { type: "pong", v: 1, t: 123 }],
  ])("accepts a valid %s", (_label, input) => {
    const parsed = parseServerMessage(input);
    expect(parsed.ok).toBe(true);
  });

  it("accepts a raw JSON string", () => {
    const parsed = parseServerMessage(JSON.stringify(delta));
    expect(parsed).toMatchObject({ ok: true, msg: { type: "delta", seq: 1 } });
  });

  it("accepts a snapshot with no domains (no data is representable)", () => {
    const parsed = parseServerMessage({ type: "snapshot", v: 1, seq: 0, source: "sim", state: {} });
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.msg.type === "snapshot") {
      expect(parsed.msg.state.position).toBeUndefined();
    }
  });

  it("does not invent defaults for missing optional fields", () => {
    const parsed = parseServerMessage({ ...welcome, sim: { connected: false } });
    expect(parsed.ok && parsed.msg.type === "welcome" && parsed.msg.sim).toEqual({
      connected: false,
    });
  });

  it.each(["snapshot", "delta", "event"])("requires source on %s frames", (type) => {
    const base = { snapshot, delta, event }[type] as Record<string, unknown>;
    const { source: _omit, ...rest } = base;
    const parsed = parseServerMessage(rest);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.error).toContain("source");
  });

  it("rejects an unknown source", () => {
    expect(parseServerMessage({ ...delta, source: "cloud" }).ok).toBe(false);
  });

  it("rejects a missing or negative seq", () => {
    const { seq: _omit, ...noSeq } = delta;
    expect(parseServerMessage(noSeq).ok).toBe(false);
    expect(parseServerMessage({ ...delta, seq: -1 }).ok).toBe(false);
    expect(parseServerMessage({ ...delta, seq: 1.5 }).ok).toBe(false);
  });

  it("rejects a protocol version mismatch", () => {
    const parsed = parseServerMessage({ ...snapshot, v: 2 });
    expect(parsed).toEqual({
      ok: false,
      error: "unsupported protocol version 2 (expected 1)",
    });
    expect(parseServerMessage({ ...welcome, v: undefined }).ok).toBe(false);
  });

  it("rejects unknown types, non-objects and invalid JSON", () => {
    expect(parseServerMessage({ type: "bogus", v: 1 })).toMatchObject({ ok: false });
    expect(parseServerMessage(null)).toMatchObject({ ok: false });
    expect(parseServerMessage([welcome])).toMatchObject({ ok: false });
    expect(parseServerMessage("{nope")).toEqual({ ok: false, error: "invalid JSON" });
    // Client-only messages are not valid from the server.
    expect(parseServerMessage({ type: "resync", v: 1, lastSeq: 3 }).ok).toBe(false);
    // Prototype keys are not message types.
    expect(parseServerMessage({ type: "toString", v: 1 }).ok).toBe(false);
  });

  it("rejects bad field values", () => {
    expect(parseServerMessage({ ...welcome, mode: "cloud" }).ok).toBe(false);
    expect(parseServerMessage({ ...event, name: "made.up" }).ok).toBe(false);
    expect(
      parseServerMessage({
        ...snapshot,
        state: { position: { lat: 120, lon: 0, altFt: 0, aglFt: 0 } },
      }).ok,
    ).toBe(false);
    expect(
      parseServerMessage({ ...snapshot, state: { phase: { current: "Teleporting" } } }).ok,
    ).toBe(false);
    expect(parseServerMessage({ ...delta, patch: { motion: { gsKt: "fast" } } }).ok).toBe(false);
    expect(parseServerMessage({ type: "result", v: 1, id: "c1", ok: false }).ok).toBe(false);
  });

  it("allows null in a delta to clear a domain", () => {
    expect(parseServerMessage({ ...delta, patch: { plan: null } }).ok).toBe(true);
  });

  it("matches the exported union schema", () => {
    expect(serverMessageSchema.safeParse(snapshot).success).toBe(true);
  });
});

describe("parseClientMessage", () => {
  it("accepts hello, command, resync, ping and pong", () => {
    const msgs: ClientMessage[] = [
      { type: "hello", v: 1, token: "abc", client: "web", wants: ["telemetry", "flight"] },
      { type: "command", v: 1, id: "c1", name: "job.accept", args: { jobId: "j1" } },
      { type: "resync", v: 1, lastSeq: 41 },
      { type: "resync", v: 1, lastSeq: -1 },
      { type: "ping", v: 1, t: 1 },
      { type: "pong", v: 1, t: 1 },
    ];
    for (const msg of msgs) {
      expect(parseClientMessage(msg)).toEqual({ ok: true, msg });
      expect(clientMessageSchema.safeParse(msg).success).toBe(true);
    }
  });

  it("rejects invalid client messages", () => {
    expect(
      parseClientMessage({ type: "hello", v: 1, token: "", client: "web", wants: [] }).ok,
    ).toBe(false);
    expect(
      parseClientMessage({ type: "hello", v: 1, token: "t", client: "cli", wants: [] }).ok,
    ).toBe(false);
    expect(parseClientMessage({ type: "command", v: 1, id: "c1", name: "nodots" }).ok).toBe(false);
    expect(parseClientMessage({ type: "resync", v: 1, lastSeq: -2 }).ok).toBe(false);
    expect(parseClientMessage({ type: "resync", v: 2, lastSeq: 0 }).ok).toBe(false);
    expect(parseClientMessage({ ...welcome }).ok).toBe(false);
  });
});

describe("encode", () => {
  it("round-trips through the parser", () => {
    const msg: ServerMessage = {
      type: "event",
      v: PROTOCOL_VERSION,
      seq: 7,
      source: "demo",
      name: "touchdown",
      data: { rateFpm: -140 },
    };
    expect(parseServerMessage(encode(msg))).toEqual({ ok: true, msg });
    expect(isFrame(msg)).toBe(true);
    expect(isFrame({ type: "ping", v: 1, t: 0 })).toBe(false);
  });
});
