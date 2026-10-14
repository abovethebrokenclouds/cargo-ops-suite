// Hired pilots (plan §7.4, P6 optional): wage, leg income, costs and wear, determinism,
// the aircraft being unavailable to the player, grounding, month rollover and the ledger
// balancing to the cent. Worked examples match docs/ECONOMY.md ("Hired pilots").

import { describe, expect, it } from "vitest";
import { aircraftTypeByKey, type AircraftType, type Defect } from "@cargo-ops/protocol";
import {
  CompanyBook,
  GAME_DAY_MS,
  GAME_MONTH_MS,
  HIRED_PILOTS,
  addPilotPnl,
  airportLookup,
  legFuelBurnKg,
  legIncome,
  legLoadShare,
  legTimes,
  newCompanyCore,
  nextDutyDeparture,
  payloadLimitKg,
  pilotName,
  pilotWage,
  ratingFor,
  systemsFromCondition,
  type BookNotice,
  type CompanyCore,
} from "../src/index";
import { greatCircleNm, round1 } from "../src/geo";
import { bundledAirports } from "./airports";

const lookup = airportLookup(bundledAirports());
const NOW = Date.UTC(2026, 9, 13, 12, 0, 0);
const HOUR = 3_600_000;

function type(key: string): AircraftType {
  const t = aircraftTypeByKey(key);
  if (!t) throw new Error(key);
  return t;
}

function newBook(overrides: Partial<CompanyCore> = {}): CompanyBook {
  const company: CompanyCore = {
    name: "Test Air",
    base: "KMEM",
    seed: 4242,
    cash: 250_000,
    reputation: 50,
    ...newCompanyCore(250_000),
    ...overrides,
  };
  return new CompanyBook({ company, airports: lookup, now: () => NOW });
}

const cents = (n: number) => Math.round(n * 100);

/** A book with the starter C208B at KMEM, a turboprop pilot and the KMEM–KATL route. */
function routeBook(seed = 4242) {
  const book = newBook({ seed });
  const starter = book.ensureStarter();
  if (!starter) throw new Error("no starter");
  const hired = book.hirePilot("turboprop");
  if (!hired.ok) throw new Error(hired.message);
  const assigned = book.assignPilot({
    pilotId: hired.data.pilot.id,
    aircraftId: starter.id,
    destination: "KATL",
    served: ["KATL"],
  });
  if (!assigned.ok) throw new Error(assigned.message);
  return { book, starter, pilotId: hired.data.pilot.id };
}

/** Every drained change, accumulated (the connector persists these). */
function collect(book: CompanyBook) {
  const ledger: Array<{ category: string; amount: number; balance: number; gameMs: number }> = [];
  const notices: BookNotice[] = [];
  return {
    ledger,
    notices,
    drain() {
      const c = book.drain();
      ledger.push(...c.ledger);
      notices.push(...c.notices);
      return c;
    },
  };
}

function expectBalanced(book: CompanyBook, entries: Array<{ amount: number; balance: number }>) {
  const sum = entries.reduce((s, e) => s + cents(e.amount), 0);
  expect(sum).toBe(cents(book.company.cash) - cents(book.company.startingCash));
  let running = cents(book.company.startingCash);
  for (const e of entries) {
    running += cents(e.amount);
    expect(cents(e.balance)).toBe(running);
  }
}

function defect(severity: Defect["severity"], system: Defect["system"] = "engines"): Defect {
  return {
    id: `D-${severity}-${system}`,
    system,
    severity,
    title: `${severity} ${system}`,
    repairCost: 1_000,
    downtimeHours: 4,
    hidden: false,
    cause: "listing",
  };
}

describe("hired pilot rules", () => {
  it("ratings cover the catalogue's turboprops and jets; wages per month", () => {
    expect(ratingFor("single-turboprop")).toBe("turboprop");
    expect(ratingFor("twin-turboprop")).toBe("turboprop");
    expect(ratingFor("regional-turboprop")).toBe("turboprop");
    expect(ratingFor("narrowbody-jet")).toBe("jet");
    expect(ratingFor("widebody-jet")).toBe("jet");
    expect(ratingFor("single-piston")).toBeNull();
    expect(pilotWage("turboprop")).toBe(7_500);
    expect(pilotWage("jet")).toBe(14_000);
    expect(HIRED_PILOTS.payoutShare).toBe(0.5);
  });

  it("names are fictional and deterministic from the seed and the hire counter", () => {
    expect(pilotName(4242, 1)).toBe(pilotName(4242, 1));
    expect(pilotName(4242, 1)).toBe("Sawyer Ibarra");
    expect(pilotName(4242, 2)).not.toBe(pilotName(4242, 1));
  });

  it("worked example: a C208B leg KMEM→KATL", () => {
    const t = type("c208b");
    const nm = round1(greatCircleNm(lookup.get("KMEM") as never, lookup.get("KATL") as never));
    expect(nm).toBe(287.7);
    // 287.7 / 170 × 60 = 101.5 + 10 → 112 airborne; block 132.
    expect(legTimes(t, nm)).toEqual({ airborneMin: 112, blockMin: 132 });
    // 170 kg/h × 132 / 60 = 374 kg.
    expect(legFuelBurnKg(t, 132)).toBe(374);
    expect(payloadLimitKg(t, nm)).toBe(944);
    // Average load 0.7 × 944 = 661 kg; the board would pay $5,606; hired income 50 %.
    expect(legIncome({ type: t, distanceNm: nm, reputation: 50, share: 0.7 })).toEqual({
      loadKg: 661,
      boardPayout: 5_606,
      income: 2_803,
    });
    // Major defects cut the payload limit like they do for missions.
    expect(
      legIncome({ type: t, distanceNm: nm, reputation: 50, share: 0.7, payloadPenaltyPct: 10 })
        .loadKg,
    ).toBe(Math.round(Math.floor(944 * 0.9) * 0.7));
  });

  it("the load share is seeded per pilot and leg, inside 50–90 %", () => {
    const a = [1, 2, 3, 4, 5].map((n) => legLoadShare(4242, "HP-1", n));
    const b = [1, 2, 3, 4, 5].map((n) => legLoadShare(4242, "HP-1", n));
    expect(a).toEqual(b);
    for (const s of a) {
      expect(s).toBeGreaterThanOrEqual(0.5);
      expect(s).toBeLessThan(0.9);
    }
    expect(legLoadShare(4243, "HP-1", 1)).not.toBe(a[0]);
  });

  it("departures stay inside the 06:00–20:00 duty window", () => {
    expect(nextDutyDeparture(0)).toBe(6 * HOUR);
    expect(nextDutyDeparture(7.5 * HOUR)).toBe(7.5 * HOUR);
    expect(nextDutyDeparture(20 * HOUR)).toBe(GAME_DAY_MS + 6 * HOUR);
    expect(nextDutyDeparture(GAME_DAY_MS - 1)).toBe(GAME_DAY_MS + 6 * HOUR);
  });

  it("P&L rows sum in cents", () => {
    const rows = addPilotPnl(addPilotPnl([], 0, { wages: 7_500 }), 0, {
      income: 0.1,
      fuel: 0.2,
      fees: 0.1,
      legs: 1,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.net).toBe(-7_500.2);
  });
});

describe("hire, assign, operate", () => {
  it("hiring pays the first month's wage; the payroll is capped", () => {
    const book = newBook();
    const r = book.hirePilot("turboprop");
    expect(r.ok).toBe(true);
    expect(book.company.cash).toBe(242_500);
    const c = book.drain();
    expect(c.ledger.map((e) => [e.category, e.amount, e.refType, e.refId])).toEqual([
      ["pilot_wage", -7_500, "pilot", "HP-1"],
    ]);
    expect(c.pilots).toHaveLength(1);
    for (let i = 1; i < HIRED_PILOTS.maxPilots; i++)
      expect(book.hirePilot("turboprop").ok).toBe(true);
    const over = book.hirePilot("turboprop");
    expect(over.ok ? "" : over.code).toBe("pilot_limit");
    const poor = newBook({ cash: 1_000 }).hirePilot("jet");
    expect(poor.ok ? "" : poor.code).toBe("insufficient_cash");
  });

  it("a day on KMEM–KATL: income, fuel and fees in the ledger, wear on the aircraft", () => {
    const { book, starter, pilotId } = routeBook();
    const log = collect(book);
    log.drain();
    expect(book.aircraft(starter.id)?.status).toBe("hired");
    book.advance(GAME_DAY_MS);
    log.drain();
    const rows = log.ledger.filter((e) => e.category !== "pilot_wage");
    // Four legs (06:00, 10:12, 14:24, 18:36 departures; 132 min block + 120 min turnaround).
    expect(rows.map((e) => [e.gameMs / HOUR, e.category, e.amount])).toEqual([
      [8.2, "hired_income", 3_557.5],
      [8.2, "fuel", -716.21],
      [8.2, "landing_fee", -300],
      [12.4, "hired_income", 3_184.5],
      [12.4, "fuel", -728.55],
      [12.4, "landing_fee", -300],
      [16.6, "hired_income", 2_056.5],
      [16.6, "fuel", -716.21],
      [16.6, "landing_fee", -300],
      [20.8, "hired_income", 3_010.5],
      [20.8, "fuel", -728.55],
      [20.8, "landing_fee", -300],
    ]);
    expectBalanced(book, log.ledger);
    const p = book.pilotsDomain(["KATL"]).pilots[0];
    expect(p?.simulated).toBe(true);
    expect(p?.legsFlown).toBe(4);
    expect(p?.status).toBe("scheduled");
    expect(p?.assignment?.nextDepartureGameMs).toBe(GAME_DAY_MS + 6 * HOUR);
    expect(p?.pnl[0]).toMatchObject({
      month: 0,
      income: 11_809,
      wages: 7_500,
      fuel: 2_889.52,
      fees: 1_200,
      net: 219.48,
      legs: 4,
      wear: 3.72,
    });
    expect(book.company.cash).toBe(250_219.48);
    // The airframe flew: hours, cycles and wear, back at KMEM, still assigned.
    const a = book.aircraft(starter.id);
    expect(a?.cycles).toBe(4);
    // 112 airborne minutes = 1.87 h a leg (hours are kept to 0.01).
    expect(a?.hours).toBe(7.48);
    expect(a?.condition).toBeCloseTo(100 - 3.72, 2);
    expect(a?.location).toBe("KMEM");
    expect(a?.status).toBe("hired");
    // Never the player's own flying: no flight hours, deliveries, streak or milestones.
    expect(book.company.flightHours).toBe(0);
    expect(book.company.deliveries).toBe(0);
    expect(book.company.landingStreak).toBe(0);
    expect(book.company.milestones).toEqual([]);
    expect(pilotId).toBe("HP-1");
  });

  it("is deterministic: the same seed books the same legs to the cent", () => {
    const run = () => {
      const { book } = routeBook();
      const log = collect(book);
      book.advance(3 * GAME_DAY_MS);
      log.drain();
      return { ledger: log.ledger, pilots: book.pilotsDomain(["KATL"]), cash: book.company.cash };
    };
    expect(run()).toEqual(run());
  });

  it("the aircraft is unavailable to the player while assigned", () => {
    const { book, starter, pilotId } = routeBook();
    const sell = book.sell(starter.id);
    expect(sell.ok ? "" : sell.code).toBe("aircraft_busy");
    expect(sell.ok ? "" : sell.message).toMatch(/hired pilot/);
    const repair = book.repair(starter.id);
    expect(repair.ok ? "" : repair.code).toBe("aircraft_busy");
    const permit = book.ferryPermit(starter.id);
    expect(permit.ok ? "" : permit.code).toBe("aircraft_busy");
    // A second pilot cannot take it either.
    const second = book.hirePilot("turboprop");
    expect(second.ok).toBe(true);
    const r = book.assignPilot({
      pilotId: "HP-2",
      aircraftId: starter.id,
      destination: "KATL",
      served: ["KATL"],
    });
    expect(r.ok ? "" : r.code).toBe("aircraft_busy");
    // Unassigned: available again where it is.
    expect(book.unassignPilot(pilotId).ok).toBe(true);
    expect(book.aircraft(starter.id)?.status).toBe("available");
  });

  it("refuses leased, unrated, unserved, out-of-range and unairworthy assignments", () => {
    const book = newBook({ cash: 5_000_000 });
    const starter = book.ensureStarter();
    if (!starter) throw new Error("no starter");
    book.hirePilot("turboprop");
    book.hirePilot("jet");
    const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
    const lease = book.lease({ typeKey: "kodiak100", kind: "dry", airport: "KMEM" });
    if (!lease.ok) throw new Error(lease.message);
    const base = { pilotId: "HP-1", destination: "KATL", served: ["KATL", "KLAX"] };
    expect(code(book.assignPilot({ ...base, aircraftId: lease.data.id }))).toBe("not_owned");
    expect(code(book.assignPilot({ ...base, pilotId: "HP-2", aircraftId: starter.id }))).toBe(
      "rating_mismatch",
    );
    expect(code(book.assignPilot({ ...base, aircraftId: starter.id, served: [] }))).toBe(
      "airport_not_served",
    );
    expect(code(book.assignPilot({ ...base, aircraftId: starter.id, destination: "KMEM" }))).toBe(
      "same_airport",
    );
    expect(code(book.assignPilot({ ...base, aircraftId: starter.id, destination: "KLAX" }))).toBe(
      "out_of_range",
    );
    expect(code(book.assignPilot({ ...base, aircraftId: starter.id, origin: "KBNA" }))).toBe(
      "aircraft_not_at_origin",
    );
    expect(code(book.assignPilot({ ...base, pilotId: "HP-9", aircraftId: starter.id }))).toBe(
      "unknown_pilot",
    );
    // Grounded: a grounding defect fails the dispatch gate.
    book.updateAircraft(starter.id, { defects: [defect("grounding")] });
    expect(code(book.assignPilot({ ...base, aircraftId: starter.id }))).toBe(
      "aircraft_unairworthy",
    );
    // In maintenance.
    book.updateAircraft(starter.id, { defects: [], status: "maintenance" });
    expect(code(book.assignPilot({ ...base, aircraftId: starter.id }))).toBe(
      "aircraft_in_maintenance",
    );
    book.updateAircraft(starter.id, { status: "available" });
    expect(code(book.assignPilot({ ...base, aircraftId: starter.id }))).toBe("ok");
    expect(code(book.assignPilot({ ...base, aircraftId: starter.id }))).toBe("pilot_assigned");
  });

  it("a defect found at departure stops the route before the leg", () => {
    const { book, starter, pilotId } = routeBook();
    const log = collect(book);
    log.drain();
    book.updateAircraft(starter.id, { defects: [defect("grounding", "gear")] });
    book.advance(7 * HOUR);
    log.drain();
    const p = book.pilotsDomain().pilots[0];
    expect(p?.status).toBe("unassigned");
    expect(p?.stopped?.code).toBe("aircraft_unairworthy");
    expect(book.aircraft(starter.id)?.status).toBe("available");
    expect(log.ledger.filter((e) => e.category === "hired_income")).toEqual([]);
    const stop = log.notices.find((n) => n.name === "pilot.route_stopped");
    expect(stop?.data).toMatchObject({ pilotId, code: "aircraft_unairworthy", simulated: true });
  });

  it("a grounding defect found during operation grounds the aircraft and stops the route", () => {
    // Every system just above the 30 % wear threshold: the first leg crosses it, and the
    // seeded roll finds a grounding defect for most seeds. Use the first seed that does.
    let found = false;
    for (let seed = 1; seed <= 40 && !found; seed++) {
      const { book, starter } = routeBook(seed);
      book.updateAircraft(starter.id, { systems: systemsFromCondition(30.01) });
      const log = collect(book);
      log.drain();
      book.advance(9 * HOUR);
      log.drain();
      if (!log.notices.some((n) => n.name === "pilot.route_stopped")) continue;
      found = true;
      const a = book.aircraft(starter.id);
      expect(a?.defects.some((d) => d.severity === "grounding")).toBe(true);
      expect(a?.status).toBe("available");
      expect(a?.location).toBe("KATL");
      const p = book.pilotsDomain().pilots[0];
      expect(p?.stopped?.code).toBe("aircraft_grounded");
      expect(p?.assignment).toBeNull();
      expect(p?.legsFlown).toBe(1);
      expect(log.notices.map((n) => n.name)).toContain("aircraft.grounded");
      // The leg that found it was still booked; nothing after it.
      expect(log.ledger.filter((e) => e.category === "hired_income")).toHaveLength(1);
      book.advance(GAME_DAY_MS);
      log.drain();
      expect(log.ledger.filter((e) => e.category === "hired_income")).toHaveLength(1);
      expectBalanced(book, log.ledger);
    }
    expect(found).toBe(true);
  });

  it("unassigning mid-leg cancels the leg: nothing booked, the aircraft stays at its departure airport", () => {
    const { book, starter, pilotId } = routeBook();
    const log = collect(book);
    log.drain();
    book.advance(7 * HOUR);
    expect(book.pilotsDomain().pilots[0]?.status).toBe("flying");
    expect(book.unassignPilot(pilotId).ok).toBe(true);
    book.advance(GAME_DAY_MS);
    log.drain();
    expect(log.ledger.map((e) => e.category)).toEqual(["pilot_wage"]);
    const a = book.aircraft(starter.id);
    expect(a?.status).toBe("available");
    expect(a?.location).toBe("KMEM");
    expect(a?.cycles).toBe(0);
  });

  it("firing releases the aircraft, refunds nothing and stops the wages", () => {
    const { book, starter, pilotId } = routeBook();
    const log = collect(book);
    expect(book.firePilot(pilotId).ok).toBe(true);
    expect(book.aircraft(starter.id)?.status).toBe("available");
    // Still listed this month (marked fired) for its P&L; gone once the month is over.
    expect(book.pilotsDomain().pilots.map((p) => [p.id, p.status, p.assignment])).toEqual([
      [pilotId, "fired", null],
    ]);
    book.advance(2 * GAME_MONTH_MS);
    log.drain();
    expect(log.ledger.filter((e) => e.category === "pilot_wage")).toHaveLength(1);
    const again = book.firePilot(pilotId);
    expect(again.ok ? "" : again.code).toBe("unknown_pilot");
  });

  it("month rollover bills every hired pilot's wage; the ledger balances to the cent", () => {
    const book = newBook();
    book.ensureStarter();
    const log = collect(book);
    book.hirePilot("turboprop");
    book.hirePilot("jet");
    book.advance(2 * GAME_MONTH_MS + HOUR);
    log.drain();
    const wages = log.ledger.filter((e) => e.category === "pilot_wage");
    expect(wages.map((e) => [Math.floor(e.gameMs / GAME_MONTH_MS), e.amount])).toEqual([
      [0, -7_500],
      [0, -14_000],
      [1, -7_500],
      [1, -14_000],
      [2, -7_500],
      [2, -14_000],
    ]);
    const pilots = book.pilotsDomain().pilots;
    expect(pilots.map((p) => p.pnl.map((m) => [m.month, m.wages, m.net]))).toEqual([
      [
        [0, 7_500, -7_500],
        [1, 7_500, -7_500],
        [2, 7_500, -7_500],
      ],
      [
        [0, 14_000, -14_000],
        [1, 14_000, -14_000],
        [2, 14_000, -14_000],
      ],
    ]);
    // Wages are operating expenses (the company P&L counts them).
    expect(book.ledgerDomain().months.find((m) => m.month === 1)?.expense).toBe(21_500);
    expectBalanced(book, log.ledger);
  });

  it("a long run: the route keeps the ledger balanced and stops when the aircraft wears out", () => {
    const { book, starter } = routeBook();
    const log = collect(book);
    book.advance(40 * GAME_DAY_MS);
    log.drain();
    expectBalanced(book, log.ledger);
    const p = book.pilotsDomain().pilots[0];
    // Wear (≈ 3.7 points a day) and its defects end the route within the 40 days.
    expect(p?.assignment).toBeNull();
    expect(p?.stopped).toBeDefined();
    expect(book.aircraft(starter.id)?.status).toBe("available");
    // Σ pilot P&L (cash lines) = Σ ledger rows booked for the pilot.
    const income = log.ledger
      .filter((e) => e.category === "hired_income")
      .reduce((s, e) => s + cents(e.amount), 0);
    const pnlIncome = (p?.pnl ?? []).reduce((s, m) => s + cents(m.income), 0);
    expect(pnlIncome).toBe(income);
    expect(book.company.flightHours).toBe(0);
  });

  it("an aircraft left hired without a pilot (inconsistent import) loads as available", () => {
    const book = newBook();
    const a = book.ensureStarter();
    if (!a) throw new Error("no starter");
    const again = new CompanyBook({
      company: book.company,
      fleet: [{ ...a, status: "hired" }],
      airports: lookup,
      now: () => NOW,
    });
    expect(again.aircraft(a.id)?.status).toBe("available");
  });

  it("the domain offers owned, available, airworthy aircraft with served destinations", () => {
    const book = newBook();
    const starter = book.ensureStarter();
    if (!starter) throw new Error("no starter");
    const d = book.pilotsDomain(["KATL", "KBNA", "KLAX"]);
    expect(d.simulated).toBe(true);
    expect(d.servedAirports).toEqual(["KATL", "KBNA", "KLAX", "KMEM"]);
    const opt = d.options.find((o) => o.aircraftId === starter.id);
    expect(opt?.origin).toBe("KMEM");
    // KLAX is beyond 80 % of the C208B's range.
    expect(opt?.destinations.map((x) => x.icao)).toEqual(["KATL", "KBNA"]);
    const katl = opt?.destinations.find((x) => x.icao === "KATL");
    expect(katl).toMatchObject({ distanceNm: 287.7, blockMin: 132, income: 2_803 });
    expect(d.wages).toEqual({ turboprop: 7_500, jet: 14_000 });
  });
});

describe("verifier fixes", () => {
  it("a hired aircraft refuses deferrals, insurance buy/cancel and loan collateral", () => {
    const book = newBook({ cash: 5_000_000 });
    const starter = book.ensureStarter();
    if (!starter) throw new Error("no starter");
    expect(book.buyInsurance(starter.id).ok).toBe(true);
    book.hirePilot("turboprop");
    const assigned = book.assignPilot({
      pilotId: "HP-1",
      aircraftId: starter.id,
      destination: "KATL",
      served: ["KATL"],
    });
    expect(assigned.ok).toBe(true);
    const code = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);
    book.updateAircraft(starter.id, { defects: [defect("minor", "avionics")] });
    expect(code(book.defer(starter.id, "D-minor-avionics"))).toBe("aircraft_busy");
    expect(code(book.cancelInsurance(starter.id))).toBe("aircraft_busy");
    expect(
      code(
        book.takeLoan({
          lenderId: "jetwash",
          principal: 100_000,
          termMonths: 24,
          collateral: { type: "aircraft", id: starter.id },
        }),
      ),
    ).toBe("aircraft_busy");
    // Uninsured and hired: buying a policy is refused too.
    expect(book.unassignPilot("HP-1").ok).toBe(true);
    expect(book.cancelInsurance(starter.id).ok).toBe(true);
    book.updateAircraft(starter.id, { defects: [] });
    expect(
      book.assignPilot({
        pilotId: "HP-1",
        aircraftId: starter.id,
        destination: "KATL",
        served: ["KATL"],
      }).ok,
    ).toBe(true);
    expect(code(book.buyInsurance(starter.id))).toBe("aircraft_busy");
  });

  it("the first month's wage is pro-rated by the time left in the in-game month (cents)", () => {
    // Day 20 of 30: a third of the month is left → $7,500 × 1/3 = $2,500.00.
    const book = newBook();
    const log = collect(book);
    book.advance(20 * GAME_DAY_MS);
    log.drain();
    expect(book.hirePilot("turboprop").ok).toBe(true);
    // One minute before the boundary: 7,500 × 60,000 / 2,592,000,000 = $0.17.
    book.advance(10 * GAME_DAY_MS - 60_000);
    expect(book.hirePilot("turboprop").ok).toBe(true);
    book.advance(2 * 60_000);
    log.drain();
    const wages = log.ledger.filter((e) => e.category === "pilot_wage");
    expect(wages.map((e) => e.amount)).toEqual([-2_500, -0.17, -7_500, -7_500]);
    const pilots = book.pilotsDomain().pilots;
    expect(pilots[1]?.pnl.map((m) => [m.month, m.wages])).toEqual([
      [0, 0.17],
      [1, 7_500],
    ]);
    expectBalanced(book, log.ledger);
  });

  it("repossession stops the route at once with pilot.route_stopped", () => {
    const book = newBook();
    const starter = book.ensureStarter();
    if (!starter) throw new Error("no starter");
    const loan = book.takeLoan({
      lenderId: "jetwash",
      principal: 500_000,
      termMonths: 24,
      collateral: { type: "aircraft", id: starter.id },
    });
    if (!loan.ok) throw new Error(loan.message);
    book.hirePilot("turboprop");
    // No cash: every payment is missed; the third miss (month 3) repossesses.
    book.post("adjustment", -book.company.cash);
    book.advance(3 * GAME_MONTH_MS - HOUR);
    const assigned = book.assignPilot({
      pilotId: "HP-1",
      aircraftId: starter.id,
      destination: "KATL",
      served: ["KATL"],
    });
    expect(assigned.ok).toBe(true);
    const log = collect(book);
    log.drain();
    book.advance(2 * HOUR);
    log.drain();
    expect(log.notices.map((n) => n.name)).toContain("aircraft.repossessed");
    const stop = log.notices.find((n) => n.name === "pilot.route_stopped");
    expect(stop?.data).toMatchObject({ pilotId: "HP-1", code: "aircraft_repossessed" });
    const p = book.pilotsDomain().pilots[0];
    expect(p?.status).toBe("unassigned");
    expect(p?.stopped?.gameMs).toBe(3 * GAME_MONTH_MS);
  });

  it("the domain sums this month over every pilot and keeps a fired pilot's month visible", () => {
    const book = newBook();
    book.hirePilot("turboprop");
    book.hirePilot("jet");
    expect(book.firePilot("HP-2").ok).toBe(true);
    const d = book.pilotsDomain();
    expect(d.monthCosts).toBe(21_500);
    expect(d.pilots.map((p) => [p.id, p.status])).toEqual([
      ["HP-1", "unassigned"],
      ["HP-2", "fired"],
    ]);
    // Next month the fired pilot has no row any more and leaves the list.
    book.advance(GAME_MONTH_MS);
    const next = book.pilotsDomain();
    expect(next.pilots.map((p) => p.id)).toEqual(["HP-1"]);
    expect(next.monthCosts).toBe(7_500);
  });

  it("load repairs invalid assignments: a pilot on a non-hired aircraft or a second pilot on one aircraft is unassigned", () => {
    const { book, starter } = routeBook();
    book.hirePilot("turboprop");
    book.drain();
    const [first, other] = book.pilotRecords();
    if (!first?.assignment || !other) throw new Error("no assignment");
    const second = { ...other, assignment: { ...first.assignment } };
    const plane = book.aircraft(starter.id);
    if (!plane) throw new Error("no aircraft");
    const reload = (status: "hired" | "available") =>
      new CompanyBook({
        company: book.company,
        fleet: [{ ...plane, status }],
        pilots: [first, second],
        airports: lookup,
        now: () => NOW,
      });
    // Two pilots on one aircraft: the first keeps it, the second is unassigned.
    const two = reload("hired");
    const d = two.pilotsDomain();
    expect(d.pilots.map((p) => [p.id, p.status])).toEqual([
      ["HP-1", "scheduled"],
      ["HP-2", "unassigned"],
    ]);
    expect(d.pilots[1]?.stopped?.code).toBe("assignment_invalid");
    expect(two.aircraft(starter.id)?.status).toBe("hired");
    // A pilot on an aircraft that is not marked hired: unassigned, the aircraft stays available.
    const none = reload("available");
    expect(none.pilotsDomain().pilots.map((p) => p.status)).toEqual(["unassigned", "unassigned"]);
    expect(none.aircraft(starter.id)?.status).toBe("available");
    expect(none.drain().pilots).toHaveLength(2);
  });
});
