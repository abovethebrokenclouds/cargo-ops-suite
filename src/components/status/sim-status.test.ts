import { describe, expect, it } from "vitest";

import { initialSimState, type ClientSimState } from "@/lib/sim-state";

import { chipStatusFor } from "./sim-status";

const welcome = (connected: boolean): ClientSimState["welcome"] => ({
  type: "welcome",
  v: 1,
  session: "s",
  mode: "live",
  sim: { connected, name: "MSFS 2024", protocol: "SunRise" },
});

describe("chipStatusFor", () => {
  it("never shows live before a welcome reports a running sim", () => {
    expect(chipStatusFor({ ...initialSimState, connection: "live", welcome: null })).toBe(
      "disconnected",
    );
    expect(chipStatusFor({ ...initialSimState, connection: "live", welcome: welcome(false) })).toBe(
      "disconnected",
    );
    expect(chipStatusFor({ ...initialSimState, connection: "live", welcome: welcome(true) })).toBe(
      "live",
    );
  });

  it("maps demo, replay, connecting and connector failures", () => {
    expect(chipStatusFor({ ...initialSimState, connection: "demo" })).toBe("demo");
    expect(chipStatusFor({ ...initialSimState, connection: "replay" })).toBe("replay");
    expect(chipStatusFor({ ...initialSimState, connection: "idle" })).toBe("connecting");
    expect(chipStatusFor({ ...initialSimState, connection: "disconnected" })).toBe("error");
    expect(chipStatusFor({ ...initialSimState, connection: "error" })).toBe("error");
  });
});
