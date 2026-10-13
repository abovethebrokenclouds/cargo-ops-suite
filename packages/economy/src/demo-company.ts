// Seeded DEMO company for the browser-only demo (no connector): the same book, payout,
// cost and wear code the connector runs, applied to a fixed script of deliveries, a
// loan and a lease over ~2.5 in-game months. Every value it produces is shown tagged
// DEMO; nothing here is presented as live data.

import { aircraftTypeByKey } from "../../protocol/src/aircraft-types";
import type { AirportLookup } from "./airports";
import { CompanyBook, newCompanyCore, type CompanyCore } from "./book";
import { GAME_DAY_MS } from "./company-constants";
import { REPUTATION, STARTING_CASH } from "./constants";
import { greatCircleNm, round1 } from "./geo";
import { computePayout } from "./payout";
import { deliveryReputationDelta } from "./rules";
import { selectAircraft, type Selection } from "./fleet-rules";

export const DEMO_COMPANY_SEED = 20_261_013;
/** Fixed wall clock for demo ledger timestamps (2026-10-13T12:00Z). */
export const DEMO_EPOCH_MS = Date.UTC(2026, 9, 13, 12, 0, 0);

interface Leg {
  day: number;
  aircraft: "starter" | "lease";
  from: string;
  to: string;
  kg: number;
  peakG: number;
}

/** The demo script (in-game days since founding). */
const LEGS: Leg[] = [
  { day: 1, aircraft: "starter", from: "KMEM", to: "KATL", kg: 840, peakG: 1.18 },
  { day: 3, aircraft: "starter", from: "KATL", to: "KBNA", kg: 900, peakG: 1.22 },
  { day: 5, aircraft: "starter", from: "KBNA", to: "KMEM", kg: 760, peakG: 1.31 },
  { day: 9, aircraft: "starter", from: "KMEM", to: "KSDF", kg: 980, peakG: 1.12 },
  { day: 12, aircraft: "starter", from: "KSDF", to: "KMEM", kg: 820, peakG: 1.46 },
  { day: 16, aircraft: "starter", from: "KMEM", to: "KATL", kg: 1_000, peakG: 1.2 },
  { day: 19, aircraft: "starter", from: "KATL", to: "KMEM", kg: 700, peakG: 1.25 },
  { day: 27, aircraft: "lease", from: "KMEM", to: "KLIT", kg: 650, peakG: 1.15 },
  { day: 33, aircraft: "starter", from: "KMEM", to: "KBNA", kg: 880, peakG: 1.21 },
  { day: 35, aircraft: "lease", from: "KLIT", to: "KMEM", kg: 600, peakG: 1.62 },
  { day: 38, aircraft: "starter", from: "KBNA", to: "KATL", kg: 940, peakG: 1.19 },
  { day: 44, aircraft: "starter", from: "KATL", to: "KMEM", kg: 1_020, peakG: 1.28 },
  { day: 49, aircraft: "lease", from: "KMEM", to: "KSDF", kg: 700, peakG: 1.24 },
  { day: 55, aircraft: "starter", from: "KMEM", to: "KATL", kg: 860, peakG: 1.17 },
  { day: 58, aircraft: "lease", from: "KSDF", to: "KMEM", kg: 690, peakG: 1.33 },
  { day: 63, aircraft: "starter", from: "KATL", to: "KBNA", kg: 900, peakG: 1.2 },
  { day: 70, aircraft: "starter", from: "KBNA", to: "KMEM", kg: 780, peakG: 1.36 },
];
/** In-game day the demo stops at. */
export const DEMO_END_DAY = 77.6;

export interface DemoCompany {
  book: CompanyBook;
  selection: Selection;
}

const grade = (g: number) => (g <= 1.4 ? "B" : g <= 1.7 ? "C" : "D");

/** Build the seeded DEMO company. Deterministic for a given airport list. */
export function buildDemoCompany(lookup: AirportLookup): DemoCompany {
  let wall = DEMO_EPOCH_MS;
  const company: CompanyCore = {
    name: "Cargo Ops Logistics",
    base: "KMEM",
    seed: DEMO_COMPANY_SEED,
    cash: STARTING_CASH,
    reputation: REPUTATION.start,
    ...newCompanyCore(STARTING_CASH),
  };
  const book = new CompanyBook({ company, airports: lookup, now: () => wall });
  const starter = book.ensureStarter();
  const to = (day: number) => {
    const target = Math.round(day * GAME_DAY_MS);
    if (target > book.company.gameMs) {
      wall += target - book.company.gameMs;
      book.advance(target - book.company.gameMs);
    }
  };
  let leased: string | null = null;
  let loanTaken = false;
  for (const leg of LEGS) {
    if (!loanTaken && leg.day > 20 && starter) {
      to(20.5);
      book.takeLoan({
        lenderId: "jetwash",
        principal: 400_000,
        termMonths: 36,
        collateral: { type: "aircraft", id: starter.id },
      });
      to(24);
      const lease = book.lease({ typeKey: "kodiak100", kind: "dry", airport: "KMEM" });
      if (lease.ok) leased = lease.data.id;
      loanTaken = true;
    }
    to(leg.day);
    const id = leg.aircraft === "starter" ? starter?.id : leased;
    const origin = lookup.get(leg.from);
    const dest = lookup.get(leg.to);
    const a = id ? book.aircraft(id) : null;
    if (!a || !origin || !dest) continue;
    const type = aircraftTypeByKey(a.typeKey);
    if (!type) continue;
    const nm = round1(greatCircleNm(origin, dest));
    const airborneMin = Math.round((nm / type.cruiseKt) * 60 + 8);
    const blockMin = airborneMin + 16;
    const g = grade(leg.peakG);
    const payout = computePayout({
      kind: "cargo",
      weightKg: Math.min(leg.kg, type.maxPayloadKg),
      distanceNm: nm,
      units: 1,
      reputation: book.company.reputation,
      estimate: false,
      landingGrade: g,
      lateMin: 0,
      peakG: leg.peakG,
    });
    const ref = `DEMO-${leg.day}`;
    book.post(
      "mission_payout",
      payout.total,
      "mission",
      ref,
      `${leg.from}→${leg.to} cargo ${leg.kg} kg`,
    );
    book.settleFlight(a.id, {
      fuelKg: Math.round(type.fuelBurnKgH * (blockMin / 60)),
      fuelAirport: dest,
      landingAirport: dest,
      blockMin,
      airborneMin,
      peakG: leg.peakG,
      overspeedEvents: 0,
      crashed: false,
      landings: 1,
      refType: "mission",
      refId: ref,
      memo: `Mission ${ref}`,
    });
    book.adjustReputation(deliveryReputationDelta(g, 0));
    to(leg.day + blockMin / 1440);
  }
  to(DEMO_END_DAY);
  book.drain();
  const fleet = book.activeFleet();
  const selection = selectAircraft(fleet, null, starter?.id ?? null, null);
  return { book, selection };
}
