// P5 used aircraft and airworthiness: systems and the derived condition, wear distribution,
// defect cost/time, the gate (grounding, deferral, systems, annual by months and by hours),
// ferry permits, repairs on in-game time, the used market (listing price, inspection reveal,
// the uninspected hidden grounding roll), defect rolls after hard landings, overspeed, fuel
// exhaustion and crashes, and resale. Worked examples match docs/ECONOMY.md ("P5").

import { describe, expect, it } from "vitest";
import {
  SYSTEM_KEYS,
  aircraftTypeByKey,
  type AircraftType,
  type Defect,
} from "@cargo-ops/protocol";
import {
  ANNUAL_INTERVAL_MS,
  CompanyBook,
  GAME_DAY_MS,
  GAME_YEAR_MS,
  Rng,
  SALE_SHARE,
  airportLookup,
  airworthinessGate,
  annualDue,
  annualQuote,
  askingPrice,
  buildDemoCompany,
  completeInspection,
  defectDowntimeHours,
  defectRepairCost,
  deferralHoursLeft,
  derivedCondition,
  distributeWear,
  ferryEligible,
  ferryPayloadCapKg,
  ferryPermitFee,
  flightWear,
  generateMarket,
  inspectionFee,
  listingState,
  makeDefect,
  marketValue,
  nearestMaintenanceAirport,
  largeAirportMaintenance,
  newCompanyCore,
  purchaseHiddenChance,
  purchaseHiddenRoll,
  repairQuote,
  rollFlightDefects,
  systemsFromCondition,
  tanksDryThresholdLb,
  uninspectedHasHiddenGrounding,
  usedValue,
  type BookAircraft,
  type BookNotice,
  type CompanyCore,
  type GateInput,
  type ListingRecord,
  type SystemConditions,
} from "../src/index";
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

function defect(
  severity: Defect["severity"],
  system: Defect["system"] = "engines",
  extra: Partial<Defect> = {},
): Defect {
  return {
    id: `D-${severity}-${system}`,
    system,
    severity,
    title: `${severity} ${system}`,
    repairCost: 1_000,
    downtimeHours: 4,
    hidden: false,
    cause: "listing",
    ...extra,
  };
}

function gateInput(over: Partial<GateInput> = {}): GateInput {
  return {
    systems: systemsFromCondition(90),
    defects: [],
    hours: 50,
    annual: { lastGameMs: 0, lastHours: 0 },
    ferryPermit: null,
    ...over,
  };
}

const notices = (list: BookNotice[], name: string) => list.filter((n) => n.name === name);

describe("systems and the derived condition", () => {
  it("weights sum to 1: a P4 condition maps onto every system and back", () => {
    for (const c of [100, 97.5, 99.12, 19.5, 0]) {
      expect(derivedCondition(systemsFromCondition(c))).toBe(c);
    }
  });

  it("wear lands on the systems and the weighted mean drops by exactly the P4 wear", () => {
    // 150 min, 1.85 G, one overspeed: 1.25 + 3 + 5 = 9.25 points (docs P4 example).
    const w = flightWear({ airborneMin: 150, peakG: 1.85, overspeedEvents: 1, crashed: false });
    expect(w.total).toBe(9.25);
    const after = distributeWear(systemsFromCondition(100), w);
    // Even: 1.25 + 0.5 × 3 + 0.5 × 5 = 5.25; gear + 1.5 / 0.32 = 4.6875; airframe + 4.6875 + 12.5.
    expect(after.engines).toBe(94.75);
    expect(after.gear).toBe(90.06);
    expect(after.airframe).toBe(77.56);
    expect(derivedCondition(after)).toBe(90.75);
    // Hours only (the replay: 106.1 min → 0.88) is spread evenly.
    const h = distributeWear(systemsFromCondition(100), {
      hours: 0.88,
      g: 0,
      overspeed: 0,
      crash: 0,
    });
    expect(SYSTEM_KEYS.every((k) => h[k] === 99.12)).toBe(true);
    expect(derivedCondition(h)).toBe(99.12);
  });
});

describe("defect cost and downtime", () => {
  it("cost ∝ catalogue price × severity × system × rarity; field repairs ×1.35 cost ×1.5 time", () => {
    const c208 = type("c208b");
    expect(defectRepairCost(c208, "grounding", "engines")).toBe(108_000); // 2.7M × 2.5 % × 1.6
    expect(defectDowntimeHours("grounding", "engines")).toBe(90); // 60 × 1.5
    expect(defectRepairCost(c208, "major", "engines")).toBe(34_560); // 2.7M × 0.8 % × 1.6
    expect(defectRepairCost(c208, "minor", "gear")).toBe(4_860); // 2.7M × 0.2 % × 0.9
    expect(defectRepairCost(c208, "cosmetic", "interior")).toBe(432); // 2.7M × 0.04 % × 0.4
    // Rare type: PC-6 parts × 1.25.
    expect(defectRepairCost(type("pc6"), "grounding", "engines")).toBe(115_000);
    const d = [
      { repairCost: 108_000, downtimeHours: 90 },
      { repairCost: 4_860, downtimeHours: 8 },
    ];
    expect(repairQuote(d, "maintenance")).toEqual({ cost: 112_860, hours: 98 });
    expect(repairQuote(d, "field")).toEqual({ cost: 152_361, hours: 147 });
  });

  it("major defects roll 5–15 % fuel burn and payload; minors burn 1 %", () => {
    const rng = new Rng(7);
    for (let i = 0; i < 50; i++) {
      const m = makeDefect(rng, {
        id: `m${i}`,
        system: "engines",
        severity: "major",
        cause: "wear",
        hidden: false,
        type: type("c208b"),
      });
      expect(m.fuelBurnPct).toBeGreaterThanOrEqual(5);
      expect(m.fuelBurnPct).toBeLessThanOrEqual(15);
      expect(m.payloadPct).toBeGreaterThanOrEqual(5);
      expect(m.payloadPct).toBeLessThanOrEqual(15);
    }
    const minor = makeDefect(rng, {
      id: "n",
      system: "fuel",
      severity: "minor",
      cause: "wear",
      hidden: false,
      type: type("c208b"),
    });
    expect(minor.fuelBurnPct).toBe(1);
    expect(minor.payloadPct).toBeUndefined();
  });
});

describe("airworthiness gate", () => {
  it("airworthy with a current annual and no blocking defect", () => {
    const g = airworthinessGate(gateInput({ defects: [defect("cosmetic"), defect("major")] }), 0);
    expect(g.ok).toBe(true);
    expect(g.status).toBe("airworthy");
    expect(g.reasons).toEqual([]);
  });

  it("lists every blocking reason", () => {
    const systems: SystemConditions = { ...systemsFromCondition(80), gear: 19.5 };
    const g = airworthinessGate(
      gateInput({
        systems,
        hours: 120,
        defects: [
          defect("grounding", "engines"),
          defect("minor", "avionics"),
          defect("minor", "fuel", { deferredAtHours: 80 }),
          defect("grounding", "airframe", { hidden: true }),
        ],
      }),
      0,
    );
    expect(g.ok).toBe(false);
    expect(g.status).toBe("grounded");
    expect(g.reasons.map((r) => r.code)).toEqual([
      "grounding_defect",
      "minor_not_deferred",
      "deferral_expired",
      "system_below_minimum",
      "annual_due",
    ]);
    // Hidden defects are not seen by the gate.
    expect(g.reasons.filter((r) => r.code === "grounding_defect")).toHaveLength(1);
  });

  it("deferral: a minor defect flies for 30 flight hours after it is deferred", () => {
    const d = defect("minor", "fuel", { deferredAtHours: 10 });
    expect(deferralHoursLeft(d, 10)).toBe(30);
    expect(deferralHoursLeft(d, 40)).toBe(0);
    expect(deferralHoursLeft(d, 40.5)).toBe(-0.5);
    expect(deferralHoursLeft(defect("major"), 40)).toBeNull();
    const ok = airworthinessGate(gateInput({ hours: 40, defects: [d] }), 0);
    expect(ok.ok).toBe(true);
    const late = airworthinessGate(gateInput({ hours: 40.5, defects: [d] }), 0);
    expect(late.reasons.map((r) => r.code)).toEqual(["deferral_expired"]);
  });

  it("annual due after 12 in-game months or 100 flight hours, whichever first", () => {
    const last = { lastGameMs: 0, lastHours: 0 };
    expect(annualDue(last, 99.9, ANNUAL_INTERVAL_MS - 1).due).toBe(false);
    expect(annualDue(last, 100, 0).due).toBe(true);
    expect(annualDue(last, 0, ANNUAL_INTERVAL_MS).due).toBe(true);
    expect(annualDue(last, 90, 0).soon).toBe(true); // within 10 h
    expect(annualDue(last, 0, ANNUAL_INTERVAL_MS - 30 * GAME_DAY_MS).soon).toBe(true);
    expect(annualDue(last, 0, 0).soon).toBe(false);
    const byHours = airworthinessGate(gateInput({ hours: 100 }), 0);
    expect(byHours.status).toBe("annual_due");
    const byTime = airworthinessGate(gateInput({ hours: 0 }), ANNUAL_INTERVAL_MS);
    expect(byTime.reasons.map((r) => r.code)).toEqual(["annual_due"]);
    // Cost 0.4 % of price × rarity × shop; downtime by category × shop.
    expect(annualQuote(type("c208b"), "maintenance")).toEqual({ cost: 10_800, hours: 16 });
    expect(annualQuote(type("c208b"), "field")).toEqual({ cost: 14_580, hours: 24 });
    expect(annualQuote(type("pc6"), "maintenance").cost).toBe(11_500);
  });

  it("penalties: minor 1 % fuel each, majors their rolled share, payload capped at 30 %", () => {
    const g = airworthinessGate(
      gateInput({
        defects: [
          defect("minor", "fuel", { fuelBurnPct: 1, deferredAtHours: 50 }),
          defect("major", "engines", { fuelBurnPct: 12, payloadPct: 15 }),
          defect("major", "airframe", { fuelBurnPct: 6, payloadPct: 14 }),
          defect("major", "gear", { fuelBurnPct: 5, payloadPct: 9, hidden: true }),
        ],
      }),
      0,
    );
    expect(g.fuelPenaltyPct).toBe(19);
    expect(g.payloadPenaltyPct).toBe(29);
  });
});

describe("ferry permits", () => {
  it("eligible without a grounding defect, systems ≥ 10 % and a reason to ferry", () => {
    const annual = gateInput({ hours: 100 });
    expect(ferryEligible(annual, airworthinessGate(annual, 0))).toBe(true);
    const major = gateInput({ defects: [defect("major")] });
    expect(ferryEligible(major, airworthinessGate(major, 0))).toBe(true);
    const fine = gateInput();
    expect(ferryEligible(fine, airworthinessGate(fine, 0))).toBe(false);
    const grounding = gateInput({ defects: [defect("grounding")] });
    expect(ferryEligible(grounding, airworthinessGate(grounding, 0))).toBe(false);
    const wreck = gateInput({ systems: { ...systemsFromCondition(80), airframe: 9 } });
    expect(ferryEligible(wreck, airworthinessGate(wreck, 0))).toBe(false);
    const low = gateInput({ systems: { ...systemsFromCondition(80), airframe: 15 } });
    expect(ferryEligible(low, airworthinessGate(low, 0))).toBe(true);
  });

  it("fee, payload cap and the nearest maintenance-capable (large) airport", () => {
    expect(ferryPermitFee(type("c208b"))).toBe(400);
    expect(ferryPermitFee(type("b738bcf"))).toBe(3_200);
    expect(ferryPayloadCapKg(type("c208b"))).toBe(136);
    const cap = largeAirportMaintenance(lookup);
    expect(cap.isMaintenanceCapable("KATL")).toBe(true);
    expect(cap.isMaintenanceCapable("KLIT")).toBe(false);
    const from = lookup.get("KLIT");
    if (!from) throw new Error("KLIT");
    const near = nearestMaintenanceAirport(from, lookup.list, cap);
    expect(near?.airport.type).toBe("large");
    expect(near?.airport.ident).toBe("KMEM");
  });

  it("book: permit issued at a medium airport, refused at a large one or with a grounding defect", () => {
    const book = newBook();
    const a = book.ensureStarter();
    if (!a) throw new Error("starter");
    expect(book.ferryPermit(a.id)).toMatchObject({ ok: false, code: "ferry_not_allowed" });
    book.updateAircraft(a.id, { annual: { lastGameMs: 0, lastHours: -100 } });
    expect(book.ferryPermit(a.id)).toMatchObject({ ok: false, code: "at_maintenance_airport" });
    book.updateAircraft(a.id, { location: "KLIT" });
    const permit = book.ferryPermit(a.id);
    expect(permit).toMatchObject({
      ok: true,
      data: { origin: "KLIT", destination: "KMEM", payloadCapKg: 136, fee: 400 },
    });
    expect(book.company.cash).toBe(249_600);
    expect(
      book.fleetDomain({
        id: a.id,
        source: "single",
        ambiguous: false,
        candidates: [],
        matchedTypeKey: null,
      }).aircraft[0]?.airworthiness?.status,
    ).toBe("ferry_only");
    expect(book.ferryPermit(a.id)).toMatchObject({ ok: false, code: "permit_active" });
    book.consumeFerryPermit(a.id);
    book.updateAircraft(a.id, { defects: [defect("grounding")] });
    expect(book.ferryPermit(a.id)).toMatchObject({ ok: false, code: "ferry_not_allowed" });
  });
});

describe("repairs on in-game time", () => {
  it("orders queue back to back; completion removes the defects; annual resets the clock", () => {
    const book = newBook({ cash: 1_000_000 });
    const a = book.ensureStarter();
    if (!a) throw new Error("starter");
    const c208 = type("c208b");
    const eng = makeDefect(new Rng(1), {
      id: "AC-1-D1",
      system: "engines",
      severity: "grounding",
      cause: "wear",
      hidden: false,
      type: c208,
    });
    const gear = makeDefect(new Rng(2), {
      id: "AC-1-D2",
      system: "gear",
      severity: "minor",
      cause: "wear",
      hidden: false,
      type: c208,
    });
    book.updateAircraft(a.id, { defects: [eng, gear], defectCounter: 2 });
    book.drain();
    // KMEM is large: maintenance rates. Engine grounding $108,000 / 90 h.
    const r1 = book.repairDefect(a.id, eng.id);
    expect(r1).toMatchObject({ ok: true, data: { order: { cost: 108_000, hours: 90 } } });
    expect(book.repairDefect(a.id, eng.id)).toMatchObject({ ok: false, code: "already_queued" });
    // The gear minor queues behind it: starts at 90 h, ready at 98 h.
    const r2 = book.repairAll(a.id);
    if (!r1.ok || !r2.ok) throw new Error("orders");
    expect(r2.data.order.startGameMs).toBe(90 * HOUR);
    expect(r2.data.order.readyAtGameMs).toBe(98 * HOUR);
    expect(book.aircraft(a.id)?.status).toBe("maintenance");
    expect(book.repairAll(a.id)).toMatchObject({ ok: false, code: "no_defects" });
    book.advance(90 * HOUR);
    expect(book.aircraft(a.id)?.defects.map((d) => d.id)).toEqual([gear.id]);
    expect(book.aircraft(a.id)?.status).toBe("maintenance");
    book.advance(8 * HOUR);
    expect(book.aircraft(a.id)?.defects).toEqual([]);
    expect(book.aircraft(a.id)?.status).toBe("available");
    expect(notices(book.drain().notices, "repair.completed")).toHaveLength(2);
    expect(book.company.cash).toBe(1_000_000 - 108_000 - 4_860);
    // Annual: $10,800, 16 h; completion records the date and hours.
    book.updateAircraft(a.id, { hours: 42 });
    const an = book.annualInspection(a.id);
    expect(an).toMatchObject({ ok: true, data: { order: { cost: 10_800, hours: 16 } } });
    book.advance(16 * HOUR);
    expect(book.aircraft(a.id)?.annual).toEqual({ lastGameMs: 114 * HOUR, lastHours: 42 });
    const n = book.drain().notices;
    expect(notices(n, "inspection.completed")[0]?.data).toMatchObject({ kind: "annual", found: 0 });
  });

  it("field repairs elsewhere; defer only minors; P4 overhaul unchanged", () => {
    const book = newBook({ cash: 1_000_000 });
    const a = book.ensureStarter();
    if (!a) throw new Error("starter");
    const minor = defect("minor", "gear", { id: "AC-1-D1", repairCost: 4_860, downtimeHours: 8 });
    const major = defect("major", "engines", {
      id: "AC-1-D2",
      repairCost: 34_560,
      downtimeHours: 36,
    });
    book.updateAircraft(a.id, { location: "KLIT", defects: [minor, major], hours: 12 });
    expect(book.defer(a.id, major.id)).toMatchObject({ ok: false, code: "not_deferrable" });
    expect(book.defer(a.id, minor.id)).toMatchObject({
      ok: true,
      data: { defect: { deferredAtHours: 12 } },
    });
    expect(book.defer(a.id, minor.id)).toMatchObject({ ok: false, code: "already_deferred" });
    expect(book.gate(book.aircraft(a.id) as BookAircraft).ok).toBe(true);
    const r = book.repairDefect(a.id, major.id);
    expect(r).toMatchObject({ ok: true, data: { order: { shop: "field", hours: 54 } } });
    if (r.ok) expect(r.data.order.cost).toBe(46_656); // 34,560 × 1.35
    // P4 wear overhaul: 8 % × price × wear, 2 h + 1.5 h × wear; all systems back to 100.
    const b2 = newBook({ cash: 1_000_000 });
    const s = b2.ensureStarter();
    if (!s) throw new Error("starter");
    b2.updateAircraft(s.id, { condition: 97.5 });
    expect(b2.repair(s.id)).toMatchObject({ ok: true, data: { cost: 5_400, hours: 5.75 } });
    b2.advance(5.75 * HOUR);
    expect(b2.aircraft(s.id)?.condition).toBe(100);
  });
});

describe("used market", () => {
  it("listing price: P4 value × age factor × (1 − defect discount) ± noise, to $500", () => {
    // C208B, 12 years, 6,000 h, condition 75 %, one known major engine defect ($34,560).
    const c208 = type("c208b");
    const v = usedValue(c208, {
      ageYears: 12,
      hours: 6_000,
      condition: 75,
      defects: [defect("major", "engines", { repairCost: 34_560 })],
    });
    expect(marketValue(c208, 6_000, 75)).toBe(2_197_800);
    expect(v.base).toBe(1_274_724); // × (1 − 12 × 3.5 %) = 0.58
    expect(v.defectDiscount).toBe(0.0542); // 2 × 34,560 / 1,274,724
    expect(v.value).toBe(1_205_633.96);
    expect(askingPrice(v.value, 0.03)).toBe(1_242_000);
    // Hidden defects are not priced in; a new airframe is worth the P4 value.
    const hidden = usedValue(c208, {
      ageYears: 12,
      hours: 6_000,
      condition: 75,
      defects: [defect("grounding", "engines", { hidden: true, repairCost: 108_000 })],
    });
    expect(hidden.defectDiscount).toBe(0);
    expect(usedValue(c208, { ageYears: 0, hours: 0, condition: 100, defects: [] }).value).toBe(
      2_700_000,
    );
    expect(inspectionFee(1_242_000)).toBe(6_210);
  });

  it("generation is seeded, typed and located on suitable airports; hidden defects stay hidden", () => {
    const input = {
      seed: 4242,
      generation: 1,
      airports: lookup.list,
      base: lookup.get("KMEM"),
      gameMs: 0,
    };
    const a = generateMarket(input);
    expect(generateMarket(input)).toEqual(a);
    expect(generateMarket({ ...input, generation: 2 })).not.toEqual(a);
    expect(a).toHaveLength(12);
    for (const l of a) {
      expect(lookup.get(l.location)).not.toBeNull();
      expect(l.ageYears).toBeGreaterThanOrEqual(1);
      expect(l.ageYears).toBeLessThanOrEqual(30);
      expect(l.askingPrice % 500).toBe(0);
      expect(l.sellerNote.length).toBeGreaterThan(5);
      const view = listingState(l, lookup.get("KMEM"), lookup.get(l.location));
      expect(view.knownDefects.every((d) => !d.hidden)).toBe(true);
      expect(view.knownDefects).toHaveLength(l.defects.filter((d) => !d.hidden).length);
      expect(JSON.stringify(view)).not.toContain('"hidden":true');
    }
  });

  it("inspection reveals the hidden defects; uninspected purchases roll a hidden grounding defect", () => {
    const listing: ListingRecord = {
      id: "UL-9-1",
      generation: 9,
      typeKey: "c208b",
      ageYears: 20,
      hours: 9_000,
      cycles: 9_900,
      location: "KLIT",
      systems: systemsFromCondition(70),
      defects: [
        defect("minor", "fuel", { id: "UL-9-1-D1" }),
        defect("grounding", "gear", { id: "UL-9-1-D2", hidden: true }),
      ],
      askingPrice: 900_000,
      sellerNote: "Lease return; sold as seen.",
      listedGameMs: 0,
      inspection: { status: "pending", fee: 4_500, readyAtGameMs: 24 * HOUR },
      status: "listed",
    };
    const done = completeInspection(listing, 24 * HOUR);
    expect(done.inspection).toMatchObject({ status: "done", found: 1 });
    expect(done.defects.every((d) => !d.hidden)).toBe(true);
    expect(done.defects[1]?.foundGameMs).toBe(24 * HOUR);
    // 8 % + 1.2 % per year, capped at 45 %.
    expect(purchaseHiddenChance(1)).toBeCloseTo(0.092, 10);
    expect(purchaseHiddenChance(20)).toBeCloseTo(0.32, 10);
    expect(purchaseHiddenChance(40)).toBe(0.45);
    expect(purchaseHiddenRoll(4242, done, "x")).toBeNull(); // inspected: no roll
    // Across many listings the uninspected roll hits about the documented share.
    let hits = 0;
    for (let i = 0; i < 2_000; i++) {
      const l = { ...listing, id: `UL-1-${i}`, inspection: { status: "none" as const, fee: 0 } };
      const d = purchaseHiddenRoll(4242, l, "x");
      if (d) {
        hits++;
        expect(d).toMatchObject({ severity: "grounding", hidden: true, cause: "purchase" });
      }
      expect(purchaseHiddenRoll(4242, l, "x")).toEqual(d); // seeded
    }
    expect(hits / 2_000).toBeGreaterThan(0.28);
    expect(hits / 2_000).toBeLessThan(0.36);
    expect(uninspectedHasHiddenGrounding(4242, listing)).toBe(true); // its own hidden one
  });

  it("book: inspect (fee, one day) → reveal; buy uninspected → hidden grounding surfaces on dispatch → repair → airworthy", () => {
    const book = newBook({ cash: 5_000_000, reputation: 50 });
    book.ensureStarter();
    book.ensureMarket();
    const market = book.marketDomain();
    expect(market.generation).toBe(1);
    expect(market.nextRefreshGameMs).toBe(7 * GAME_DAY_MS);
    // seed 4242 generation 1: UL-1-7, a 4-year-old C208B at KYNG, no known defects, whose
    // uninspected purchase rolls a hidden grounding defect.
    const rec = book.listingRecords().find((l) => l.id === "UL-1-7");
    expect(rec).toMatchObject({ typeKey: "c208b", ageYears: 4, location: "KYNG" });
    if (!rec) return;
    expect(uninspectedHasHiddenGrounding(4242, rec)).toBe(true);
    // Inspect another listing: 0.5 % fee, done after 24 in-game hours.
    const other = market.listings.find((l) => l.id === "UL-1-8");
    if (!other) throw new Error("UL-1-8");
    const insp = book.inspectListing(other.id);
    expect(insp).toMatchObject({ ok: true, data: { fee: other.inspection.fee } });
    expect(other.inspection.fee).toBe(inspectionFee(other.askingPrice));
    book.advance(24 * HOUR);
    const n = notices(book.drain().notices, "inspection.completed");
    expect(n[0]?.data).toMatchObject({ kind: "pre_purchase", listingId: "UL-1-8", found: 1 });
    expect(book.marketDomain().listings.find((l) => l.id === "UL-1-8")?.knownDefects.length).toBe(
      4,
    );
    // Buy UL-1-7 uninspected.
    const cash = book.company.cash;
    const bought = book.buyListing({ listingId: "UL-1-7" });
    if (!bought.ok) throw new Error(bought.message);
    const a = bought.data.aircraft;
    expect(bought.data.inspected).toBe(false);
    expect(book.company.cash).toBe(round2(cash - rec.askingPrice));
    expect(a).toMatchObject({ location: "KYNG", ageYears: 4, hours: rec.hours });
    expect(a.defects.filter((d) => d.hidden && d.severity === "grounding")).toHaveLength(1);
    expect(book.buyListing({ listingId: "UL-1-7" })).toMatchObject({
      ok: false,
      code: "unknown_listing",
    });
    // The browser view hides it: the aircraft looks airworthy until it is dispatched.
    expect(book.gate(a).ok).toBe(true);
    book.drain();
    const first = book.dispatchCheck(a.id);
    expect(first).toMatchObject({ ok: false, code: "aircraft_unairworthy" });
    if (first.ok) return;
    expect(first.reasons?.map((r) => r.code)).toEqual(["grounding_defect"]);
    const ev = book.drain().notices;
    expect(notices(ev, "defect.found")).toHaveLength(1);
    expect(notices(ev, "aircraft.grounded")).toHaveLength(1);
    const fix = book.repairAll(a.id);
    if (!fix.ok) throw new Error(fix.message);
    expect(fix.data.order.shop).toBe("field"); // KYNG is a medium airport
    expect(book.dispatchCheck(a.id).ok).toBe(false); // still grounded while in the shop
    book.advance(fix.data.order.hours * HOUR);
    expect(book.dispatchCheck(a.id).ok).toBe(true);
  });

  it("the market refreshes every 7 in-game days and keeps listings under inspection", () => {
    const book = newBook({ cash: 5_000_000 });
    book.ensureMarket();
    book.inspectListing("UL-1-3");
    book.advance(7 * GAME_DAY_MS);
    expect(book.company.marketGeneration).toBe(2);
    const ids = book.marketDomain().listings.map((l) => l.id);
    expect(ids).toContain("UL-1-3");
    expect(ids.filter((id) => id.startsWith("UL-2-"))).toHaveLength(12);
    expect(ids.filter((id) => id.startsWith("UL-1-"))).toEqual(["UL-1-3"]);
  });

  it("resale uses the same formula: fixing a bargain and reselling can pay; reputation unchanged", () => {
    const book = newBook({ cash: 5_000_000 });
    book.ensureMarket();
    // A grounded 26-year-old C208B (UL-1-8): $552,000 with a known grounding defect.
    const l = book.listingRecords().find((x) => x.id === "UL-1-8");
    if (!l) throw new Error("UL-1-8");
    book.inspectListing(l.id);
    book.advance(24 * HOUR);
    const r = book.buyListing({ listingId: l.id });
    if (!r.ok) throw new Error(r.message);
    const id = r.data.aircraft.id;
    const before = book.aircraftValue(book.aircraft(id) as BookAircraft);
    const fix = book.repairAll(id);
    if (!fix.ok) throw new Error(fix.message);
    book.advance(fix.data.order.hours * HOUR + 1);
    const after = book.aircraft(id) as BookAircraft;
    expect(after.defects).toEqual([]);
    const value = book.aircraftValue(after);
    expect(value).toBeGreaterThan(before);
    const type208 = type("c208b");
    const expected = usedValue(type208, {
      ageYears: book.ageNow(after),
      hours: after.hours,
      condition: after.condition,
      defects: [],
    }).value;
    expect(value).toBe(expected);
    const rep = book.company.reputation;
    const cash = book.company.cash;
    const sold = book.sell(id);
    expect(sold).toMatchObject({ ok: true, data: { price: round2(expected * SALE_SHARE) } });
    expect(book.company.reputation).toBe(rep);
    expect(book.company.cash).toBe(round2(cash + round2(expected * SALE_SHARE)));
    // Bought at $552,000 + inspection + repairs; the sale more than covers it.
    const spent = l.askingPrice + l.inspection.fee + fix.data.order.cost;
    expect(round2(expected * SALE_SHARE)).toBeGreaterThan(spent);
  });
});

describe("defect rolls after a flight", () => {
  const c208 = type("c208b");
  const base = (over: Partial<Parameters<typeof rollFlightDefects>[1]> = {}) => {
    let n = 0;
    return {
      type: c208,
      before: systemsFromCondition(100),
      after: systemsFromCondition(99),
      existing: [],
      airborneMin: 60,
      peakG: 1.2,
      overspeedEvents: 0,
      tanksDry: false,
      crashed: false,
      nextId: () => `D${++n}`,
      gameMs: 0,
      ...over,
    };
  };

  it("a normal flight rolls nothing", () => {
    for (let s = 0; s < 50; s++) {
      expect(rollFlightDefects(new Rng(s), base())).toEqual({ added: [], escalated: [] });
    }
  });

  it("hard landing above 1.6 G: gear/airframe; ≥ 2.3 G always a grounding defect", () => {
    for (let s = 0; s < 50; s++) {
      const r = rollFlightDefects(new Rng(s), base({ peakG: 2.4 }));
      expect(r.added).toHaveLength(1);
      expect(r.added[0]).toMatchObject({ severity: "grounding", cause: "hard_landing" });
      expect(["gear", "airframe"]).toContain(r.added[0]?.system);
    }
    let hits = 0;
    for (let s = 0; s < 400; s++) {
      const r = rollFlightDefects(new Rng(s), base({ peakG: 1.7 }));
      if (r.added.length) {
        hits++;
        expect(["minor", "major"]).toContain(r.added[0]?.severity);
      }
    }
    // chance 0.3 + 0.1 / 0.4 = 55 %
    expect(hits / 400).toBeGreaterThan(0.45);
    expect(hits / 400).toBeLessThan(0.65);
  });

  it("overspeed: airframe minor/major about half the time per event", () => {
    let hits = 0;
    for (let s = 0; s < 400; s++) {
      const r = rollFlightDefects(new Rng(s), base({ overspeedEvents: 1 }));
      for (const d of r.added) {
        expect(d).toMatchObject({ system: "airframe", cause: "overspeed" });
        hits++;
      }
    }
    expect(hits / 400).toBeGreaterThan(0.4);
    expect(hits / 400).toBeLessThan(0.6);
  });

  it("fuel exhaustion: an engine major and a fuel-system minor", () => {
    const r = rollFlightDefects(new Rng(1), base({ tanksDry: true }));
    expect(r.added.map((d) => [d.system, d.severity, d.cause])).toEqual([
      ["engines", "major", "fuel_exhaustion"],
      ["fuel", "minor", "fuel_exhaustion"],
    ]);
    expect(tanksDryThresholdLb(1_700)).toBe(8.5);
    expect(tanksDryThresholdLb(100)).toBe(1);
  });

  it("crash: 2–4 grounding defects on distinct systems", () => {
    for (let s = 0; s < 50; s++) {
      const r = rollFlightDefects(new Rng(s), base({ crashed: true }));
      const crash = r.added.filter((d) => d.cause === "crash");
      expect(crash.length).toBeGreaterThanOrEqual(2);
      expect(crash.length).toBeLessThanOrEqual(4);
      expect(new Set(crash.map((d) => d.system)).size).toBe(crash.length);
      expect(crash.every((d) => d.severity === "grounding")).toBe(true);
    }
  });

  it("wear thresholds: crossing 75 / 50 / 30 % rolls on that system", () => {
    let found = 0;
    for (let s = 0; s < 200; s++) {
      const r = rollFlightDefects(
        new Rng(s),
        base({
          before: { ...systemsFromCondition(90), engines: 76 },
          after: { ...systemsFromCondition(89), engines: 74 },
        }),
      );
      for (const d of r.added) {
        expect(d).toMatchObject({ system: "engines", cause: "wear" });
        expect(["cosmetic", "minor"]).toContain(d.severity);
        found++;
      }
    }
    expect(found / 200).toBeGreaterThan(0.4);
    expect(found / 200).toBeLessThan(0.6);
  });

  it("open major defects escalate to grounding at 3 % per airborne hour (≤ 50 %)", () => {
    const major = defect("major", "engines", { fuelBurnPct: 10, payloadPct: 10 });
    let esc = 0;
    for (let s = 0; s < 1_000; s++) {
      const r = rollFlightDefects(new Rng(s), base({ existing: [major], airborneMin: 300 }));
      if (r.escalated.length) {
        esc++;
        expect(r.escalated[0]).toMatchObject({
          id: major.id,
          severity: "grounding",
          cause: "escalation",
          repairCost: 108_000,
        });
        expect(r.escalated[0]?.payloadPct).toBeUndefined();
      }
    }
    expect(esc / 1_000).toBeGreaterThan(0.11); // 5 h × 3 % = 15 %
    expect(esc / 1_000).toBeLessThan(0.19);
  });

  it("book: a crash below 25 % writes the airframe off; a hard landing grounds it", () => {
    const book = newBook();
    const a = book.ensureStarter();
    if (!a) throw new Error("starter");
    const kmem = lookup.get("KMEM");
    const katl = lookup.get("KATL");
    if (!kmem || !katl) throw new Error("airports");
    const flight = {
      fuelKg: 0,
      fuelAirport: kmem,
      landingAirport: katl,
      blockMin: 60,
      airborneMin: 50,
      peakG: 2.5,
      overspeedEvents: 0,
      crashed: false,
      landings: 1,
      refType: "mission",
      refId: "M-1",
      memo: "test",
    };
    const r = book.settleFlight(a.id, flight);
    if (!r.ok) throw new Error(r.message);
    expect(r.data.defects.some((d) => d.severity === "grounding")).toBe(true);
    const n = book.drain().notices;
    expect(notices(n, "aircraft.grounded")).toHaveLength(1);
    expect(book.gate(book.aircraft(a.id) as BookAircraft).status).toBe("grounded");
    book.updateAircraft(a.id, { condition: 60 });
    const crash = book.settleFlight(a.id, { ...flight, refId: "M-2", crashed: true });
    if (!crash.ok) throw new Error(crash.message);
    expect(crash.data.writtenOff).toBe(true);
    expect(book.aircraft(a.id)).toBeNull();
    expect(book.fleet.get(a.id)?.status).toBe("written_off");
  });
});

describe("demo company (P5)", () => {
  it("seeded market, a used aircraft with inspected defects and a maintenance board", () => {
    const { book, selection } = buildDemoCompany(lookup);
    const fleet = book.fleetDomain(selection);
    expect(book.marketDomain().listings.length).toBeGreaterThanOrEqual(12);
    const used = fleet.aircraft.find((a) => (a.ageYears ?? 0) > 1);
    expect(used).toBeDefined();
    expect(fleet.maintenance?.length).toBeGreaterThan(0);
    expect(buildDemoCompany(lookup).book.marketDomain()).toEqual(book.marketDomain());
    expect(GAME_YEAR_MS).toBe(360 * GAME_DAY_MS);
  });
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
