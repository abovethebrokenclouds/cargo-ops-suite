import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CHORD_TICK_MS, TOGGLE_FOLLOW_EVENT } from "@/lib/shortcuts";

import { KeyboardShortcuts, ShortcutsButton } from "./KeyboardShortcuts";

const PATHS = [
  "/",
  "/flight",
  "/map",
  "/jobs",
  "/logbook",
  "/company",
  "/fbo",
  "/fleet",
  "/settings",
  "/diagnostics",
];

function setup(initial = "/") {
  const root = createRootRoute({
    component: () => (
      <>
        <ShortcutsButton className="block" />
        <input aria-label="Search" />
        <Outlet />
        <KeyboardShortcuts />
      </>
    ),
  });
  const children = PATHS.map((path) =>
    createRoute({
      getParentRoute: () => root,
      path,
      component: () => <p data-testid="page">{path}</p>,
    }),
  );
  const router = createRouter({
    routeTree: root.addChildren(children),
    history: createMemoryHistory({ initialEntries: [initial] }),
  });
  render(<RouterProvider router={router} />);
  return router;
}

const press = (key: string, target: Window | Element = window) =>
  act(() => {
    fireEvent.keyDown(target, { key });
  });

describe("KeyboardShortcuts", () => {
  it("g then a letter navigates", async () => {
    const router = setup("/");
    await screen.findByText("/");
    press("g");
    press("j");
    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
    press("g");
    press("b");
    await waitFor(() => expect(router.state.location.pathname).toBe("/fbo"));
    press("g");
    press("o");
    await waitFor(() => expect(router.state.location.pathname).toBe("/"));
  });

  it("ignores keys typed into a field", async () => {
    const router = setup("/");
    await screen.findByText("/");
    const input = screen.getByLabelText("Search");
    input.focus();
    press("g", input);
    press("m", input);
    await new Promise((r) => setTimeout(r, 20));
    expect(router.state.location.pathname).toBe("/");
  });

  it("? opens the shortcuts dialog; the header button does too", async () => {
    setup("/");
    await screen.findByText("/");
    press("?");
    const dialog = await screen.findByRole("dialog", { name: "Keyboard shortcuts" });
    expect(dialog).toHaveTextContent("Diagnostics");
    expect(dialog).toHaveTextContent("Map: follow the aircraft");
    press("Escape", dialog);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Keyboard shortcuts" }));
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeVisible();
  });

  it("a main thread blocked between g and the letter does not drop the chord", async () => {
    const router = setup("/");
    await screen.findByText("/");
    let t = 10_000;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => t);
    try {
      press("g");
      // No timer ran for 3 s (a long task), then the letter arrives.
      t += 3_000;
      press("j");
    } finally {
      spy.mockRestore();
    }
    await waitFor(() => expect(router.state.location.pathname).toBe("/jobs"));
  });

  it("an idle g still expires after the chord timeout", async () => {
    const router = setup("/");
    await screen.findByText("/");
    let t = 50_000;
    const spy = vi.spyOn(performance, "now").mockImplementation(() => t);
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      press("g");
      for (let i = 0; i < 20; i++) {
        t += CHORD_TICK_MS;
        vi.advanceTimersByTime(CHORD_TICK_MS);
      }
      press("j");
    } finally {
      vi.useRealTimers();
      spy.mockRestore();
    }
    await act(async () => {
      await new Promise((r) => setTimeout(r, 30));
    });
    expect(router.state.location.pathname).toBe("/");
  });

  it("f toggles map follow on /map only", async () => {
    let toggles = 0;
    const onToggle = () => toggles++;
    window.addEventListener(TOGGLE_FOLLOW_EVENT, onToggle);
    try {
      const router = setup("/flight");
      await screen.findByText("/flight");
      press("f");
      expect(toggles).toBe(0);
      await act(() => router.navigate({ to: "/map" }));
      await screen.findByText("/map");
      press("f");
      expect(toggles).toBe(1);
    } finally {
      window.removeEventListener(TOGGLE_FOLLOW_EVENT, onToggle);
    }
  });
});
