import {
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
} from "@tanstack/react-router";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TOGGLE_FOLLOW_EVENT } from "@/lib/shortcuts";

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
