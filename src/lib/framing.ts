// The in-sim toolbar panel (msfs-panel/) shows /panel inside an iframe. The connector lets
// only that path be framed (connector/src/server/security.ts); this module is the web app's
// side of the same rule: no other route renders inside a frame, even if the framed app were
// to navigate client-side, and /panel tells its host page that it loaded (no data).

/** The one route that may run inside a frame. */
export const PANEL_PATH = "/panel";

/** Message /panel posts to its host page once mounted. It carries no data at all. */
export const PANEL_READY_MESSAGE = { source: "cargo-ops-panel", type: "ready" } as const;

/** True inside an iframe (or when the top window cannot even be compared). */
export function isFramed(win: Window): boolean {
  try {
    return win.self !== win.top;
  } catch {
    return true;
  }
}

/** A framed page that is not /panel must not render the app. */
export function isFrameBlocked(pathname: string, framed: boolean): boolean {
  return framed && pathname !== PANEL_PATH;
}

/**
 * Tell the host page (the simulator's toolbar panel) that /panel has loaded, so it hides its
 * "Start Cargo Ops" fallback. Target "*" because the host's origin is the simulator's own
 * `coui:` page; the message is a constant and reveals nothing but "loaded".
 */
export function announcePanelReady(win: Window): boolean {
  if (!isFramed(win)) return false;
  try {
    win.parent.postMessage(PANEL_READY_MESSAGE, "*");
    return true;
  } catch {
    return false;
  }
}
