import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { formatUsd } from "@/lib/format";

import { MetricTile } from "./MetricTile";

describe("MetricTile", () => {
  it("renders an em dash, never a number, when the value is null", () => {
    render(<MetricTile label="Altitude" value={null} unit="ft" size="xl" />);
    const value = screen.getByTestId("metric-value");
    expect(value).toHaveTextContent("—");
    expect(value.textContent).not.toMatch(/\d/);
    expect(value).toHaveAttribute("data-empty");
    expect(value).toHaveClass("metric-xl");
  });

  it("treats non-finite values as missing", () => {
    render(<MetricTile label="Fuel" value={Number.NaN} />);
    expect(screen.getByTestId("metric-value")).toHaveTextContent("—");
  });

  it("formats values with thousands separators by default", () => {
    render(<MetricTile label="Altitude" value={35000} unit="ft" />);
    const value = screen.getByTestId("metric-value");
    expect(value).toHaveTextContent("35,000");
    expect(value).not.toHaveAttribute("data-empty");
    expect(value).toHaveClass("metric-lg");
    expect(screen.getByText("ft")).toBeInTheDocument();
    expect(screen.getByText("Altitude")).toHaveClass("label-eyebrow");
  });

  it("uses a custom formatter", () => {
    render(<MetricTile label="Cash" value={248500} format={formatUsd} size="md" />);
    expect(screen.getByTestId("metric-value")).toHaveTextContent("$248,500");
  });

  it("tags demo and replay sources but not live sim data", () => {
    const { rerender } = render(<MetricTile label="Cash" value={1} source="demo" />);
    expect(screen.getByText("DEMO")).toBeInTheDocument();
    rerender(<MetricTile label="Cash" value={1} source="replay" />);
    expect(screen.getByText("REPLAY")).toBeInTheDocument();
    rerender(<MetricTile label="Cash" value={1} source="sim" />);
    expect(screen.queryByText("DEMO")).toBeNull();
    expect(screen.queryByText("REPLAY")).toBeNull();
  });

  it("shows a trend indicator and hint", () => {
    render(<MetricTile label="VS" value={1200} trend="up" hint="Climbing" />);
    expect(screen.getByLabelText("rising")).toBeInTheDocument();
    expect(screen.getByText("Climbing")).toBeInTheDocument();
  });

  it("renders children", () => {
    render(
      <MetricTile label="Fuel" value={null}>
        <span>gauge</span>
      </MetricTile>,
    );
    expect(screen.getByText("gauge")).toBeInTheDocument();
  });
});
