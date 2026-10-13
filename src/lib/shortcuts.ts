// Keyboard shortcuts (P6): `g` then a letter navigates, `?` opens the shortcuts dialog, `f`
// toggles map follow on /map. Pure logic here; the listener lives in
// components/KeyboardShortcuts.tsx. Typing in a field never triggers a shortcut.

export type NavTarget =
  | "/"
  | "/flight"
  | "/map"
  | "/jobs"
  | "/logbook"
  | "/company"
  | "/fbo"
  | "/fleet"
  | "/settings"
  | "/diagnostics";

export interface NavShortcut {
  key: string;
  to: NavTarget;
  label: string;
}

export const NAV_SHORTCUTS: readonly NavShortcut[] = [
  { key: "o", to: "/", label: "Ops dashboard" },
  { key: "f", to: "/flight", label: "Live flight" },
  { key: "m", to: "/map", label: "Map" },
  { key: "j", to: "/jobs", label: "Jobs" },
  { key: "l", to: "/logbook", label: "Logbook" },
  { key: "c", to: "/company", label: "Company" },
  { key: "b", to: "/fbo", label: "FBOs" },
  { key: "e", to: "/fleet", label: "Fleet" },
  { key: "s", to: "/settings", label: "Settings" },
  { key: "d", to: "/diagnostics", label: "Diagnostics" },
];

/** Other shortcuts, for the help dialog. */
export const OTHER_SHORTCUTS: ReadonlyArray<{ keys: string[]; label: string }> = [
  { keys: ["?"], label: "Show this list" },
  { keys: ["f"], label: "Map: follow the aircraft on / off" },
  { keys: ["Esc"], label: "Close a dialog" },
];

/** How long after `g` the second key is accepted, ms. */
export const CHORD_TIMEOUT_MS = 1_500;

export type ShortcutAction =
  | { type: "navigate"; to: NavTarget }
  | { type: "help" }
  | { type: "toggle-follow" }
  | { type: "pending" };

export interface KeyInput {
  key: string;
  ctrlKey?: boolean;
  metaKey?: boolean;
  altKey?: boolean;
}

/** True for elements where a key press is text input (or a control that uses the keys). */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!target || typeof (target as { tagName?: unknown }).tagName !== "string") return false;
  const el = target as HTMLElement;
  const tag = el.tagName.toLowerCase();
  if (tag === "textarea" || tag === "select") return true;
  if (tag === "input") {
    const type = ((el as HTMLInputElement).type || "text").toLowerCase();
    return !["checkbox", "radio", "button", "submit", "reset", "range", "color", "file"].includes(
      type,
    );
  }
  if (el.isContentEditable) return true;
  const role = el.getAttribute?.("role");
  return role === "textbox" || role === "combobox" || role === "searchbox";
}

/** Stateful `g`-chord interpreter. Feed it key presses with a clock. */
export class ShortcutMachine {
  private pendingSince: number | null = null;

  reset(): void {
    this.pendingSince = null;
  }

  get pending(): boolean {
    return this.pendingSince !== null;
  }

  handle(input: KeyInput, now: number, pathname: string): ShortcutAction | null {
    if (input.ctrlKey || input.metaKey || input.altKey) {
      this.reset();
      return null;
    }
    const key = input.key;
    if (this.pendingSince !== null && now - this.pendingSince > CHORD_TIMEOUT_MS) this.reset();
    if (this.pendingSince !== null) {
      this.reset();
      const hit = NAV_SHORTCUTS.find((s) => s.key === key.toLowerCase());
      return hit ? { type: "navigate", to: hit.to } : null;
    }
    if (key === "?") return { type: "help" };
    if (key === "g" || key === "G") {
      this.pendingSince = now;
      return { type: "pending" };
    }
    if ((key === "f" || key === "F") && pathname === "/map") return { type: "toggle-follow" };
    return null;
  }
}

/** Window events the shortcuts use to reach components without shared state. */
export const TOGGLE_FOLLOW_EVENT = "cargo-ops:toggle-follow";
export const OPEN_SHORTCUTS_EVENT = "cargo-ops:open-shortcuts";
