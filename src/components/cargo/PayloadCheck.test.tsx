import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PayloadCheck } from "@cargo-ops/protocol";
import { checkPayload, computePayout } from "@cargo-ops/economy";

import { payloadCheckAdvice } from "@/lib/economy/payload-check";

import { PayloadCheckLine, PayloadCheckPill } from "./PayloadCheck";
import { PayoutBreakdown } from "./PayoutBreakdown";

const STATIONS = [
  { name: "Pilot", weightLb: 170 },
  { name: "Cargo Zone A", weightLb: 450 },
  { name: "Cargo Zone B", weightLb: 520 },
  { name: "Cargo Zone C", weightLb: 480 },
  { name: "Cargo Pod", weightLb: 380 },
];

function check(over: Partial<Parameters<typeof checkPayload>[0]> = {}): PayloadCheck {
  return checkPayload({
    cargoKg: 840,
    stations: STATIONS,
    weights: { totalLb: 8430, maxGrossLb: 8750 },
    source: "replay",
    stage: "preview",
    checkedAt: "2026-10-14T12:00:00.000Z",
    ...over,
  });
}

describe("payload check UI", () => {
  it("ok: status, the connector's numbers and the REPLAY label", () => {
    render(<PayloadCheckLine check={check()} />);
    const line = screen.getByTestId("payload-check");
    expect(line).toHaveAttribute("data-status", "ok");
    expect(line).toHaveAttribute("data-source", "replay");
    expect(line).toHaveTextContent("Payload OK");
    expect(line).toHaveTextContent("REPLAY");
    expect(screen.getByTestId("payload-check-numbers")).toHaveTextContent(
      "Sim 830 kg (stations 907 kg − 77 kg crew stations) · cargo 840 kg ± 84 kg · gross 8,430 / 8,750 lb",
    );
    expect(screen.queryByTestId("payload-check-advice")).toBeNull();
  });

  it("underloaded preview warns before departure; departure states the consequence", () => {
    const { rerender } = render(<PayloadCheckLine check={check({ cargoKg: 950 })} />);
    expect(screen.getByTestId("payload-check-advice")).toHaveTextContent(
      "Load the cargo in the simulator before departure",
    );
    expect(screen.getByRole("status")).toBeInTheDocument();
    rerender(<PayloadCheckLine check={check({ cargoKg: 950, stage: "departure" })} />);
    expect(screen.getByTestId("payload-check")).toHaveAttribute("data-stage", "departure");
    expect(screen.getByTestId("payload-check-advice")).toHaveTextContent("No payout bonuses");
  });

  it("unknown shows no numbers and says nothing is penalised; live sim has no tag", () => {
    render(<PayloadCheckLine check={check({ stations: [], source: "sim" })} />);
    expect(screen.getByTestId("payload-check")).toHaveTextContent("Payload unknown");
    expect(screen.queryByTestId("payload-check-numbers")).toBeNull();
    expect(screen.getByTestId("payload-check")).not.toHaveTextContent("REPLAY");
    expect(payloadCheckAdvice(check({ stations: [] }))).toMatch(/nothing is penalised/);
  });

  it("overloaded preview says the flight cannot start", () => {
    const c = check({ weights: { totalLb: 9000, maxGrossLb: 8750 } });
    expect(payloadCheckAdvice(c)).toMatch(/cannot start/);
  });

  it("logbook pill: short label, demo tag, em dash without a check", () => {
    const { rerender } = render(<PayloadCheckPill check={check({ source: "demo" })} />);
    expect(screen.getByTestId("payload-check-pill")).toHaveTextContent("OKDEMO");
    rerender(<PayloadCheckPill check={null} />);
    expect(screen.queryByTestId("payload-check-pill")).toBeNull();
  });
});

describe("payout breakdown: no-bonus reason", () => {
  const job = {
    kind: "cargo" as const,
    weightKg: 500,
    distanceNm: 100,
    units: 1,
    reputation: 50,
    estimate: false,
    landingGrade: "B" as const,
    lateMin: 0,
  };
  const total = (text: string) => screen.getAllByText(text).length;

  it("names both reasons when the sim rate and the payload both removed bonuses", () => {
    render(
      <PayoutBreakdown
        breakdown={computePayout({ ...job, noBonus: true, payloadMismatch: true })}
      />,
    );
    // The reputation and conditions notes plus the payout row.
    expect(
      total("No bonuses: sim rate went above 1× and the sim payload was below the cargo"),
    ).toBe(3);
  });

  it("names the payload alone when only the payload check applied", () => {
    render(<PayoutBreakdown breakdown={computePayout({ ...job, payloadMismatch: true })} />);
    expect(total("No bonuses: the sim payload was below the cargo at departure")).toBe(3);
  });
});
