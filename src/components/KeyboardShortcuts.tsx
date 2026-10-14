import { useNavigate, useRouterState } from "@tanstack/react-router";
import { Keyboard } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  NAV_SHORTCUTS,
  OPEN_SHORTCUTS_EVENT,
  CHORD_TICK_MS,
  OTHER_SHORTCUTS,
  ResponsiveClock,
  ShortcutMachine,
  TOGGLE_FOLLOW_EVENT,
  isTypingTarget,
} from "@/lib/shortcuts";

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="inline-grid min-w-6 place-items-center rounded-md border border-border bg-secondary px-1.5 py-0.5 font-mono text-xs text-foreground">
      {children}
    </kbd>
  );
}

/** Global key listener + the `?` dialog. Mounted once in the root layout. */
export function KeyboardShortcuts() {
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [open, setOpen] = useState(false);
  const machine = useRef(new ShortcutMachine());
  const pathRef = useRef(pathname);
  pathRef.current = pathname;
  const openRef = useRef(open);
  openRef.current = open;

  useEffect(() => {
    // The chord window runs on a clock that only advances while the page can respond (see
    // ResponsiveClock): time the main thread was blocked (a route rendering, a large module
    // parsing, the map initialising) must not split `g j`, whether the block fell before the
    // second key or between the two. While a chord is pending the clock is read every
    // CHORD_TICK_MS so an idle person still runs out of time at the normal rate.
    const clock = new ResponsiveClock();
    const read = () => clock.read(performance.now());
    let ticker: ReturnType<typeof setInterval> | null = null;
    const stopTicking = () => {
      if (ticker !== null) globalThis.clearInterval(ticker);
      ticker = null;
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing || e.repeat) return;
      if (isTypingTarget(e.target)) return;
      // Another dialog (confirmations, menus) owns the keyboard while it is open.
      if (!openRef.current && document.querySelector('[role="dialog"], [role="alertdialog"]')) {
        return;
      }
      const now = read();
      const action = machine.current.handle(e, now, pathRef.current);
      if (!machine.current.pending) stopTicking();
      if (!action) return;
      if (action.type === "pending") {
        machine.current.responded(now);
        if (ticker === null) {
          ticker = globalThis.setInterval(() => {
            if (machine.current.expire(read()) || !machine.current.pending) stopTicking();
          }, CHORD_TICK_MS);
        }
        return;
      }
      e.preventDefault();
      if (action.type === "help") setOpen((o) => !o);
      else if (action.type === "toggle-follow") {
        window.dispatchEvent(new Event(TOGGLE_FOLLOW_EVENT));
      } else {
        setOpen(false);
        void navigate({ to: action.to });
      }
    };
    const onKeyUp = () => {
      if (machine.current.pending) machine.current.responded(read());
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener(OPEN_SHORTCUTS_EVENT, onOpen);
      stopTicking();
    };
  }, [navigate]);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        className="panel-elevated max-w-md border-border bg-card"
        data-testid="shortcuts-dialog"
      >
        <DialogHeader>
          <DialogTitle className="font-display">Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press <Kbd>g</Kbd> then a letter to jump to a page. Shortcuts are ignored while you type
            in a field.
          </DialogDescription>
        </DialogHeader>
        <table className="w-full text-sm">
          <caption className="sr-only">Go to a page</caption>
          <tbody>
            {NAV_SHORTCUTS.map((s) => (
              <tr key={s.key} className="border-b border-border/60 last:border-0">
                <td className="py-1.5 pr-4">
                  <span className="flex items-center gap-1">
                    <Kbd>g</Kbd>
                    <Kbd>{s.key}</Kbd>
                  </span>
                </td>
                <td className="py-1.5 text-muted-foreground">{s.label}</td>
              </tr>
            ))}
            {OTHER_SHORTCUTS.map((s) => (
              <tr key={s.label} className="border-b border-border/60 last:border-0">
                <td className="py-1.5 pr-4">
                  <span className="flex items-center gap-1">
                    {s.keys.map((k) => (
                      <Kbd key={k}>{k}</Kbd>
                    ))}
                  </span>
                </td>
                <td className="py-1.5 text-muted-foreground">{s.label}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </DialogContent>
    </Dialog>
  );
}

/** Icon button in the header that opens the shortcuts dialog. */
export function ShortcutsButton({ className }: { className?: string }) {
  return (
    <button
      type="button"
      aria-label="Keyboard shortcuts"
      aria-keyshortcuts="?"
      title="Keyboard shortcuts (?)"
      data-testid="shortcuts-button"
      onClick={() => window.dispatchEvent(new Event(OPEN_SHORTCUTS_EVENT))}
      className={
        className ??
        "hidden size-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground md:grid"
      }
    >
      <Keyboard className="size-4" aria-hidden="true" />
    </button>
  );
}
