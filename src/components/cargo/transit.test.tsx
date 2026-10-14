import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { aircraftTypeByKey, type AircraftType, type Job, type Mission } from "@cargo-ops/protocol";
import {
  airportLookup,
  arriveInTransit,
  computePayout,
  generateJobs,
  transitStorage,
  type EconomyAirport,
} from "@cargo-ops/economy";
import { jobSuitability } from "@/lib/economy/board";
import { transitDeadlineText, transitView } from "@/lib/economy/format";
import { transitPins } from "@/lib/economy/transit-pins";

import { MissionCard } from "./MissionCard";
import { MissionStrip } from "./MissionStrip";
import { TransitCargo } from "./TransitCargo";

// MissionStrip links to /jobs; no router is mounted in this unit test.
vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  Link: ({ children }: { children: React.ReactNode }) => <a href="/jobs">{children}</a>,
}));

const airports = JSON.parse(
  readFileSync(resolve(__dirname, "../../assets/data/airports-major.json"), "utf8"),
) as EconomyAirport[];
const lookup = airportLookup(airports);
const c208 = aircraftTypeByKey("c208b") as AircraftType;
const NOW = Date.UTC(2026, 9, 13, 12);
const T0 = 86_400_000; // Month 1 · Day 2 · 00:00
const MIN = 60_000;

function board(): Job[] {
  const origin = lookup.get("KMEM");
  if (!origin) throw new Error("KMEM");
  return generateJobs({
    origin,
    airports,
    aircraft: c208,
    seed: 4242,
    nowMs: NOW,
    reputation: 50,
    longHaulJobs: 2,
    focus: lookup.get("KMIA") ?? null,
  });
}

/** A KMEM → KMIA long-haul job flown to KATL and stored there (public ramp). */
function stored(): Job {
  const job = board().find((j) => j.longHaul && j.destination === "KMIA");
  if (!job) throw new Error("no KMIA long-haul job");
  return arriveInTransit(
    { ...job, status: "loaded", missionId: "M-1" },
    {
      missionId: "M-1",
      origin: "KMEM",
      destination: "KATL",
      blockMin: 119,
      landingGrade: "B",
      peakG: 1.18,
      noBonus: false,
      payloadMismatch: false,
    },
    {
      arrivedAt: "2026-10-13T14:00:00.000Z",
      arrivedGameMs: T0,
      ...transitStorage({ fbo: false, terminalLevel: 0 }),
    },
  );
}

describe("long-haul jobs on the board", () => {
  it("are tagged 'Needs a stop' and judged per leg, not refused for range", () => {
    const job = board().find((j) => j.longHaul);
    if (!job) throw new Error("no long-haul job");
    const badges = jobSuitability(job, c208, lookup);
    expect(badges.find((b) => b.key === "range")).toMatchObject({
      ok: true,
      label: "Range (stop)",
    });
    expect(badges.find((b) => b.key === "payload")?.ok).toBe(true);
    render(
      <ul>
        <MissionCard job={job} type={c208} lookup={lookup} source="replay" />
      </ul>,
    );
    expect(screen.getByTestId("long-haul-tag")).toHaveTextContent("Needs a stop");
  });
});

describe("transit cargo view", () => {
  it("shows location, final destination, company-clock deadline and time left", () => {
    const job = stored();
    const limit = job.timeLimitMin;
    const v = transitView(job, T0 + 60 * MIN);
    expect(v).toMatchObject({
      location: "KATL",
      destination: "KMIA",
      leftMin: limit - 119 - 60,
      late: false,
      storageLabel: "Airport ramp",
      freeHours: 0,
      legs: 1,
    });
    expect(transitView({ ...job, transit: undefined } as Job, T0)).toBeNull();
    expect(transitView(job, T0 + (limit - 119 + 30) * MIN)).toMatchObject({
      late: true,
      leftMin: -30,
    });
    // No company clock yet: the due time is known, the time left is not guessed.
    const unknown = transitView(job, null, 50);
    expect(unknown).toMatchObject({ leftMin: null, late: false, payoutEstimate: null });
    expect(unknown && transitDeadlineText(unknown)).toMatch(
      /^Due Month 1 · Day \d+ · \d\d:\d\d · time left unknown$/,
    );
    // The estimate carries the late penalty accrued so far: 90 min late → −15 % of gross.
    const late = transitView(job, T0 + (limit - 119 + 90) * MIN, 50);
    const onTime = transitView(job, T0, 50);
    expect(onTime?.payoutEstimate).toBe(job.payoutEstimate);
    const gross = computePayout({
      kind: job.kind,
      weightKg: job.weightKg,
      distanceNm: job.distanceNm,
      units: job.units,
      reputation: 50,
      estimate: false,
      landingGrade: null,
      lateMin: 90,
      peakG: 1.18,
    });
    expect(late?.payoutEstimate).toBe(gross.total);
    expect(late?.payoutEstimate).toBeLessThan(job.payoutEstimate);
  });

  it("TransitCargo lists the cargo with its deadline and selects it for the onward leg", () => {
    const job = stored();
    const onSelect = vi.fn();
    const onAbandon = vi.fn();
    render(
      <TransitCargo
        jobs={[job]}
        nowGameMs={T0 + 60 * MIN}
        reputation={50}
        source="replay"
        selected={[]}
        onSelect={onSelect}
        onAbandon={onAbandon}
        disabled={false}
      />,
    );
    const row = screen.getByTestId("transit-job");
    expect(row).toHaveAttribute("data-location", "KATL");
    expect(within(row).getByTestId("transit-location")).toHaveTextContent("at KATL");
    expect(row).toHaveTextContent("KMIA");
    expect(within(row).getByTestId("transit-deadline")).toHaveTextContent(/^Due Month 1 · Day 2 /);
    expect(screen.getByText("REPLAY")).toBeInTheDocument();
    fireEvent.click(within(row).getByLabelText(`Select ${job.id}`));
    expect(onSelect).toHaveBeenCalledWith(job.id, true);
    expect(within(row).getByTestId("transit-payout")).toHaveTextContent(
      `est. $${job.payoutEstimate.toLocaleString("en-US")} on delivery`,
    );
    // Abandon asks first: cancelling keeps the cargo, confirming abandons it.
    fireEvent.click(within(row).getByTestId("transit-abandon"));
    expect(screen.getByText("Abandon this cargo?")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Keep it"));
    expect(onAbandon).not.toHaveBeenCalled();
    fireEvent.click(within(row).getByTestId("transit-abandon"));
    fireEvent.click(screen.getByTestId("transit-abandon-confirm"));
    expect(onAbandon).toHaveBeenCalledWith(job.id);
  });

  it("renders nothing without cargo in transit", () => {
    const { container } = render(
      <TransitCargo
        jobs={[]}
        nowGameMs={0}
        reputation={50}
        source="replay"
        selected={[]}
        onSelect={() => {}}
        disabled={false}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("map pins: one per airport with the jobs' destinations and deadlines", () => {
    const job = stored();
    const pins = transitPins([job, { ...job, id: "J-OTHER" }], T0, lookup);
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatchObject({
      id: "transit-KATL",
      kind: "transit",
      label: "KATL · 2 in transit",
    });
    expect(pins[0]?.title).toContain(`${job.id} → KMIA, Due Month 1 · Day`);
    expect(pins[0]?.title).toMatch(/left$/);
    expect(transitPins([job], null, lookup)[0]?.title).toMatch(/time left unknown$/);
    expect(transitPins([{ ...job, status: "loaded" }], T0, lookup)).toEqual([]);
  });

  it("the mission strip announces a transit leg", () => {
    const job = stored();
    const mission: Mission = {
      id: "M-2",
      status: "loaded",
      origin: "KMEM",
      destination: "KATL",
      jobIds: [job.id],
      jobs: [{ ...job, status: "loaded" }],
      aircraftKey: "c208b",
      payloadKg: job.weightKg,
      distanceNm: 287.7,
      timeLimitMin: 400,
      expectedPayout: 0,
      createdAt: "2026-10-13T12:00:00.000Z",
      transitJobIds: [job.id],
    };
    render(<MissionStrip mission={mission} source="replay" />);
    expect(screen.getByTestId("mission-strip-transit")).toHaveTextContent(
      "Transit leg: 1 job goes beyond KATL · stored there, paid on final delivery",
    );
    expect(screen.getByTestId("mission-deadline")).toHaveTextContent("6h 40m from block-out");
  });

  it("the mission strip shows a transit leg that is already late as late, not 1 min", () => {
    const job = stored();
    const mission: Mission = {
      id: "M-3",
      status: "loaded",
      origin: "KATL",
      destination: "KMIA",
      jobIds: [job.id],
      jobs: [{ ...job, status: "loaded" }],
      aircraftKey: "c208b",
      payloadKg: job.weightKg,
      distanceNm: 517.7,
      timeLimitMin: -91.7,
      expectedPayout: 6313,
      createdAt: "2026-10-13T12:00:00.000Z",
    };
    render(<MissionStrip mission={mission} source="replay" />);
    const deadline = screen.getByTestId("mission-deadline");
    expect(deadline).toHaveTextContent("1h 32m late already");
    expect(deadline.className).toContain("text-destructive");
    expect(screen.getByTestId("mission-payout")).toHaveTextContent("$6,313");
  });
});
