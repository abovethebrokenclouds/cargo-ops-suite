import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { aircraftTypeByKey, type AircraftType, type Mission } from "@cargo-ops/protocol";
import { airportLookup, computePayout, type EconomyAirport } from "@cargo-ops/economy";
import { demoJobsState, jobSuitability } from "@/lib/economy/board";
import { missionTimeLeftMin, multiplier } from "@/lib/economy/format";
import { projectTrack } from "@/lib/economy/track";

import { MissionCard } from "./MissionCard";
import { PayoutBreakdown } from "./PayoutBreakdown";

const lookup = airportLookup(
  JSON.parse(
    readFileSync(resolve(__dirname, "../../assets/data/airports-major.json"), "utf8"),
  ) as EconomyAirport[],
);
const c208 = aircraftTypeByKey("c208b") as AircraftType;
const NOW = Date.UTC(2026, 9, 13, 12);

describe("demo job board (same generator as the connector)", () => {
  it("is deterministic and multi-board for the route finder", () => {
    const a = demoJobsState(lookup, c208, NOW);
    const b = demoJobsState(lookup, c208, NOW);
    expect(a).toEqual(b);
    expect(a.boards[0]?.origin).toBe("KMEM");
    expect(a.boards.length).toBeGreaterThan(1);
    expect(a.available.filter((j) => j.origin === "KMEM")).toHaveLength(24);
    expect(a.accepted).toEqual([]);
  });

  it("suitability badges reflect runway, range and payload", () => {
    const job = demoJobsState(lookup, c208, NOW).available[0];
    expect(job).toBeDefined();
    if (!job) return;
    expect(jobSuitability(job, c208, lookup).map((b) => b.ok)).toEqual([true, true, true]);
    const b748 = aircraftTypeByKey("b748f") as AircraftType;
    const heavy = jobSuitability({ ...job, weightKg: 200_000 }, b748, lookup);
    expect(heavy.find((b) => b.key === "payload")?.ok).toBe(false);
  });
});

describe("MissionCard", () => {
  it("renders route, kind, weight, payout and the DEMO tag", () => {
    const job = demoJobsState(lookup, c208, NOW).available[0];
    if (!job) throw new Error("no job");
    render(
      <ul>
        <MissionCard
          job={job}
          type={c208}
          lookup={lookup}
          source="demo"
          action={<button>Accept</button>}
        />
      </ul>,
    );
    const card = screen.getByTestId("job-card");
    expect(card).toHaveTextContent(`${job.origin} → ${job.destination}`);
    expect(within(card).getByText("DEMO")).toBeInTheDocument();
    expect(within(card).getByTestId("job-payout").textContent).toMatch(/^\$[\d,]+$/);
    expect(card.querySelectorAll("[data-suitability]")).toHaveLength(3);
  });
});

describe("PayoutBreakdown", () => {
  it("lists every factor and the total", () => {
    const b = computePayout({
      kind: "express",
      weightKg: 950,
      distanceNm: 287.7,
      units: 2,
      reputation: 50,
      estimate: false,
      landingGrade: "A+",
      lateMin: 30,
    });
    render(<PayoutBreakdown breakdown={b} />);
    const table = screen.getByTestId("payout-breakdown");
    expect(table.querySelectorAll("[data-factor]")).toHaveLength(8);
    expect(table).toHaveTextContent("$10,258");
    expect(table).toHaveTextContent("× 1.50");
    expect(table).toHaveTextContent("−$540");
  });

  it("formats multipliers", () => {
    expect([1, 1.04, 0.812252, 1.1].map(multiplier)).toEqual(["1.00", "1.04", "0.8123", "1.10"]);
  });
});

describe("mission helpers", () => {
  it("time left counts down only in flight", () => {
    const m = { status: "in_progress", timeLimitMin: 150, elapsedMin: 160 } as Mission;
    expect(missionTimeLeftMin(m)).toBe(-10);
    expect(missionTimeLeftMin({ ...m, status: "loaded" })).toBeNull();
  });

  it("projects a track into the SVG box", () => {
    const xy = projectTrack([
      { lat: 35, lon: -90 },
      { lat: 33.6, lon: -84.4 },
    ]);
    expect(xy).toHaveLength(2);
    for (const [x, y] of xy) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(400);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(220);
    }
    expect(xy[0]?.[0]).toBeLessThan(xy[1]?.[0] ?? 0);
  });
});
