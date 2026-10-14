import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { parseTaf, type TafReport, type TafStationResult } from "@cargo-ops/weather";

import { TafTimeline } from "./TafTimeline";

// Hand-made TAF text (invented forecast for a real station id), not a recording.
const RAW =
  "TAF KMEM 131720Z 1318/1418 20009KT P6SM FEW040 SCT250 FM132200 22012KT P6SM SCT050 TEMPO 1401/1404 4SM -SHRA BKN030 FM140600 18006KT P6SM SCT035 BKN100 PROB30 1410/1414 2SM TSRA BKN015CB";
const NOW = Date.parse("2026-10-13T19:00:00Z");

function result(origin: "live" | "sample" = "live", stale = false): TafStationResult {
  const taf = parseTaf(RAW, new Date(NOW));
  if (!taf) throw new Error("fixture does not parse");
  const report: TafReport = {
    ...taf,
    origin,
    rawText: RAW,
    decodedBy: "parser",
    fetchedAt: new Date(NOW).toISOString(),
    stale,
  };
  return { station: "KMEM", report, note: stale ? "Could not reach aviationweather.gov." : null };
}

describe("TafTimeline", () => {
  it("draws prevailing segments, change periods and a now tick", () => {
    render(<TafTimeline result={result()} now={NOW} attribution="TAF: test credit" />);
    const t = screen.getByTestId("taf-timeline");
    expect(t).toHaveAttribute("data-origin", "live");
    expect(within(t).getByText("LIVE")).toBeInTheDocument();
    expect(within(t).getByTestId("taf-validity")).toHaveTextContent(
      /13\/18Z – 14\/18Z · issued 1 h 40 min ago/,
    );
    expect(
      within(t)
        .getAllByTestId("taf-segment")
        .map((s) => s.getAttribute("data-category")),
    ).toEqual(["VFR", "VFR", "VFR"]);
    expect(within(t).getAllByTestId("taf-period")).toHaveLength(5);
    expect(within(t).getByTestId("taf-now")).toBeInTheDocument();
    expect(within(t).getByTestId("taf-source")).toHaveTextContent(
      "TAF: test credit. For simulation only.",
    );
  });

  it("marks the ETA and names the category and temporary changes at that time", () => {
    const eta = Date.parse("2026-10-14T02:30:00Z");
    render(<TafTimeline result={result()} now={NOW} etaMs={eta} />);
    const t = screen.getByTestId("taf-timeline");
    const marker = within(t).getByTestId("taf-eta-marker");
    // 8.5 h into a 24 h validity.
    expect(marker.style.left).toBe(`${((8.5 / 24) * 100).toFixed(3)}%`);
    const line = within(t).getByTestId("taf-eta");
    expect(line).toHaveTextContent("At ETA 14/0230Z");
    expect(within(line).getByTestId("flight-category")).toHaveTextContent("VFR");
    expect(line).toHaveTextContent("TEMPO MVFR");
  });

  it("an ETA outside the validity has no marker and says so", () => {
    render(<TafTimeline result={result()} now={NOW} etaMs={Date.parse("2026-10-14T20:00:00Z")} />);
    expect(screen.queryByTestId("taf-eta-marker")).toBeNull();
    expect(screen.getByTestId("taf-eta")).toHaveTextContent("after this TAF ends");
  });

  it("SAMPLE and stale labels, and a note without a report", () => {
    const { unmount } = render(<TafTimeline result={result("sample")} now={NOW} />);
    expect(screen.getByText("SAMPLE")).toBeInTheDocument();
    expect(screen.getByTestId("taf-source")).toHaveTextContent(/not a real forecast/);
    unmount();
    const stale = render(<TafTimeline result={result("live", true)} now={NOW} />);
    expect(screen.getByText("STALE")).toBeInTheDocument();
    expect(screen.getByText(/Could not reach/)).toBeInTheDocument();
    stale.unmount();
    render(
      <TafTimeline
        result={{ station: "KZZZ", report: null, note: "No current TAF for this station." }}
        now={NOW}
      />,
    );
    expect(screen.getByTestId("taf-note")).toHaveTextContent("No current TAF");
    expect(screen.queryByTestId("taf-period")).toBeNull();
  });
});
