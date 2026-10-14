import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { PayloadCheck } from "@cargo-ops/protocol";
import { checkPayload, computePayout } from "@cargo-ops/economy";

import { parseEnteredPayload, payloadCheckAdvice } from "@/lib/economy/payload-check";

import { EnteredPayload } from "./EnteredPayload";
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

describe("payload entered by you and the TOTAL WEIGHT cross-check UI", () => {
  const W = { totalLb: 8430, emptyLb: 4730, maxGrossLb: 8750 };

  it("unknown + entered: labelled YOURS, used, not verified; no sim numbers invented", () => {
    render(
      <PayloadCheckLine
        check={check({
          stations: [],
          weights: W,
          fuelLb: 1700,
          enteredPayloadKg: 830,
          source: "sim",
        })}
      />,
    );
    const line = screen.getByTestId("payload-check");
    expect(line).toHaveAttribute("data-status", "unknown");
    expect(screen.queryByTestId("payload-check-numbers")).toBeNull();
    const entered = screen.getByTestId("payload-check-entered");
    expect(entered).toHaveAttribute("data-role", "used");
    expect(entered).toHaveTextContent("YOURS");
    expect(entered).toHaveTextContent(
      "Entered by you 830 kg · used because the sim reports no payload stations",
    );
    expect(screen.getByTestId("payload-check-implied")).toHaveTextContent(
      "Total weight − empty − fuel 907 kg · matches the entered payload",
    );
    expect(screen.getByTestId("payload-check-advice")).toHaveTextContent("bonuses are unaffected");
  });

  it("a contradicting entered value is shown struck through as ignored; the sim status stays", () => {
    render(
      <PayloadCheckLine
        check={check({
          cargoKg: 950,
          weights: W,
          fuelLb: 1700,
          enteredPayloadKg: 950,
          stage: "departure",
        })}
      />,
    );
    expect(screen.getByTestId("payload-check")).toHaveAttribute("data-status", "underloaded");
    const entered = screen.getByTestId("payload-check-entered");
    expect(entered).toHaveAttribute("data-role", "contradicts");
    expect(entered).toHaveTextContent("ignored, the sim decides");
    expect(entered.className).toMatch(/line-through/);
    expect(screen.getByTestId("payload-check-advice")).toHaveTextContent("No payout bonuses");
  });

  it("cross-check mismatch is flagged in the line and the logbook pill", () => {
    const c = check({
      stations: [
        { name: "Pilot", weightLb: 170 },
        { name: "Cargo", weightLb: 50 },
      ],
      weights: W,
      fuelLb: 1700,
    });
    const { unmount } = render(<PayloadCheckLine check={c} />);
    const implied = screen.getByTestId("payload-check-implied");
    expect(implied).toHaveAttribute("data-cross-check", "mismatch");
    expect(implied).toHaveTextContent("mismatch with the stations (beyond ± 100 kg)");
    unmount();
    render(<PayloadCheckPill check={c} />);
    expect(screen.getByTestId("payload-check-pill-mismatch")).toBeInTheDocument();
  });

  it("logbook pill marks a check that carries an entered value", () => {
    render(
      <PayloadCheckPill check={check({ stations: [], enteredPayloadKg: 500, source: "sim" })} />,
    );
    const pill = screen.getByTestId("payload-check-pill");
    expect(pill).toHaveTextContent("Unknown");
    expect(pill).toHaveTextContent("YOURS");
  });

  it("overloaded by the entered value: a warning that does not claim the start is blocked", () => {
    const c = check({ stations: [], weights: W, fuelLb: 1700, enteredPayloadKg: 2500 });
    expect(c.overBasis).toBe("entered");
    expect(payloadCheckAdvice(c)).toMatch(/payload you entered/);
    expect(payloadCheckAdvice(c)).not.toMatch(/cannot start/);
  });
});

describe("entered payload form", () => {
  it("parses: empty = clear, out of range or text = invalid", () => {
    expect(parseEnteredPayload("")).toBeNull();
    expect(parseEnteredPayload(" 830.5 ")).toBe(830.5);
    expect(parseEnteredPayload("-1")).toBeNaN();
    expect(parseEnteredPayload("abc")).toBeNaN();
    expect(parseEnteredPayload("300000")).toBeNaN();
  });

  it("saves a number, clears with null, and is frozen after departure", () => {
    const saved: Array<number | null> = [];
    const { rerender } = render(
      <EnteredPayload
        valueKg={null}
        cargoKg={840}
        busy={false}
        editable
        onSave={(kg) => saved.push(kg)}
      />,
    );
    const input = screen.getByLabelText(/Payload entered by you/);
    fireEvent.change(input, { target: { value: "830" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(saved).toEqual([830]);
    fireEvent.change(input, { target: { value: "-4" } });
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
    rerender(
      <EnteredPayload
        valueKg={830}
        cargoKg={840}
        busy={false}
        editable
        onSave={(kg) => saved.push(kg)}
      />,
    );
    expect(input).toHaveValue("830");
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(saved).toEqual([830, null]);
    rerender(
      <EnteredPayload
        valueKg={830}
        cargoKg={840}
        busy={false}
        editable={false}
        onSave={(kg) => saved.push(kg)}
      />,
    );
    expect(screen.getByLabelText(/Payload entered by you/)).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    expect(screen.getByTestId("entered-payload")).toHaveTextContent("Frozen at departure");
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
