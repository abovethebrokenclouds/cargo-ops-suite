import { describe, expect, it, vi } from "vitest";

import {
  PANEL_PATH,
  PANEL_READY_MESSAGE,
  announcePanelReady,
  isFrameBlocked,
  isFramed,
} from "./framing";

function fakeWindow(framed: boolean, postMessage = vi.fn()) {
  const parent = { postMessage } as unknown as Window;
  const self = {} as Window;
  const win = { self, top: framed ? parent : self, parent } as unknown as Window;
  return { win, postMessage };
}

describe("framing rules (web side of the toolbar panel)", () => {
  it("only /panel may render inside a frame", () => {
    expect(PANEL_PATH).toBe("/panel");
    expect(isFrameBlocked("/panel", true)).toBe(false);
    for (const p of ["/", "/flight", "/settings", "/jobs", "/panel/", "/panelx"]) {
      expect(isFrameBlocked(p, true)).toBe(true);
      expect(isFrameBlocked(p, false)).toBe(false);
    }
  });

  it("detects a frame, and treats an unreadable top as framed", () => {
    expect(isFramed(fakeWindow(false).win)).toBe(false);
    expect(isFramed(fakeWindow(true).win)).toBe(true);
    const hostile = {
      get self() {
        return {};
      },
      get top(): Window {
        throw new Error("blocked");
      },
    } as unknown as Window;
    expect(isFramed(hostile)).toBe(true);
    expect(isFramed(window)).toBe(false); // jsdom test page is not framed
  });

  it("announces readiness to the host page only when framed, with a constant message", () => {
    const top = fakeWindow(false);
    expect(announcePanelReady(top.win)).toBe(false);
    expect(top.postMessage).not.toHaveBeenCalled();

    const framed = fakeWindow(true);
    expect(announcePanelReady(framed.win)).toBe(true);
    expect(framed.postMessage).toHaveBeenCalledWith(PANEL_READY_MESSAGE, "*");
    expect(PANEL_READY_MESSAGE).toEqual({ source: "cargo-ops-panel", type: "ready" });
  });
});
