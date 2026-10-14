import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { SimEvent } from "@cargo-ops/protocol";

import { initialSimState } from "@/lib/sim-state";
import { goNoGoLamps } from "@/lib/ops/mission-control";

import { ConsolePanel, ConsoleRow, Readout } from "./Console";
import { EventLoop } from "./EventLoop";
import { GoNoGoBoard } from "./GoNoGoBoard";

describe("GoNoGoBoard", () => {
  it("renders every lamp grey (NO DATA) without data, none lit", () => {
    const lamps = goNoGoLamps({
      state: initialSimState,
      now: null,
      fleet: null,
      fleetSource: null,
      weather: { station: null, category: null, sample: false, source: null },
    });
    render(<GoNoGoBoard lamps={lamps} />);
    const cells = screen.getAllByTestId("lamp");
    expect(cells).toHaveLength(10);
    for (const cell of cells) {
      expect(cell).toHaveAttribute("data-state", "nodata");
      expect(cell).toHaveClass("lamp");
      expect(within(cell).getByTestId("lamp-value")).toHaveTextContent("NO DATA");
    }
    expect(screen.queryByText("DEMO")).toBeNull();
    expect(screen.getByTestId("board-summary")).toHaveTextContent("0 GO");
  });

  it("tags lamps with their source and marks sample weather", () => {
    render(
      <GoNoGoBoard
        lamps={[
          {
            id: "link",
            label: "SIM LINK",
            state: "hold",
            value: "DEMO",
            detail: "",
            source: "demo",
          },
          {
            id: "wx",
            label: "WX DEST",
            state: "hold",
            value: "MVFR",
            detail: "",
            source: "demo",
            sample: true,
          },
          { id: "fresh", label: "DATA", state: "go", value: "FRESH", detail: "", source: "sim" },
        ]}
      />,
    );
    const [link, wx, fresh] = screen.getAllByTestId("lamp");
    expect(within(link!).getByText("DEMO", { selector: "[data-source-tag]" })).toBeInTheDocument();
    expect(within(wx!).getByText("SAMPLE")).toBeInTheDocument();
    // Live sim data carries no tag.
    expect(fresh!.querySelector("[data-source-tag]")).toBeNull();
  });
});

describe("EventLoop", () => {
  const ev = (seq: number, name: SimEvent["name"], data: unknown) => ({
    at: Date.UTC(2026, 9, 14, 12, 0, seq),
    msg: { type: "event", v: 1, seq, source: "demo", name, data } as SimEvent,
  });

  it("shows the empty text when there are no events", () => {
    render(<EventLoop events={[]} source={null} emptyText="NO DATA: offline." />);
    expect(screen.getByTestId("event-loop-empty")).toHaveTextContent("NO DATA: offline.");
    expect(screen.queryByRole("log")).toBeNull();
  });

  it("lists events newest first with UTC stamps and DEMO tags", () => {
    render(
      <EventLoop
        events={[
          ev(1, "flight.started", { origin: "KMEM", destination: "KATL" }),
          ev(2, "phase.changed", { from: "Boarding", to: "TaxiOut" }),
        ]}
        source="demo"
        emptyText=""
      />,
    );
    const lines = screen.getAllByTestId("loop-line");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveTextContent("12:00:02Z");
    expect(lines[0]).toHaveTextContent("PHASE Boarding → TaxiOut");
    expect(lines[1]).toHaveTextContent("FLIGHT STARTED KMEM → KATL");
    for (const l of lines) expect(within(l).getByText("DEMO")).toBeInTheDocument();
  });
});

describe("Console primitives", () => {
  it("Readout shows a grey em dash, never a number, for null", () => {
    render(
      <dl>
        <Readout label="ALT" value={null} unit="ft" testId="r" />
      </dl>,
    );
    const v = screen.getByTestId("r-value");
    expect(v).toHaveTextContent("—");
    expect(v).toHaveAttribute("data-empty");
    expect(v.className).not.toMatch(/phosphor/);
  });

  it("ConsoleRow keeps the mono font with tabular digits", () => {
    render(
      <dl>
        <ConsoleRow label="Fuel" value="1,234 lb" tone="green" testId="row" />
      </dl>,
    );
    const dd = screen.getByTestId("row").querySelector("dd");
    expect(dd).toHaveClass("font-mono");
    expect(dd).toHaveClass("tabular-nums");
    expect(dd).toHaveClass("text-phosphor-green");
  });

  it("ConsolePanel labels the station with its call sign and source", () => {
    render(
      <ConsolePanel callsign="NAV" title="Route" source="replay" testId="c">
        body
      </ConsolePanel>,
    );
    const panel = screen.getByTestId("c");
    expect(panel).toHaveAttribute("aria-label", "NAV: Route");
    expect(within(panel).getByText("REPLAY")).toBeInTheDocument();
  });
});
