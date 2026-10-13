import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { TelemetryPoint } from "@/lib/sim-state/history";

const created: Array<{ opts: { series: Array<{ stroke?: string }> }; data: unknown[] }> = [];
const setData = vi.fn();
const destroy = vi.fn();

vi.mock("uplot", () => ({
  default: class {
    constructor(opts: { series: Array<{ stroke?: string }> }, data: unknown[]) {
      created.push({ opts, data });
    }
    setData = setData;
    setSize = vi.fn();
    destroy = destroy;
  },
}));

import { TelemetryStrip } from "./TelemetryStrip";

const points: TelemetryPoint[] = [
  { t: 1_000, altFt: 3000, vsFpm: 800, gsKt: 120 },
  { t: 2_000, altFt: 3013, vsFpm: 790, gsKt: 121 },
];

afterEach(() => {
  created.length = 0;
  setData.mockClear();
  destroy.mockClear();
  document.documentElement.style.removeProperty("--primary");
});

describe("TelemetryStrip", () => {
  it("shows an empty state until two frames have arrived", () => {
    render(<TelemetryStrip points={points.slice(0, 1)} />);
    expect(screen.getByText("Collecting telemetry")).toBeInTheDocument();
    expect(created).toHaveLength(0);
  });

  it("lazy-loads uPlot with token colours and the latest values", async () => {
    document.documentElement.style.setProperty("--primary", "oklch(0.72 0.19 255)");
    const { rerender, unmount } = render(<TelemetryStrip points={points} />);
    const strip = screen.getByTestId("telemetry-strip");
    expect(strip).toHaveTextContent("3,013");
    expect(strip).toHaveTextContent("790");
    expect(strip).toHaveTextContent("121");
    await waitFor(() => expect(created).toHaveLength(3));
    expect(created[0]?.opts.series[1]?.stroke).toBe("oklch(0.72 0.19 255)");
    expect(created[0]?.data).toEqual([
      [1, 2],
      [3000, 3013],
    ]);
    rerender(
      <TelemetryStrip points={[...points, { t: 3_000, altFt: 3026, vsFpm: 780, gsKt: 122 }]} />,
    );
    expect(setData).toHaveBeenCalledTimes(3);
    unmount();
    expect(destroy).toHaveBeenCalledTimes(3);
  });
});
