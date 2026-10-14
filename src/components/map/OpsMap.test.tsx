import { render, screen, waitFor } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { OpsMap, type OpsMapProps } from "./OpsMap";

// Counts how often the MapLibre module is actually loaded and constructed.
const loads = vi.hoisted(() => ({ module: 0, maps: 0 }));

vi.mock("maplibre-gl", () => {
  loads.module++;
  class FakeMap {
    private handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    touchZoomRotate = { disableRotation: () => {} };
    constructor() {
      loads.maps++;
    }
    on(event: string, a: unknown, b?: unknown) {
      const fn = (typeof a === "function" ? a : b) as (...args: unknown[]) => void;
      const list = this.handlers.get(event) ?? [];
      list.push(fn);
      this.handlers.set(event, list);
      return this;
    }
    addControl() {
      return this;
    }
    remove() {}
  }
  class FakeControl {}
  return {
    default: {
      Map: FakeMap,
      NavigationControl: FakeControl,
      addProtocol: () => {},
      setWorkerUrl: () => {},
      removeProtocol: () => {},
    },
  };
});
vi.mock("maplibre-gl/dist/maplibre-gl.css", () => ({}));
vi.mock("maplibre-gl/dist/maplibre-gl-worker.mjs?url", () => ({ default: "/worker.mjs" }));

const baseProps: OpsMapProps = {
  servedByConnector: false,
  onlineAllowed: false,
  aircraft: null,
  route: null,
  origin: null,
  destination: null,
  trail: [],
  airports: null,
  layers: { airports: true, trail: true, route: true, weather: true },
  follow: true,
  onFollowChange: () => {},
};

describe("OpsMap", () => {
  beforeEach(() => {
    loads.module = 0;
    loads.maps = 0;
  });

  it("server-renders an empty container without touching MapLibre", () => {
    const html = renderToString(<OpsMap {...baseProps} />);
    expect(html).toContain('data-testid="ops-map"');
    expect(html).toContain("Loading map");
    expect(loads.module).toBe(0);
    expect(loads.maps).toBe(0);
  });

  it("waits for the client-side inputs before loading the library", async () => {
    render(<OpsMap {...baseProps} servedByConnector={null} onlineAllowed={null} />);
    expect(screen.getByTestId("ops-map")).toBeInTheDocument();
    expect(screen.getByTestId("basemap-badge")).toHaveTextContent("Loading map");
    await new Promise((r) => setTimeout(r, 20));
    expect(loads.maps).toBe(0);
  });

  it("creates the map only after mount, from the dynamic import", async () => {
    const { unmount } = render(<OpsMap {...baseProps} />);
    // First render: container present, no map yet.
    expect(screen.getByTestId("ops-map")).toHaveAttribute("data-ready", "false");
    await waitFor(() => expect(loads.maps).toBe(1), { timeout: 5000 });
    unmount();
  });

  it("never renders an aircraft marker without position data", () => {
    render(<OpsMap {...baseProps} />);
    expect(screen.queryByTestId("aircraft-marker")).toBeNull();
  });
});
