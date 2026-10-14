import { describe, expect, it } from "vitest";

import { CHORD_TIMEOUT_MS, NAV_SHORTCUTS, ShortcutMachine, isTypingTarget } from "./shortcuts";

describe("ShortcutMachine", () => {
  it("maps g + letter to every page", () => {
    const expected: Record<string, string> = {
      o: "/",
      f: "/flight",
      m: "/map",
      j: "/jobs",
      l: "/logbook",
      c: "/company",
      b: "/fbo",
      e: "/fleet",
      s: "/settings",
      d: "/diagnostics",
    };
    expect(Object.fromEntries(NAV_SHORTCUTS.map((s) => [s.key, s.to]))).toEqual(expected);
    for (const [key, to] of Object.entries(expected)) {
      const m = new ShortcutMachine();
      expect(m.handle({ key: "g" }, 0, "/")).toEqual({ type: "pending" });
      expect(m.handle({ key }, 100, "/")).toEqual({ type: "navigate", to });
      expect(m.pending).toBe(false);
    }
  });

  it("starts the chord window when the page responded, not before", () => {
    const m = new ShortcutMachine();
    // g pressed at 0, the page was blocked and only processed it (and its release) at 2 000.
    m.handle({ key: "g" }, 0, "/");
    m.responded(1_900);
    m.responded(2_000);
    expect(m.handle({ key: "j" }, 2_100, "/")).toEqual({ type: "navigate", to: "/jobs" });
    // A second key queued during the block (timestamp before the response) still counts.
    m.handle({ key: "g" }, 5_000, "/");
    m.responded(8_000);
    expect(m.handle({ key: "c" }, 5_200, "/")).toEqual({ type: "navigate", to: "/company" });
    // A responsive page: the window still expires CHORD_TIMEOUT_MS after the page saw g.
    m.handle({ key: "g" }, 10_000, "/");
    m.responded(10_005);
    expect(m.handle({ key: "j" }, 10_005 + CHORD_TIMEOUT_MS + 1, "/")).toBeNull();
    // responded() without a pending g does nothing.
    m.responded(20_000);
    expect(m.pending).toBe(false);
    expect(m.handle({ key: "j" }, 20_001, "/")).toBeNull();
  });

  it("forgets a g after the timeout and ignores unknown second keys", () => {
    const m = new ShortcutMachine();
    m.handle({ key: "g" }, 0, "/");
    expect(m.handle({ key: "j" }, CHORD_TIMEOUT_MS + 1, "/")).toBeNull();
    m.handle({ key: "g" }, 10_000, "/");
    expect(m.handle({ key: "x" }, 10_100, "/")).toBeNull();
    expect(m.handle({ key: "j" }, 10_200, "/")).toBeNull();
  });

  it("? opens help; f toggles follow only on /map", () => {
    const m = new ShortcutMachine();
    expect(m.handle({ key: "?" }, 0, "/jobs")).toEqual({ type: "help" });
    expect(m.handle({ key: "f" }, 0, "/map")).toEqual({ type: "toggle-follow" });
    expect(m.handle({ key: "f" }, 0, "/flight")).toBeNull();
    // After g, f navigates to /flight even on /map.
    m.handle({ key: "g" }, 0, "/map");
    expect(m.handle({ key: "f" }, 50, "/map")).toEqual({ type: "navigate", to: "/flight" });
  });

  it("ignores keys with Ctrl, Meta or Alt (browser shortcuts stay intact)", () => {
    const m = new ShortcutMachine();
    expect(m.handle({ key: "g", ctrlKey: true }, 0, "/")).toBeNull();
    expect(m.handle({ key: "f", metaKey: true }, 0, "/map")).toBeNull();
    m.handle({ key: "g" }, 0, "/");
    expect(m.handle({ key: "j", altKey: true }, 10, "/")).toBeNull();
    expect(m.pending).toBe(false);
  });
});

describe("isTypingTarget", () => {
  it("is true for text fields, selects, textareas, contenteditable and textbox roles", () => {
    const input = document.createElement("input");
    const search = Object.assign(document.createElement("input"), { type: "search" });
    const textarea = document.createElement("textarea");
    const select = document.createElement("select");
    const editable = document.createElement("div");
    editable.contentEditable = "true";
    // jsdom does not implement isContentEditable.
    Object.defineProperty(editable, "isContentEditable", { value: true });
    const combo = document.createElement("div");
    combo.setAttribute("role", "combobox");
    for (const el of [input, search, textarea, select, editable, combo]) {
      expect(isTypingTarget(el), el.outerHTML).toBe(true);
    }
  });

  it("is false for buttons, checkboxes, links, the body and null", () => {
    const checkbox = Object.assign(document.createElement("input"), { type: "checkbox" });
    for (const el of [
      document.createElement("button"),
      checkbox,
      document.createElement("a"),
      document.body,
      null,
    ]) {
      expect(isTypingTarget(el)).toBe(false);
    }
  });
});
