// Economy engine (plan §5 P3, §6.4, §7): job boards, the mission lifecycle and the
// minimal company. It owns the `company`, `jobs` and `mission` domains and the
// mission.* / job.completed events, and observes the flight core through hooks:
//
//   accept → load → start → verify leg → deliver → payout
//
// - start: an explicit flight.start with a loaded mission needs the aircraft within
//   3 nm of the mission origin (plus fuel ≥ leg fuel + 45 min and weight ≤ MTOW when
//   the sim reports them). A flight that starts by itself at takeoff picks up the
//   loaded mission when the last parked sample (on ground, brake set) was within
//   3 nm of the origin; otherwise the mission stays loaded with `startBlocked`.
// - payload check: while the mission is loaded the cargo is compared with the payload
//   stations the sim reports (minus a crew allowance) as a live preview; at the start
//   the check is frozen on the mission. An underloaded departure removes the payout
//   bonuses (like noBonus); no stations reported → unknown, never a penalty. A payload the
//   player entered (mission.load / mission.payload) only stands in for an unknown readout;
//   TOTAL WEIGHT − EMPTY WEIGHT − fuel is shown as a second source (cross-check).
// - weather: the METAR flight category the connector already holds is frozen for the
//   origin at the start and for the destination at arrival; a live, current IFR/LIFR
//   report under sim telemetry adds the weather bonus (sample/unknown → none).
// - deliver: when the flight completes (Arrived: parked, engines off, brake set) the
//   leg is verified (distance ≥ 90 % of the great circle, parked within 3 nm of the
//   destination, no teleport, not invalidated) and every job is paid with a full
//   breakdown. Crash → mission failed, no payout, −20 reputation. A flight that is
//   aborted (flight.end abort, session reset) aborts the mission; its jobs go back to
//   accepted. mission.abort in the air aborts at once and books the flight's costs when it
//   ends; a connector restart never leaves a mission in progress or an aircraft in flight.
// - transit cargo (docs/ECONOMY.md "Transit cargo"): `mission.load {destination}` may end a
//   leg at an intermediate airport. Jobs going further are unloaded there `in_transit`
//   (stored, possibly in an own cargo terminal with free storage hours) and loaded again
//   later for the onward leg from that airport. They are paid in full on the final delivery
//   only; the time limit covers the whole chain (block minutes + counted ground time).
//
// All of it is deterministic: boards come from the company seed, the board airport,
// the aircraft type and a counter; the clock and ids are injected.

import { randomInt, randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  fleetBuyArgsSchema,
  fleetLeaseArgsSchema,
  fleetRepairArgsSchema,
  fleetReturnArgsSchema,
  fleetSelectArgsSchema,
  fleetSellArgsSchema,
  fleetAnnualArgsSchema,
  fleetDeferArgsSchema,
  fleetFerryPermitArgsSchema,
  fleetRepairAllArgsSchema,
  fleetRepairDefectArgsSchema,
  marketBuyArgsSchema,
  marketInspectArgsSchema,
  marketRefreshArgsSchema,
  fboBuildArgsSchema,
  fboBuyArgsSchema,
  fboModuleBuyArgsSchema,
  fboModuleUpgradeArgsSchema,
  fboPricingArgsSchema,
  fboSellArgsSchema,
  insuranceBuyArgsSchema,
  insuranceCancelArgsSchema,
  insuranceRepairLoanArgsSchema,
  pilotAssignArgsSchema,
  pilotFireArgsSchema,
  pilotHireArgsSchema,
  pilotUnassignArgsSchema,
  type DemandState,
  type FbosState,
  type PilotsState,
  type MarketState,
  loanPayoffArgsSchema,
  loanQuoteArgsSchema,
  loanTakeArgsSchema,
  type FleetState,
  type LedgerState,
  type LoansState,
  type MissionCost,
  jobIdArgsSchema,
  jobsRefreshArgsSchema,
  missionLoadArgsSchema,
  missionPayloadArgsSchema,
  resolveAircraftType,
  settingsUpdateArgsSchema,
  aircraftTypeByKey,
  type AircraftType,
  type AircraftTypeSource,
  type Command,
  type CompanyState,
  type FlightState,
  type Job,
  type JobBoard,
  type JobsState,
  type Mission,
  type Result,
  type SimStatePatch,
  type WeightsState,
  type FuelState,
  type PayloadCheck,
  type PayloadState,
  type MissionWeather,
  type PayoutBreakdown,
  type WeatherCheck,
} from "../../protocol";
import {
  ARRIVAL_RADIUS_NM,
  CompanyBook,
  formatGameTime,
  GameClockTicker,
  KG_PER_LB,
  OverspeedDetector,
  newCompanyCore,
  tanksDryThresholdLb,
  round2,
  selectAircraft,
  type BookAircraft,
  type BookResult,
  type MaintenanceCapability,
  type Selection,
  BOARD_REFRESH_SIM_MIN,
  REPUTATION,
  STARTING_CASH,
  airportLookup,
  boardSeed,
  checkAtOrigin,
  checkPayload,
  checkWeather,
  type WeatherReportInput,
  weatherBonus,
  weatherOutcome,
  clampReputation,
  computePayout,
  deliveryReputationDelta,
  generateJobs,
  greatCircleNm,
  legFuelKg,
  maxJobDistanceNm,
  nearestAirport,
  payloadLimitKg,
  payloadMismatch,
  reputationTier,
  round1,
  runwaySuitability,
  verifyLeg,
  arriveInTransit,
  checkTransitProgress,
  finalDeliveryTerms,
  jobLocation,
  legReputationDelta,
  missionLegTerms,
  missionPayoutTotals,
  transitStorage,
  LONG_HAUL_JOBS_PER_BOARD,
  TRANSIT_ABANDON_REPUTATION,
  type FlownLeg,
  type AirportLookup,
  type EconomyAirport,
} from "../../economy";
import { AiArrivalDetector, type AiObjectSample } from "../../sim/ai-traffic";
import type { LogFn } from "../../sim/source";
import type { CompanyRecord, EconomyRepo } from "../../storage/economy";
import type { FlightHooks } from "../flight-core";
import type { FlightSample } from "../flight-sample";
import type { FlightRecord } from "../flight-tracker";
import type { StateStore } from "../store";

const MAX_BOARDS = 4;
const MAX_ACCEPTED = 20;
/** Fixed seed for a new demo/replay company so replays are reproducible. */
export const DEMO_COMPANY_SEED = 20_261_013;

export interface EconomyOptions {
  store: StateStore;
  repo?: EconomyRepo | null;
  airports: readonly EconomyAirport[] | null;
  log?: LogFn;
  now?: () => number;
  newId?: () => string;
  /** Seed for a newly created company (default: demo seed for replays, random live). */
  seed?: number;
  replay?: boolean;
  /** P5: where maintenance is available (default: large airports; the FBO lane extends it). */
  maintenance?: MaintenanceCapability;
  /** The METAR the connector already holds for a station (no request); weather bonus. */
  weather?: WeatherLookup | null;
}

/** Synchronous lookup of the connector's current METAR for a station (null = none). */
export type WeatherLookup = (station: string) => WeatherReportInput | null;

type Reason = { code: string; message: string };
type Fail = { ok: false; code: string; message: string; reasons?: Reason[] };
type Ok<T> = { ok: true; data: T };

const fail = (code: string, message: string, reasons?: Reason[]): Fail => ({
  ok: false,
  code,
  message,
  ...(reasons?.length ? { reasons } : {}),
});

export class EconomyEngine {
  private readonly store: StateStore;
  private readonly repo: EconomyRepo | null;
  private readonly airports: AirportLookup | null;
  private readonly log: LogFn;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly seedForNew: number;
  private readonly maintenance: MaintenanceCapability | undefined;
  private book: CompanyBook<CompanyRecord>;
  private readonly ticker = new GameClockTicker();
  private readonly overspeed = new OverspeedDetector(999);
  private lastClockSave = Number.NEGATIVE_INFINITY;
  private publishedGameMinute = -1;
  private lastClockPublish = 0;
  /** Open jobs: available, accepted or loaded. */
  private readonly jobs = new Map<string, Job>();
  private mission: Mission | null = null;
  private publishedMissionId: string | null = null;
  private title: string | null = null;
  private lastParked: { lat: number; lon: number } | null = null;
  private lastTMs: number | null = null;
  /** True between a simulator disconnect and the next sample (see onSimOffline). */
  private simOffline = false;
  private simMinSinceBoard = 0;
  private lastExpiryCheck = 0;
  /** P5: a ferry flight in progress (aircraft with a permit, no mission). */
  private ferry: { aircraftId: string; flightId: string } | null = null;
  /**
   * A mission aborted (mission.abort) while its flight was still running: the aircraft keeps
   * flying and the flight's real costs are booked on that mission when the flight ends.
   */
  private abortedFlight: { mission: Mission; flightId: string } | null = null;
  /**
   * A mission found in progress at startup: its flight was lost with the restart, so it was
   * put back to loaded; the first sample decides whether it stays loaded or is aborted.
   */
  private recovering: string | null = null;
  /** P5: fuel at block-out and whether the tanks ran dry on the current tracked flight. */
  private fuelAtStartLb: number | null = null;
  private tanksDry = false;
  /** P5 part 2: AI arrivals observed in the connected simulator near own FBO airports. */
  private readonly aiDetector = new AiArrivalDetector();
  private weatherLookup: WeatherLookup | null;

  constructor(options: EconomyOptions) {
    this.weatherLookup = options.weather ?? null;
    this.store = options.store;
    this.repo = options.repo ?? null;
    this.airports = options.airports ? airportLookup(options.airports) : null;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `M-${randomUUID().slice(0, 8).toUpperCase()}`);
    this.seedForNew = options.seed ?? (options.replay ? DEMO_COMPANY_SEED : randomInt(0, 2 ** 31));
    this.maintenance = options.maintenance;
    this.book = this.loadBook();
    for (const job of this.persistRead(
      () => this.repo?.listJobs(["available", "accepted", "loaded", "in_transit"]) ?? [],
    ) ?? [])
      this.jobs.set(job.id, job);
    this.mission = this.persistRead(() => this.repo?.openMission() ?? null);
    this.recoverAfterRestart();
    if (!this.airports) this.log("warn", "No airport data: job boards are disabled");
  }

  /**
   * A fresh connector has no running flight, so nothing it loaded can still be flying
   * (docs/ECONOMY.md "Mission lifecycle", connector restart). The flight tracker's state (distance, fuel,
   * landings) was in memory and is gone: a lost flight is never resumed or billed.
   * - Every aircraft left `in_flight` (mission, ferry or aborted flight) is available again.
   * - A mission left `in_progress` goes back to `loaded` with its start cleared; the first
   *   sample then keeps it loaded when the aircraft is on the ground within 3 nm of the
   *   origin, and otherwise aborts it (jobs back to accepted, transit cargo back at its stop
   *   with its clock unchanged, no penalty) — `mission.recovered` either way.
   */
  private recoverAfterRestart(): void {
    this.recovering = null;
    for (const a of this.book.activeFleet()) {
      if (a.status !== "in_flight") continue;
      this.book.setFlying(a.id, false);
      this.log("warn", `${a.registration} was in flight when the connector stopped; released`);
    }
    const m = this.mission;
    if (m?.status === "in_progress") {
      const {
        flightId: _f,
        startedAt: _s,
        startedGameMs: _g,
        flownNm: _n,
        elapsedMin: _e,
        payloadCheck: _p,
        startBlocked: _b,
        // The departure METAR was frozen for the lost flight; the next departure freezes anew.
        weather: _w,
        ...rest
      } = m;
      this.mission = {
        ...rest,
        status: "loaded",
        ...missionLegTerms(m.jobs, m.destination, this.company.gameMs, this.company.reputation),
      };
      this.recovering = m.id;
      this.persistMission();
      this.log(
        "warn",
        `Mission ${m.id} was in progress when the connector stopped; its flight cannot be resumed`,
      );
    }
    this.flushBook();
  }

  /** First sample after a restart with a recovered mission: keep it loaded or abort it. */
  private resolveRecovery(s: FlightSample, onGround: boolean | null): void {
    const m = this.mission;
    if (!this.recovering || !m || m.id !== this.recovering || m.status !== "loaded") {
      this.recovering = null;
      return;
    }
    if (onGround === null) return; // not known yet: wait for the next sample
    this.recovering = null;
    const origin = this.airports?.get(m.origin) ?? null;
    const atOrigin =
      onGround === true && origin !== null && greatCircleNm(origin, s) <= ARRIVAL_RADIUS_NM;
    if (atOrigin) {
      this.log("info", `Mission ${m.id} is loaded again at ${m.origin}`);
      this.store.event("mission.recovered", { missionId: m.id, status: "loaded" });
      return;
    }
    const failure = {
      code: "flight_lost",
      message:
        "The connector restarted during the flight and the aircraft was not back at the origin",
    };
    this.mission = {
      ...m,
      status: "aborted",
      endedAt: new Date(this.now()).toISOString(),
      failure,
    };
    this.repoTx(() => {
      this.returnJobs(m, "accepted");
      this.persistMission();
    });
    this.log("warn", `Mission ${m.id} aborted: ${failure.message}; jobs returned`);
    this.store.event("mission.recovered", {
      missionId: m.id,
      status: "aborted",
      code: failure.code,
      message: failure.message,
    });
  }

  /** Company, fleet, loans and recent ledger from the database (or a new company). */
  private loadBook(): CompanyBook<CompanyRecord> {
    const stored = this.persistRead(() => this.repo?.getCompany() ?? null);
    let company: CompanyRecord = stored ?? {
      name: "Cargo Ops Logistics",
      base: "KMEM",
      cash: STARTING_CASH,
      reputation: REPUTATION.start,
      seed: this.seedForNew,
      boardCounter: 0,
      boards: [],
      aircraftTypeOverride: null,
      crewAllowanceKg: null,
      ...newCompanyCore(STARTING_CASH),
    };
    if (stored && this.repo) {
      // P3 records: count the ledger; a company without a monthly P&L but with ledger rows
      // (a P3 database or an old import) gets it rebuilt from the ledger.
      const totals = this.persistRead(() => this.repo?.ledgerTotals() ?? null);
      if (totals && company.ledgerCount !== totals.count) {
        company = { ...company, ledgerCount: totals.count };
      }
      if (totals && totals.count > 0 && company.pnl.length === 0) {
        company = {
          ...company,
          pnl: this.persistRead(() => this.repo?.pnlFromLedger() ?? []) ?? [],
        };
      }
    }
    const book = new CompanyBook<CompanyRecord>({
      company,
      fleet: this.persistRead(() => this.repo?.listFleet() ?? []) ?? [],
      loans: this.persistRead(() => this.repo?.listLoans() ?? []) ?? [],
      recent: (this.persistRead(() => this.repo?.listLedger(20) ?? []) ?? []).map((e) => ({
        at: e.at,
        gameMs: e.gameMs ?? 0,
        category: e.category,
        amount: e.amount,
        balance: e.balance ?? 0,
        refType: e.refType,
        refId: e.refId,
        memo: e.memo,
      })),
      airports: this.airports,
      now: this.now,
      market: this.persistRead(() => this.repo?.listListings() ?? []) ?? [],
      ...(this.maintenance ? { maintenance: this.maintenance } : {}),
      fbos: this.persistRead(() => this.repo?.listFbos() ?? []) ?? [],
      pilots: this.persistRead(() => this.repo?.listPilots() ?? []) ?? [],
      demandEvents:
        this.persistRead(
          () => this.repo?.listDemandEvents(Math.max(0, company.gameMs - 30 * 86_400_000)) ?? [],
        ) ?? [],
    });
    if (book.ensureStarter()) this.log("info", "New company: starter Cessna 208B at the base");
    book.ensureMarket();
    if (!stored) book.setCompany(book.company);
    const changes = book.drain();
    this.persist(() => this.repo?.persistBook(book.company, { ...changes, company: true }));
    this.lastClockSave = this.now();
    this.ticker.reset();
    return book;
  }

  private get company(): CompanyRecord {
    return this.book.company;
  }

  private set company(value: CompanyRecord) {
    this.book.setCompany(value);
  }

  /** Company book (cash, ledger, fleet, loans, clock). */
  get companyBook(): CompanyBook<CompanyRecord> {
    return this.book;
  }

  get enabled(): boolean {
    return this.airports !== null;
  }

  /** Generate the first board if there is none; publish the domains. */
  start(): void {
    this.expire(true);
    if (this.airports && this.company.boards.length === 0) this.generateBoard(this.company.base);
    this.publish();
  }

  // ---- state ----

  /**
   * Board aircraft type: the manual type override → the selected fleet aircraft's type →
   * the sim TITLE → the default C208B.
   */
  activeType(): { type: AircraftType; source: AircraftTypeSource } {
    const resolved = resolveAircraftType(this.title, this.company.aircraftTypeOverride);
    if (resolved.source === "override") return resolved;
    const selected = this.selectedAircraft();
    const type = selected ? aircraftTypeByKey(selected.typeKey) : null;
    if (type) return { type, source: "fleet" };
    return resolved;
  }

  /** Which fleet aircraft missions use: manual → TITLE match → the only aircraft. */
  selection(): Selection {
    return selectAircraft(
      this.book.activeFleet(),
      this.title,
      this.company.selectedAircraftId,
      this.parkedAirport(),
    );
  }

  selectedAircraft(): BookAircraft | null {
    return this.book.aircraft(this.selection().id);
  }

  /** Airport within 3 nm of the aircraft's position, if any. */
  private parkedAirport(): string | null {
    const pos = this.store.getDomain("position") as { lat: number; lon: number } | null | undefined;
    if (!pos || !this.airports) return null;
    return nearestAirport(this.airports.list, pos, ARRIVAL_RADIUS_NM)?.airport.ident ?? null;
  }

  companyDomain(): CompanyState {
    return {
      name: this.company.name,
      base: this.company.base,
      cash: Math.round(this.company.cash * 100) / 100,
      reputation: this.company.reputation,
      reputationTier: reputationTier(this.company.reputation),
      ...this.book.companyFields(),
      crewAllowanceKg: this.company.crewAllowanceKg,
    };
  }

  fleetDomain(): FleetState {
    return this.book.fleetDomain(this.selection());
  }

  loansDomain(): LoansState {
    return this.book.loansDomain();
  }

  ledgerDomain(): LedgerState {
    return this.book.ledgerDomain();
  }

  marketDomain(): MarketState {
    return this.book.marketDomain();
  }

  fbosDomain(): FbosState {
    return this.book.fbosDomain();
  }

  demandDomain(): DemandState {
    return this.book.demandDomain();
  }

  /**
   * Airports the company serves besides what the book knows (base, fleet, FBOs, recent
   * deliveries): the job board airports and their jobs' destinations.
   */
  private servedExtra(): string[] {
    const out = new Set<string>(this.company.boards.map((b) => b.origin));
    for (const j of this.jobs.values()) {
      out.add(j.origin);
      out.add(j.destination);
    }
    return [...out];
  }

  /** Hired pilots (simulated operations; never telemetry). */
  pilotsDomain(): PilotsState {
    return this.book.pilotsDomain(this.servedExtra());
  }

  /**
   * P5 part 2: a batch of AI aircraft from the connected simulator. New arrivals at an
   * own FBO airport are credited as a labelled bonus (source sim_ai).
   */
  onAiTraffic(samples: readonly AiObjectSample[], at: number): void {
    const targets = this.book.aiTargets();
    if (targets.length === 0) return;
    const arrivals = this.aiDetector.update(samples, targets, at);
    for (const a of arrivals) {
      const r = this.book.creditAiArrival(a.icao, a.atcId ?? a.objectId);
      if (r.ok) {
        this.log(
          "info",
          `AI arrival at ${a.icao} (${a.atcId ?? `object ${a.objectId}`}): +$${r.data.amount} sim_ai bonus`,
        );
      }
    }
    if (arrivals.length > 0) this.publish();
  }

  jobsDomain(): JobsState {
    const { type, source } = this.activeType();
    const all = [...this.jobs.values()];
    const boards: JobBoard[] = this.company.boards.map((b) => ({ ...b }));
    const order = new Map(boards.map((b, i) => [b.origin, i]));
    const available = all
      .filter((j) => j.status === "available")
      .sort((a, b) => (order.get(a.origin) ?? 99) - (order.get(b.origin) ?? 99));
    return {
      boards,
      available,
      accepted: all.filter((j) => j.status === "accepted" || j.status === "loaded"),
      inTransit: all.filter((j) => j.status === "in_transit"),
      aircraft: {
        typeKey: type.key,
        name: type.name,
        source,
        ...(this.title ? { title: this.title } : {}),
      },
    };
  }

  /** Domains merged into a reset snapshot so a replay restart never drops them. */
  domains(): {
    company: CompanyState;
    jobs: JobsState;
    fleet: FleetState;
    loans: LoansState;
    ledger: LedgerState;
    market: MarketState;
    fbos: FbosState;
    demand: DemandState;
    pilots: PilotsState;
    mission?: Mission;
  } {
    return {
      company: this.companyDomain(),
      jobs: this.jobsDomain(),
      fleet: this.fleetDomain(),
      loans: this.loansDomain(),
      ledger: this.ledgerDomain(),
      market: this.marketDomain(),
      fbos: this.fbosDomain(),
      demand: this.demandDomain(),
      pilots: this.pilotsDomain(),
      ...(this.mission ? { mission: this.mission } : {}),
    };
  }

  publish(): void {
    this.flushBook();
    this.refreshLegTerms();
    if (this.mission && this.mission.id !== this.publishedMissionId) {
      if (this.publishedMissionId !== null) this.store.apply({ mission: null });
      this.publishedMissionId = this.mission.id;
    }
    this.publishedGameMinute = Math.floor(this.company.gameMs / 60_000);
    this.store.apply({
      company: this.companyDomain(),
      jobs: this.jobsDomain(),
      fleet: this.fleetDomain(),
      loans: this.loansDomain(),
      ledger: this.ledgerDomain(),
      market: this.marketDomain(),
      fbos: this.fbosDomain(),
      demand: this.demandDomain(),
      pilots: this.pilotsDomain(),
      ...(this.mission ? { mission: this.mission } : {}),
    });
  }

  /** Write what the book changed and emit its events (loan.*, repair.completed, …). */
  private flushBook(): void {
    if (!this.book.hasPending) return;
    const changes = this.book.drain();
    this.persist(() => this.repo?.persistBook(this.company, changes));
    if (changes.company) this.lastClockSave = this.now();
    for (const n of changes.notices) {
      this.log("info", `${n.name} ${JSON.stringify(n.data)}`);
      this.store.event(n.name, n.data);
    }
  }

  /** Move the company clock by `ms` of in-game time at once (tests and tools). */
  advanceGameTime(ms: number): void {
    this.book.advance(ms);
    this.publish();
  }

  /**
   * Advance the company clock: max(wall Δ ≤ 60 s, simulator Δ) since the last tick.
   * Called every second by the connector and on every flight sample.
   */
  tick(): void {
    const delta = this.ticker.tick(this.now());
    if (delta > 0) this.book.advance(delta);
    const minute = Math.floor(this.company.gameMs / 60_000);
    if (this.book.hasPending) {
      this.publish();
      return;
    }
    const wall = this.now();
    if (wall - this.lastClockSave >= 30_000) {
      this.lastClockSave = wall;
      this.persist(() => this.repo?.saveCompany(this.company));
    }
    if (minute !== this.publishedGameMinute && wall - this.lastClockPublish >= 1_000) {
      this.publishedGameMinute = minute;
      this.lastClockPublish = wall;
      this.store.apply({ company: this.companyDomain() });
      // Transit cargo waiting for departure keeps using its deadline: refresh the leg terms.
      if (this.refreshLegTerms() && this.mission) this.store.apply({ mission: this.mission });
    }
  }

  /** Called after a store reset: the session put our domains back in the snapshot. */
  onStoreReset(): void {
    this.publishedMissionId = this.mission?.id ?? null;
  }

  /** The aircraft domain changed (TITLE). */
  onAircraftTitle(title: string | null): void {
    if (title === this.title) return;
    const before = this.activeType().type.key;
    this.title = title;
    const after = this.activeType().type.key;
    if (before !== after) this.retypeBoard();
    this.publish();
  }

  // ---- flight hooks ----

  hooks(): FlightHooks {
    return {
      beforeStart: (s) => this.beforeStart(s),
      onSample: (s, flight, onGround) => this.onSample(s, flight, onGround),
      onFlightStarted: (record, explicit) => this.onFlightStarted(record, explicit),
      onFlightEnded: (record, last) => this.onFlightEnded(record, last),
      onReset: () => {
        this.lastParked = null;
        this.lastTMs = null;
      },
      onSimOffline: () => this.onSimOffline(),
      referenceSpeedKt: () => this.activeType().type.approachKt,
    };
  }

  private beforeStart(s: FlightSample): Omit<Fail, "ok"> | null {
    const m = this.mission;
    if (!m || m.status !== "loaded") {
      // P5: no mission. The selected aircraft, parked where the sim is, must be airworthy
      // unless it holds a ferry permit (then the payload cap applies).
      const r = this.freeFlightChecks(s);
      if (r.ok) return null;
      const { ok: _ok, ...rest } = r;
      this.publish();
      return rest;
    }
    const r = this.startChecks(m, s);
    if (r.ok) return null;
    const { ok: _ok, ...rest } = r;
    this.publish();
    return rest;
  }

  /** The selected fleet aircraft when the sim sits within 3 nm of where it is parked. */
  private parkedSelected(at: { lat: number; lon: number } | null): BookAircraft | null {
    const a = this.selectedAircraft();
    if (!a || !at || !this.airports) return null;
    const here = this.airports.get(a.location);
    if (!here || greatCircleNm(at, here) > ARRIVAL_RADIUS_NM) return null;
    return a;
  }

  private freeFlightChecks(at: { lat: number; lon: number } | null): Ok<null> | Fail {
    const a = this.parkedSelected(at);
    if (!a || a.status !== "available") return { ok: true, data: null };
    if (a.ferryPermit) return this.ferryPayloadCheck(a);
    const r = this.book.dispatchCheck(a.id);
    return r.ok ? { ok: true, data: null } : fail(r.code, r.message, r.reasons);
  }

  private ferryPayloadCheck(a: BookAircraft): Ok<null> | Fail {
    const permit = a.ferryPermit;
    if (!permit) return { ok: true, data: null };
    const weights = this.store.getDomain("weights") as WeightsState | null | undefined;
    const kg = weights ? weights.payloadLb * KG_PER_LB : 0;
    if (kg > permit.payloadCapKg) {
      return fail(
        "ferry_payload_cap",
        `Payload ${Math.round(kg)} kg exceeds the ferry permit cap of ${permit.payloadCapKg} kg`,
      );
    }
    return { ok: true, data: null };
  }

  private startChecks(m: Mission, at: { lat: number; lon: number } | null): Ok<null> | Fail {
    const origin = this.airports?.get(m.origin);
    if (!origin) return fail("unknown_airport", `Unknown origin ${m.origin}`);
    if (m.aircraftId) {
      const a = this.book.aircraft(m.aircraftId);
      if (!a) return fail("no_aircraft", "The mission aircraft is no longer in the fleet");
      const ready = this.aircraftReady(a, m.origin);
      if (!ready.ok) return ready;
    }
    const where = checkAtOrigin(at, origin);
    if (!where.ok) return where;
    const type = aircraftTypeByKey(m.aircraftKey) ?? this.activeType().type;
    const fuel = this.store.getDomain("fuel") as FuelState | null | undefined;
    if (fuel) {
      const needKg = legFuelKg(type, m.distanceNm);
      const haveKg = fuel.totalLb * KG_PER_LB;
      if (haveKg < needKg) {
        return fail(
          "insufficient_fuel",
          `Fuel ${Math.round(haveKg)} kg is below the ${Math.round(needKg)} kg the leg needs (incl. 45 min reserve)`,
        );
      }
    }
    const weights = this.store.getDomain("weights") as WeightsState | null | undefined;
    if (weights && weights.maxGrossLb > 0 && weights.totalLb > weights.maxGrossLb) {
      return fail(
        "over_mtow",
        `Total weight ${Math.round(weights.totalLb)} lb exceeds the maximum ${Math.round(weights.maxGrossLb)} lb`,
      );
    }
    return { ok: true, data: null };
  }

  /** Cargo vs the payload stations the sim reports now (docs/ECONOMY.md "Payload check"). */
  private payloadCheckNow(m: Mission, stage: PayloadCheck["stage"]): PayloadCheck {
    const payload = this.store.getDomain("payload") as PayloadState | null | undefined;
    const weights = this.store.getDomain("weights") as WeightsState | null | undefined;
    const fuel = this.store.getDomain("fuel") as FuelState | null | undefined;
    const check = checkPayload({
      cargoKg: m.payloadKg,
      stations: payload?.stations ?? null,
      weights: weights ?? null,
      fuelLb: fuel?.totalLb ?? null,
      crewAllowanceKg: this.company.crewAllowanceKg,
      enteredPayloadKg: m.enteredPayloadKg ?? null,
      source: this.store.source,
      stage,
      checkedAt: new Date(this.now()).toISOString(),
    });
    if (this.simOffline && check.status === "unknown") {
      return {
        ...check,
        message: `The simulator is not connected: the cargo cannot be compared (no penalty)${
          check.enteredKg !== undefined
            ? `; payload entered by you ${Math.round(check.enteredKg)} kg`
            : ""
        }`,
      };
    }
    return check;
  }

  /** Where the weather comes from (set once the connector's weather service exists). */
  setWeatherLookup(lookup: WeatherLookup | null): void {
    this.weatherLookup = lookup;
  }

  /**
   * The weather a delivered leg records (docs/ECONOMY.md "Weather bonus"): the bonus actually
   * paid, taken from the payout itself so the logbook cannot disagree; the outcome and the end
   * that set it; and, on the final leg of a transit chain, the chain ends the payout counted
   * (they are not this leg's own ends). With jobs from different chains, the job paying the
   * largest bonus (then the largest one earned) is described. A leg that delivered nothing
   * (transit cargo only) has no bonus yet: it is decided at the final delivery.
   */
  private deliveredWeather(
    weather: MissionWeather,
    terms: ReturnType<typeof finalDeliveryTerms>[],
    breakdowns: PayoutBreakdown[],
  ): MissionWeather {
    if (terms.length === 0) return { ...weather, outcome: "in_transit" };
    const paid = breakdowns.map((b) => b.weatherBonus ?? 0);
    const earned = terms.map((t) => weatherBonus(t.weather).bonus);
    let i = 0;
    for (let k = 1; k < terms.length; k++) {
      if (
        (paid[k] ?? 0) > (paid[i] ?? 0) ||
        ((paid[k] ?? 0) === (paid[i] ?? 0) && (earned[k] ?? 0) > (earned[i] ?? 0))
      ) {
        i = k;
      }
    }
    const t = terms[i];
    if (!t) return weather;
    const o = weatherOutcome(t.weather, t);
    return {
      ...weather,
      bonus: Math.max(0, ...paid),
      outcome: o.outcome,
      ...(o.bonusFrom ? { bonusFrom: o.bonusFrom } : {}),
      ...(t.legs > 1 ? { chain: { legs: t.legs, ...t.weather } } : {}),
    };
  }

  /** Freeze the METAR flight category at one end of a mission (docs/ECONOMY.md). */
  private weatherCheckNow(station: string, stage: WeatherCheck["stage"]): WeatherCheck {
    let report: WeatherReportInput | null = null;
    try {
      report = this.weatherLookup?.(station) ?? null;
    } catch (err) {
      this.log("debug", `Weather lookup failed: ${err instanceof Error ? err.message : err}`);
    }
    const check = checkWeather({
      stage,
      station,
      report,
      source: this.store.source,
      nowMs: this.now(),
    });
    this.log("info", `Weather (${check.source}) ${check.message}`);
    return check;
  }

  /**
   * A loaded mission carrying transit cargo: its deadline and expected payout follow the
   * company clock until block-out (docs/ECONOMY.md "Transit cargo"). True when they changed.
   */
  private refreshLegTerms(): boolean {
    const m = this.mission;
    if (!m || m.status !== "loaded" || !m.jobs.some((j) => j.transit)) return false;
    const t = missionLegTerms(m.jobs, m.destination, this.company.gameMs, this.company.reputation);
    if (t.timeLimitMin === m.timeLimitMin && t.expectedPayout === m.expectedPayout) return false;
    this.mission = { ...m, ...t };
    return true;
  }

  /** Recompute the preview of a loaded mission; true when what it shows changed. */
  private refreshPayloadPreview(): boolean {
    const m = this.mission;
    if (!m || m.status !== "loaded") return false;
    const next = this.payloadCheckNow(m, "preview");
    const prev = m.payloadCheck;
    // Everything but the wall clock: a new number or flag is a change worth publishing.
    const key = (c: PayloadCheck | undefined) => {
      if (!c) return "";
      const { checkedAt: _t, ...rest } = c;
      return JSON.stringify(rest);
    };
    if (key(prev) === key(next)) return false;
    this.mission = { ...m, payloadCheck: next };
    return true;
  }

  /**
   * The simulator link dropped and the session cleared its domains: forget where the
   * aircraft was parked (a takeoff after the reconnect must be seen parked again) and
   * stop previewing the payload against stations the sim no longer reports.
   */
  private onSimOffline(): void {
    this.simOffline = true;
    this.lastParked = null;
    this.lastTMs = null;
    if (this.refreshPayloadPreview()) this.publish();
  }

  private onSample(s: FlightSample, flight: FlightState | null, onGround: boolean | null): void {
    this.simOffline = false;
    if (onGround === true && s.parkingBrake === true) this.lastParked = { lat: s.lat, lon: s.lon };
    else if (onGround === false) this.lastParked = null;

    if (this.lastTMs !== null && s.tMs > this.lastTMs && s.tMs - this.lastTMs < 600_000) {
      this.simMinSinceBoard += (s.tMs - this.lastTMs) / 60_000;
      this.ticker.addSim(s.tMs - this.lastTMs);
    }
    this.lastTMs = s.tMs;
    const recovering = this.recovering !== null;
    if (recovering) this.resolveRecovery(s, onGround);
    const flying = this.mission;
    const tracked =
      (flying && flying.status === "in_progress" && flight && flight.id === flying.flightId) ||
      (this.ferry !== null && flight !== null && flight.id === this.ferry.flightId) ||
      (this.abortedFlight !== null && flight !== null && flight.id === this.abortedFlight.flightId);
    if (tracked) {
      if (this.overspeed.update(s.iasKt, s.tMs)) {
        this.log("warn", `Overspeed: ${Math.round(s.iasKt)} kt IAS above Vmo (wear +5 %)`);
      }
      // P5: fuel quantity reaching ~0 in flight means the tanks ran dry.
      if (s.fuelLb !== null) {
        if (this.fuelAtStartLb === null) this.fuelAtStartLb = s.fuelLb;
        if (
          !this.tanksDry &&
          onGround === false &&
          s.fuelLb <= tanksDryThresholdLb(this.fuelAtStartLb)
        ) {
          this.tanksDry = true;
          this.log("warn", `Fuel exhausted in flight (${s.fuelLb.toFixed(1)} lb)`);
        }
      }
    }
    this.tick();
    let changed = recovering && this.recovering === null;
    if (this.simMinSinceBoard >= BOARD_REFRESH_SIM_MIN && this.company.boards[0]) {
      this.log("info", "Scheduled job board refresh (in-game time)");
      this.generateBoard(this.company.boards[0].origin);
      changed = true;
    }
    const wall = this.now();
    if (wall - this.lastExpiryCheck > 60_000) changed = this.expire(false) || changed;

    changed = this.refreshPayloadPreview() || changed;
    const m = this.mission;
    if (m && m.status === "in_progress" && flight && flight.id === m.flightId) {
      const flown = round1(flight.distanceNm ?? 0);
      const elapsed = round1(flight.blockMin ?? 0);
      if (flown !== m.flownNm || elapsed !== m.elapsedMin) {
        this.mission = { ...m, flownNm: flown, elapsedMin: elapsed };
        changed = true;
      }
    }
    if (changed) this.publish();
  }

  private onFlightStarted(record: FlightRecord, explicit: boolean): void {
    this.fuelAtStartLb = null;
    this.tanksDry = false;
    const m = this.mission;
    if (!m || m.status !== "loaded") {
      this.startFerry(record, explicit);
      return;
    }
    if (!explicit) {
      const r = this.startChecks(m, this.lastParked);
      if (!r.ok) {
        const reason =
          r.code === "no_data"
            ? {
                code: "not_parked_at_origin",
                message: "The aircraft was not parked with the brake set before departure",
              }
            : { code: r.code, message: r.message };
        this.log("info", `Mission ${m.id} not started: ${reason.message}`);
        this.mission = { ...m, startBlocked: reason };
        this.persistMission();
        this.publish();
        return;
      }
    }
    const { startBlocked: _drop, ...rest } = m;
    // The payload check is frozen at departure with what the sim reports right now.
    const payloadCheck = this.payloadCheckNow(m, "departure");
    // So is the origin's METAR flight category (weather bonus).
    const departureWeather = this.weatherCheckNow(m.origin, "departure");
    this.mission = {
      ...rest,
      status: "in_progress",
      flightId: record.id,
      startedAt: new Date(this.now()).toISOString(),
      // Transit cargo: ground time at the stop is counted up to block-out, where the leg's
      // deadline and expected payout are frozen.
      startedGameMs: Math.floor(this.company.gameMs),
      ...missionLegTerms(m.jobs, m.destination, this.company.gameMs, this.company.reputation),
      flownNm: record.distanceNm,
      elapsedMin: record.blockMin,
      payloadCheck,
      weather: { departure: departureWeather },
    };
    if (m.aircraftId) this.book.setFlying(m.aircraftId, true);
    const type = aircraftTypeByKey(m.aircraftKey);
    this.overspeed.reset();
    this.overspeed.setVmo(type?.vmoKt ?? 999);
    this.persist(() => this.repo?.linkFlight(record.id, m.jobIds, m.payloadKg, null));
    this.persistMission();
    this.log("info", `Mission ${m.id} started on flight ${record.id}`);
    this.log(
      payloadCheck.status === "ok" || payloadCheck.status === "unknown" ? "info" : "warn",
      `Payload check (${payloadCheck.source}) ${payloadCheck.status}: ${payloadCheck.message}${
        payloadMismatch(payloadCheck) ? " — no payout bonuses on this mission" : ""
      }`,
    );
    this.store.event("mission.started", { missionId: m.id, flightId: record.id });
    this.store.event("mission.payload_check", {
      missionId: m.id,
      flightId: record.id,
      check: payloadCheck,
      payoutBonuses: !payloadMismatch(payloadCheck),
    });
    this.publish();
  }

  /** P5: a flight without a mission by the selected aircraft holding a ferry permit. */
  private startFerry(record: FlightRecord, explicit: boolean): void {
    const pos = explicit
      ? ((this.store.getDomain("position") as { lat: number; lon: number } | null | undefined) ??
        null)
      : this.lastParked;
    const a = this.parkedSelected(pos);
    if (!a?.ferryPermit || a.status !== "available") return;
    const cap = this.ferryPayloadCheck(a);
    if (!cap.ok) {
      this.log("info", `Ferry not started: ${cap.message}`);
      return;
    }
    this.ferry = { aircraftId: a.id, flightId: record.id };
    this.book.setFlying(a.id, true);
    const type = aircraftTypeByKey(a.typeKey);
    this.overspeed.reset();
    this.overspeed.setVmo(type?.vmoKt ?? 999);
    this.log(
      "info",
      `Ferry ${a.registration} ${a.ferryPermit.origin}→${a.ferryPermit.destination} started on flight ${record.id}`,
    );
    this.publish();
  }

  private endFerry(record: FlightRecord, last: FlightSample | null): void {
    const f = this.ferry;
    if (!f) return;
    this.ferry = null;
    const a = this.book.aircraft(f.aircraftId);
    const origin = a?.ferryPermit ? (this.airports?.get(a.ferryPermit.origin) ?? null) : null;
    const parkedAt =
      last && this.airports
        ? (nearestAirport(this.airports.list, last, ARRIVAL_RADIUS_NM)?.airport ?? null)
        : null;
    const crashed = record.status === "failed" && record.flags.crashed;
    const r = this.settleAircraft(f.aircraftId, record, {
      fuelAirport: crashed ? origin : (parkedAt ?? origin),
      landingAirport: crashed ? null : parkedAt,
      crashed,
      refType: "ferry",
      refId: record.id,
      memo: `Ferry ${a?.registration ?? f.aircraftId}`,
    });
    if (record.airborneMin > 0) this.book.consumeFerryPermit(f.aircraftId);
    this.log(
      "info",
      `Ferry flight ${record.id} ended at ${parkedAt?.ident ?? "no airport"}: costs $${round2(r.costs.reduce((s, c) => s + c.amount, 0))}, wear ${r.wear}`,
    );
    this.publish();
  }

  private onFlightEnded(record: FlightRecord, last: FlightSample | null): void {
    if (this.ferry && this.ferry.flightId === record.id) {
      this.endFerry(record, last);
      return;
    }
    if (this.abortedFlight && this.abortedFlight.flightId === record.id) {
      this.endAbortedFlight(record, last);
      return;
    }
    const m = this.mission;
    if (!m || m.status !== "in_progress" || m.flightId !== record.id) return;
    const endedAt = new Date(this.now()).toISOString();
    const base: Mission = {
      ...m,
      endedAt,
      flownNm: record.distanceNm,
      elapsedMin: record.blockMin,
    };
    const origin = this.airports?.get(m.origin) ?? null;
    const dest = this.airports?.get(m.destination) ?? null;
    const parkedAt =
      last && this.airports
        ? (nearestAirport(this.airports.list, last, ARRIVAL_RADIUS_NM)?.airport ?? null)
        : null;
    if (record.status === "aborted") {
      // Fuel and hours flown are still paid; the aircraft stays where it was (or where it parked).
      const settled = this.settle(m, record, parkedAt ?? origin, parkedAt, false);
      this.mission = {
        ...base,
        status: "aborted",
        ...(settled.costs.length ? { costs: settled.costs } : {}),
        wear: settled.wear,
      };
      this.returnJobs(m, "accepted");
      this.persistMission();
      this.log("info", `Mission ${m.id} aborted with its flight; jobs returned to accepted`);
      this.publish();
      return;
    }
    const landing = record.landings.at(-1) ?? null;
    const grade = landing?.grade ?? null;
    const verdict =
      record.status === "failed"
        ? fail("crashed", "The aircraft crashed")
        : origin && dest
          ? verifyLeg({
              origin,
              destination: dest,
              flownNm: record.distanceNm,
              arrival: last ? { lat: last.lat, lon: last.lon } : null,
              flags: record.flags,
            })
          : fail("unknown_airport", "Mission airports are unknown");
    if (!verdict.ok) {
      const crashed = verdict.code === "crashed";
      // Transit cargo already stored on an earlier leg and lost by a failed (non-crash) leg
      // counts as abandoned, like job.release: −3 reputation each (a crash costs −20 already).
      const lost = crashed ? [] : m.jobs.filter((j) => j.transit);
      const delta = (crashed ? REPUTATION.crash : 0) + TRANSIT_ABANDON_REPUTATION * lost.length;
      if (delta) this.book.adjustReputation(delta);
      const settled = crashed
        ? this.settle(m, record, origin, null, true)
        : this.settle(m, record, parkedAt ?? origin, parkedAt, false);
      this.mission = {
        ...base,
        status: "failed",
        failure: { code: verdict.code, message: verdict.message },
        ...(grade ? { landingGrade: grade } : {}),
        reputationDelta: delta,
        ...(settled.costs.length ? { costs: settled.costs } : {}),
        wear: settled.wear,
      };
      this.repoTx(() => {
        this.returnJobs(m, "failed");
        this.flushBook();
        this.persistMission();
        this.repo?.linkFlight(record.id, m.jobIds, m.payloadKg, {
          failure: verdict,
          costs: settled.costs,
        });
      });
      this.log("warn", `Mission ${m.id} failed: ${verdict.message}`);
      this.store.event("mission.failed", {
        missionId: m.id,
        code: verdict.code,
        message: verdict.message,
      });
      for (const j of lost) {
        this.store.event("job.abandoned", {
          jobId: j.id,
          location: jobLocation(j),
          reputationDelta: TRANSIT_ABANDON_REPUTATION,
          missionId: m.id,
        });
      }
      this.publish();
      return;
    }

    const reputation = this.company.reputation;
    // Transit cargo: jobs whose final destination is this leg's destination are delivered
    // and paid over their whole chain; the others are unloaded here in transit (no pay yet).
    // The destination's METAR flight category, frozen at arrival (weather bonus); this leg's
    // two checks are recorded on the mission and on every transit leg it flew.
    const weather: MissionWeather = {
      ...m.weather,
      arrival: this.weatherCheckNow(m.destination, "arrival"),
    };
    const leg: FlownLeg = {
      missionId: m.id,
      flightId: record.id,
      origin: m.origin,
      destination: m.destination,
      ...(m.startedGameMs !== undefined ? { startedGameMs: m.startedGameMs } : {}),
      blockMin: record.blockMin,
      landingGrade: grade,
      peakG: landing?.peakG ?? null,
      noBonus: record.flags.noBonus,
      // An underloaded departure (sim payload clearly below the cargo) removes bonuses.
      payloadMismatch: payloadMismatch(m.payloadCheck),
      weather,
    };
    const finals = m.jobs.filter((j) => j.destination === m.destination);
    const onward = m.jobs.filter((j) => j.destination !== m.destination);
    const terms = finals.map((job) => finalDeliveryTerms(job, leg));
    const breakdowns = finals.map((job, i) => {
      const t = terms[i] ?? finalDeliveryTerms(job, leg);
      return computePayout({
        jobId: job.id,
        kind: job.kind,
        weightKg: job.weightKg,
        distanceNm: job.distanceNm,
        units: job.units,
        reputation,
        estimate: false,
        landingGrade: grade,
        lateMin: t.lateMin,
        peakG: t.peakG,
        noBonus: t.noBonus,
        payloadMismatch: t.payloadMismatch,
        // IFR/LIFR at the chain's ends (first departure, final arrival; live METAR only);
        // removed with the other bonuses when any leg lost them.
        weather: t.weather,
        // P5 part 2: the demand factor promised on the board.
        ...(job.demandFactor !== undefined ? { demand: job.demandFactor } : {}),
        ...(t.legs > 1 ? { chain: { legs: t.legs, chainMin: t.chainMin } } : {}),
      });
    });
    const delta = legReputationDelta(
      grade,
      terms.map((t) => t.lateMin),
    );
    for (const [i, job] of finals.entries()) {
      const legs = terms[i]?.legs ?? 1;
      this.book.post(
        "mission_payout",
        breakdowns[i]?.total ?? 0,
        "job",
        job.id,
        `${job.origin}→${job.destination} ${job.kind} ${job.weightKg} kg (mission ${m.id}${legs > 1 ? `, ${legs} legs via transit` : ""})`,
      );
    }
    // Storage for the cargo going further: an own cargo terminal keeps hours off the deadline.
    const fboHere = this.book.activeFboAt(m.destination);
    const storage = transitStorage({
      fbo: fboHere !== null,
      terminalLevel: fboHere?.modules.cargo.level ?? 0,
    });
    const arrivedAt = new Date(this.now()).toISOString();
    const stored = onward.map((job) =>
      arriveInTransit(this.jobs.get(job.id) ?? job, leg, {
        arrivedAt,
        arrivedGameMs: this.company.gameMs,
        ...(dest?.name ? { locationName: dest.name } : {}),
        ...storage,
      }),
    );
    // Fuel at the destination's price, its landing fee, lease hours and wear.
    const settled = this.settle(m, record, dest, dest, false);
    this.book.adjustReputation(delta);
    // P5 part 2: demand activity, delivery count and landing streak (milestones) — only
    // when cargo actually reached its final destination.
    if (finals.length > 0) {
      this.book.recordDelivery({ origin: m.origin, destination: m.destination, grade });
    }
    // In cents, like the ledger rows: persisted, emitted and exported totals match them.
    const { total, costTotal, net } = missionPayoutTotals(
      breakdowns.map((b) => b.total),
      settled.costs.map((c) => c.amount),
    );
    const payout = { total, jobs: breakdowns, costs: settled.costs, net };
    const appliedWeather = this.deliveredWeather(weather, terms, breakdowns);
    this.mission = {
      ...base,
      status: "delivered",
      weather: appliedWeather,
      payout,
      reputationDelta: delta,
      ...(grade ? { landingGrade: grade } : {}),
      wear: settled.wear,
    };
    this.repoTx(() => {
      for (const job of finals) {
        this.setJob({ ...(this.jobs.get(job.id) ?? job), status: "delivered" });
      }
      for (const job of stored) this.setJob(job);
      this.flushBook();
      this.persistMission();
      this.repo?.linkFlight(record.id, m.jobIds, m.payloadKg, payout);
    });
    this.log(
      "info",
      `Mission ${m.id} delivered: $${total} − costs $${costTotal} (reputation ${delta >= 0 ? "+" : ""}${delta}, wear ${settled.wear} %)${stored.length ? `; ${stored.length} job(s) in transit at ${m.destination}` : ""}`,
    );
    for (const [i, job] of finals.entries()) {
      this.store.event("job.completed", {
        jobId: job.id,
        missionId: m.id,
        payout: breakdowns[i]?.total ?? 0,
      });
    }
    for (const job of stored) {
      this.store.event("job.in_transit", {
        jobId: job.id,
        missionId: m.id,
        location: m.destination,
        destination: job.destination,
        storage: job.transit?.storage ?? "airport",
        deadlineGameMs: job.transit?.deadlineGameMs ?? null,
      });
    }
    this.store.event("mission.delivered", { missionId: m.id, flightId: record.id, payout });
    this.publish();
  }

  /**
   * The flight of a mission aborted in the air ended: its real costs (fuel at the landing
   * airport's price, the landing fee where it parked, lease hours) and wear are booked on the
   * aborted mission and the aircraft is released, like a flight.end abort. No payout and no
   * reputation change; the jobs were returned at the abort.
   */
  private endAbortedFlight(record: FlightRecord, last: FlightSample | null): void {
    const pending = this.abortedFlight;
    if (!pending) return;
    this.abortedFlight = null;
    const m = pending.mission;
    const origin = this.airports?.get(m.origin) ?? null;
    const parkedAt =
      last && this.airports
        ? (nearestAirport(this.airports.list, last, ARRIVAL_RADIUS_NM)?.airport ?? null)
        : null;
    const crashed = record.status === "failed" && record.flags.crashed;
    const settled = crashed
      ? this.settle(m, record, origin, null, true)
      : this.settle(m, record, parkedAt ?? origin, parkedAt, false);
    const updated: Mission = {
      ...m,
      flownNm: record.distanceNm,
      elapsedMin: record.blockMin,
      ...(settled.costs.length ? { costs: settled.costs } : {}),
      wear: settled.wear,
    };
    if (this.mission?.id === m.id) this.mission = updated;
    this.repoTx(() => {
      this.flushBook();
      this.repo?.saveMission(updated);
    });
    const costTotal = missionPayoutTotals(
      [],
      settled.costs.map((c) => c.amount),
    ).costTotal;
    this.log(
      "info",
      `Flight ${record.id} of aborted mission ${m.id} ended at ${parkedAt?.ident ?? "no airport"}: costs $${costTotal}, wear ${settled.wear}`,
    );
    this.publish();
  }

  /** Book the leg's costs and wear on the mission aircraft (P4). */
  private settle(
    m: Mission,
    record: FlightRecord,
    fuelAirport: EconomyAirport | null,
    landingAirport: EconomyAirport | null,
    crashed: boolean,
  ): { costs: MissionCost[]; wear: number } {
    if (!m.aircraftId) {
      this.overspeed.reset();
      return { costs: [], wear: 0 };
    }
    return this.settleAircraft(m.aircraftId, record, {
      fuelAirport,
      landingAirport,
      crashed,
      refType: "mission",
      refId: m.id,
      memo: `Mission ${m.id}`,
    });
  }

  /** Costs, wear and (P5) defect rolls of a flown leg on a fleet aircraft. */
  private settleAircraft(
    aircraftId: string,
    record: FlightRecord,
    o: {
      fuelAirport: EconomyAirport | null;
      landingAirport: EconomyAirport | null;
      crashed: boolean;
      refType: string;
      refId: string;
      memo: string;
    },
  ): { costs: MissionCost[]; wear: number } {
    const overspeed = this.overspeed.count;
    this.overspeed.reset();
    const tanksDry = this.tanksDry;
    this.tanksDry = false;
    this.fuelAtStartLb = null;
    const peaks = record.landings
      .map((l) => l.peakG)
      .filter((g): g is number => Number.isFinite(g));
    const r = this.book.settleFlight(aircraftId, {
      fuelKg: record.fuelUsedLb * KG_PER_LB,
      fuelAirport: o.fuelAirport,
      landingAirport: o.landingAirport,
      blockMin: record.blockMin,
      airborneMin: record.airborneMin,
      peakG: peaks.length ? Math.max(...peaks) : null,
      overspeedEvents: overspeed,
      crashed: o.crashed,
      landings: record.landings.length,
      refType: o.refType,
      refId: o.refId,
      memo: o.memo,
      tanksDry,
    });
    this.book.setFlying(aircraftId, false);
    if (!r.ok) {
      this.log("warn", `Could not settle ${o.memo}: ${r.message}`);
      return { costs: [], wear: 0 };
    }
    return { costs: r.data.costs, wear: r.data.wear.total };
  }

  // ---- commands ----

  handles(name: string): boolean {
    return (
      name.startsWith("job.") ||
      name.startsWith("jobs.") ||
      name.startsWith("mission.") ||
      name.startsWith("fleet.") ||
      name.startsWith("loan.") ||
      name.startsWith("market.") ||
      name.startsWith("fbo.") ||
      name.startsWith("insurance.") ||
      name.startsWith("pilot.") ||
      name === "settings.update"
    );
  }

  command(cmd: Command): Result {
    const r =
      cmd.name.startsWith("fleet.") ||
      cmd.name.startsWith("loan.") ||
      cmd.name.startsWith("market.") ||
      cmd.name.startsWith("fbo.") ||
      cmd.name.startsWith("insurance.") ||
      cmd.name.startsWith("pilot.")
        ? this.runCompany(cmd)
        : this.run(cmd);
    if (!r.ok) {
      return {
        type: "result",
        v: PROTOCOL_VERSION,
        id: cmd.id,
        ok: false,
        error: {
          code: r.code,
          message: r.message,
          ...(r.reasons?.length ? { reasons: r.reasons } : {}),
        },
      };
    }
    return { type: "result", v: PROTOCOL_VERSION, id: cmd.id, ok: true, data: r.data };
  }

  private run(cmd: Command): Ok<unknown> | Fail {
    const args = cmd.args ?? {};
    switch (cmd.name) {
      case "jobs.list":
        if (this.expire(true)) this.publish();
        return { ok: true, data: this.jobsDomain() };
      case "jobs.refresh": {
        const p = jobsRefreshArgsSchema.safeParse(args);
        if (!p.success) return fail("bad_args", p.error.issues[0]?.message ?? "invalid arguments");
        if (!this.airports) return fail("no_airport_data", "Airport data is not available");
        const airport = (p.data.airport ?? this.currentAirport()).toUpperCase();
        if (!this.airports.get(airport))
          return fail("unknown_airport", `Unknown airport ${airport}`);
        const focus = p.data.destination?.toUpperCase();
        if (focus && !this.airports.get(focus))
          return fail("unknown_airport", `Unknown airport ${focus}`);
        const jobs = this.generateBoard(airport, focus);
        this.publish();
        return { ok: true, data: { board: this.company.boards[0], jobs: jobs.length } };
      }
      case "job.accept": {
        const p = jobIdArgsSchema.safeParse(args);
        if (!p.success) return fail("bad_args", "jobId is required");
        this.expire(false);
        const job = this.jobs.get(p.data.jobId);
        if (!job || job.status !== "available")
          return fail("job_unavailable", "That job is no longer available");
        const accepted = [...this.jobs.values()].filter((j) => j.status !== "available").length;
        if (accepted >= MAX_ACCEPTED)
          return fail("too_many_jobs", `At most ${MAX_ACCEPTED} accepted jobs`);
        const next: Job = {
          ...job,
          status: "accepted",
          acceptedAt: new Date(this.now()).toISOString(),
        };
        this.setJob(next);
        this.publish();
        return { ok: true, data: next };
      }
      case "job.release": {
        const p = jobIdArgsSchema.safeParse(args);
        if (!p.success) return fail("bad_args", "jobId is required");
        const job = this.jobs.get(p.data.jobId);
        if (job?.status === "in_transit") return this.abandonTransit(job);
        if (!job || job.status !== "accepted") {
          return fail(
            job?.status === "loaded" ? "job_loaded" : "job_not_accepted",
            job?.status === "loaded" ? "Unload the mission first" : "That job is not accepted",
          );
        }
        const { acceptedAt: _a, ...rest } = job;
        const expired = Date.parse(job.expiresAt) <= this.now();
        this.setJob({ ...rest, status: expired ? "expired" : "available" });
        this.publish();
        return { ok: true, data: { jobId: job.id, status: expired ? "expired" : "available" } };
      }
      case "mission.load": {
        const p = missionLoadArgsSchema.safeParse(args);
        if (!p.success) return fail("bad_args", "jobIds is required");
        return this.load(p.data.jobIds, p.data.destination?.toUpperCase(), p.data.enteredPayloadKg);
      }
      case "mission.payload": {
        // docs/ECONOMY.md "Payload entered by you": before departure only (frozen after).
        const p = missionPayloadArgsSchema.safeParse(args);
        if (!p.success) return fail("bad_args", "kg must be a number from 0 to 200,000 or null");
        const m = this.mission;
        if (!m || (m.status !== "loaded" && m.status !== "in_progress"))
          return fail("no_mission", "No mission is loaded");
        if (m.status === "in_progress")
          return fail(
            "mission_in_progress",
            "The payload check was frozen at departure; the entered payload can no longer change",
          );
        const kg = p.data.kg === null ? null : round1(p.data.kg);
        const next: Mission = { ...m, enteredPayloadKg: kg };
        this.mission = { ...next, payloadCheck: this.payloadCheckNow(next, "preview") };
        this.log(
          "info",
          kg === null
            ? `Mission ${m.id}: payload entered by you cleared`
            : `Mission ${m.id}: payload entered by you ${kg} kg (player value, not sim)`,
        );
        this.persistMission();
        this.publish();
        return { ok: true, data: this.mission };
      }
      case "mission.unload": {
        const m = this.mission;
        if (!m || (m.status !== "loaded" && m.status !== "in_progress"))
          return fail("no_mission", "No mission is loaded");
        if (m.status === "in_progress")
          return fail("mission_in_progress", "The mission is flying; abort it instead");
        this.returnJobs(m, "accepted");
        this.persist(() => this.repo?.deleteMission(m.id));
        this.mission = null;
        this.publishedMissionId = null;
        this.store.apply({ mission: null });
        this.publish();
        return { ok: true, data: { missionId: m.id } };
      }
      case "mission.abort": {
        const m = this.mission;
        if (!m || (m.status !== "loaded" && m.status !== "in_progress"))
          return fail("no_mission", "No mission is open");
        const aborted: Mission = {
          ...m,
          status: "aborted",
          endedAt: new Date(this.now()).toISOString(),
        };
        this.mission = aborted;
        // In the air: the aircraft keeps flying; the flight's costs are booked when it ends.
        if (m.status === "in_progress" && m.flightId) {
          this.abortedFlight = { mission: aborted, flightId: m.flightId };
        }
        this.returnJobs(m, "accepted");
        this.persistMission();
        this.publish();
        return { ok: true, data: this.mission };
      }
      case "settings.update": {
        const p = settingsUpdateArgsSchema.safeParse(args);
        if (!p.success) return fail("bad_args", p.error.issues[0]?.message ?? "invalid arguments");
        const before = this.activeType().type.key;
        if (p.data.aircraftType !== undefined) {
          if (p.data.aircraftType !== null && !aircraftTypeByKey(p.data.aircraftType)) {
            return fail("unknown_type", `Unknown aircraft type ${p.data.aircraftType}`);
          }
          this.company = { ...this.company, aircraftTypeOverride: p.data.aircraftType };
        }
        if (p.data.base !== undefined) {
          const base = p.data.base.toUpperCase();
          if (!this.airports?.get(base)) return fail("unknown_airport", `Unknown airport ${base}`);
          this.company = { ...this.company, base };
        }
        if (p.data.crewAllowanceKg !== undefined) {
          const kg = p.data.crewAllowanceKg === null ? null : round1(p.data.crewAllowanceKg);
          this.company = { ...this.company, crewAllowanceKg: kg };
          this.refreshPayloadPreview();
        }
        this.persist(() => this.repo?.saveCompany(this.company));
        if (this.activeType().type.key !== before) this.retypeBoard();
        this.publish();
        return {
          ok: true,
          data: { company: this.companyDomain(), aircraft: this.jobsDomain().aircraft },
        };
      }
      default:
        return fail(
          "not_implemented",
          `Command ${cmd.name} is not implemented in this connector version`,
        );
    }
  }

  /** fleet.* and loan.* commands (P4): validate, apply to the book, persist, publish. */
  private runCompany(cmd: Command): Ok<unknown> | Fail {
    const args = cmd.args ?? {};
    const bad = (e: { issues: Array<{ message: string; path: Array<string | number> }> }) =>
      fail(
        "bad_args",
        e.issues[0] ? `${e.issues[0].path.join(".")}: ${e.issues[0].message}` : "invalid arguments",
      );
    const onMission = (aircraftId: string): Fail | null => {
      const m = this.mission;
      if (
        m &&
        m.aircraftId === aircraftId &&
        (m.status === "loaded" || m.status === "in_progress")
      ) {
        return fail(
          "aircraft_on_mission",
          `The aircraft is on mission ${m.id}; unload or finish it first`,
        );
      }
      return null;
    };
    const done = <T>(r: BookResult<T>): Ok<T> | Fail => {
      if (!r.ok) {
        // A refused command may still have changed state (hidden defects surfacing).
        if (this.book.hasPending) this.publish();
        return fail(r.code, r.message, r.reasons);
      }
      this.publish();
      return { ok: true, data: r.data };
    };
    switch (cmd.name) {
      case "fleet.buy": {
        const p = fleetBuyArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(
          this.book.buy({
            typeKey: p.data.typeKey,
            ...(p.data.airport ? { airport: p.data.airport } : {}),
            ...(p.data.financing ? { financing: p.data.financing } : {}),
          }),
        );
      }
      case "fleet.sell": {
        const p = fleetSellArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return onMission(p.data.aircraftId) ?? done(this.book.sell(p.data.aircraftId));
      }
      case "fleet.lease": {
        const p = fleetLeaseArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(
          this.book.lease({
            typeKey: p.data.typeKey,
            kind: p.data.kind,
            ...(p.data.airport ? { airport: p.data.airport } : {}),
          }),
        );
      }
      case "fleet.return": {
        const p = fleetReturnArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return onMission(p.data.aircraftId) ?? done(this.book.returnLease(p.data.aircraftId));
      }
      case "fleet.repair": {
        const p = fleetRepairArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return onMission(p.data.aircraftId) ?? done(this.book.repair(p.data.aircraftId));
      }
      case "fleet.select": {
        const p = fleetSelectArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        const m = this.mission;
        if (m && (m.status === "loaded" || m.status === "in_progress")) {
          return fail(
            "mission_active",
            "Change aircraft after the open mission is unloaded or done",
          );
        }
        const before = this.activeType().type.key;
        const r = this.book.select(p.data.aircraftId);
        if (r.ok && this.activeType().type.key !== before) this.retypeBoard();
        return done(r.ok ? { ok: true, data: this.fleetDomain() } : r);
      }
      case "loan.quote": {
        const p = loanQuoteArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        const r = this.book.quote({
          principal: p.data.principal,
          termMonths: p.data.termMonths,
          ...(p.data.lenderId ? { lenderId: p.data.lenderId } : {}),
          ...(p.data.collateralValue !== undefined
            ? { collateralValue: p.data.collateralValue }
            : {}),
          ...(p.data.collateral ? { collateral: p.data.collateral } : {}),
        });
        return r.ok ? { ok: true, data: { quotes: r.data } } : fail(r.code, r.message);
      }
      case "loan.take": {
        const p = loanTakeArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.takeLoan(p.data));
      }
      case "loan.payoff": {
        const p = loanPayoffArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.payoff(p.data.loanId));
      }
      // ---- P5 used market and airworthiness ----
      case "market.refresh": {
        const p = marketRefreshArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.refreshMarket());
      }
      case "market.inspect": {
        const p = marketInspectArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.inspectListing(p.data.listingId));
      }
      case "market.buy": {
        const p = marketBuyArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(
          this.book.buyListing({
            listingId: p.data.listingId,
            ...(p.data.financing ? { financing: p.data.financing } : {}),
          }),
        );
      }
      case "fleet.repairDefect": {
        const p = fleetRepairDefectArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return (
          onMission(p.data.aircraftId) ??
          done(this.book.repairDefect(p.data.aircraftId, p.data.defectId))
        );
      }
      case "fleet.repairAll": {
        const p = fleetRepairAllArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return onMission(p.data.aircraftId) ?? done(this.book.repairAll(p.data.aircraftId));
      }
      case "fleet.annual": {
        const p = fleetAnnualArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return onMission(p.data.aircraftId) ?? done(this.book.annualInspection(p.data.aircraftId));
      }
      case "fleet.ferryPermit": {
        const p = fleetFerryPermitArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return onMission(p.data.aircraftId) ?? done(this.book.ferryPermit(p.data.aircraftId));
      }
      case "fleet.defer": {
        const p = fleetDeferArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.defer(p.data.aircraftId, p.data.defectId));
      }
      // ---- P5 part 2: FBOs and insurance ----
      case "fbo.buy":
      case "fbo.build": {
        const p = (cmd.name === "fbo.buy" ? fboBuyArgsSchema : fboBuildArgsSchema).safeParse(args);
        if (!p.success) return bad(p.error);
        const a = {
          icao: p.data.icao.toUpperCase(),
          ...(p.data.financing ? { financing: p.data.financing } : {}),
        };
        return done(cmd.name === "fbo.buy" ? this.book.buyFbo(a) : this.book.buildFbo(a));
      }
      case "fbo.sell": {
        const p = fboSellArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.sellFbo(p.data.fboId));
      }
      case "fbo.module.buy": {
        const p = fboModuleBuyArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.buyModule(p.data.fboId, p.data.module));
      }
      case "fbo.module.upgrade": {
        const p = fboModuleUpgradeArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.upgradeModule(p.data.fboId, p.data.module));
      }
      case "fbo.pricing": {
        const p = fboPricingArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(
          this.book.setFboPricing(p.data.fboId, {
            fuelPriceRatio: p.data.fuelPriceRatio,
            handlingFeeUsd: p.data.handlingFeeUsd,
          }),
        );
      }
      case "insurance.buy": {
        const p = insuranceBuyArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.buyInsurance(p.data.aircraftId));
      }
      case "insurance.cancel": {
        const p = insuranceCancelArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.cancelInsurance(p.data.aircraftId));
      }
      case "insurance.repairLoan": {
        const p = insuranceRepairLoanArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return (
          onMission(p.data.aircraftId) ??
          done(
            this.book.repairLoan({
              aircraftId: p.data.aircraftId,
              repair: p.data.repair,
              ...(p.data.defectId !== undefined ? { defectId: p.data.defectId } : {}),
              principal: p.data.principal,
              termMonths: p.data.termMonths,
            }),
          )
        );
      }
      // ---- hired pilots (simulated operations) ----
      case "pilot.hire": {
        const p = pilotHireArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.hirePilot(p.data.rating));
      }
      case "pilot.fire": {
        const p = pilotFireArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.firePilot(p.data.pilotId));
      }
      case "pilot.assign": {
        const p = pilotAssignArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        // An aircraft with a loaded or flying mission stays with the player.
        return (
          onMission(p.data.aircraftId) ??
          done(
            this.book.assignPilot({
              pilotId: p.data.pilotId,
              aircraftId: p.data.aircraftId,
              destination: p.data.destination,
              ...(p.data.origin ? { origin: p.data.origin } : {}),
              served: this.servedExtra(),
            }),
          )
        );
      }
      case "pilot.unassign": {
        const p = pilotUnassignArgsSchema.safeParse(args);
        if (!p.success) return bad(p.error);
        return done(this.book.unassignPilot(p.data.pilotId));
      }
      default:
        return fail(
          "not_implemented",
          `Command ${cmd.name} is not implemented in this connector version`,
        );
    }
  }

  private load(
    ids: string[],
    legDestination?: string,
    enteredPayloadKg?: number,
  ): Ok<Mission> | Fail {
    if (
      this.mission &&
      (this.mission.status === "loaded" || this.mission.status === "in_progress")
    ) {
      return fail("mission_active", "A mission is already loaded");
    }
    const unique = [...new Set(ids)];
    const jobs: Job[] = [];
    for (const id of unique) {
      const job = this.jobs.get(id);
      if (!job || (job.status !== "accepted" && job.status !== "in_transit"))
        return fail("job_not_accepted", `Job ${id} is not accepted`);
      jobs.push(job);
    }
    const firstJob = jobs[0];
    if (!firstJob) return fail("bad_args", "No jobs");
    // The leg starts where the cargo is (its origin, or its transit stop).
    const legOrigin = jobLocation(firstJob);
    if (jobs.some((j) => jobLocation(j) !== legOrigin)) {
      return fail("mixed_route", "Stacked jobs must be at the same airport");
    }
    let legDest = legDestination;
    if (!legDest) {
      if (jobs.some((j) => j.destination !== firstJob.destination)) {
        return fail(
          "mixed_route",
          "Stacked jobs must share the same destination (or set a leg destination for transit)",
        );
      }
      legDest = firstJob.destination;
    }
    if (legDest === legOrigin) {
      return fail("same_airport", `The leg must leave ${legOrigin}`);
    }
    const first = { origin: legOrigin, destination: legDest };
    // Transit cargo: every job going further must get closer to its final destination.
    if (jobs.some((j) => j.destination !== legDest)) {
      const from = this.airports?.get(legOrigin);
      const to = this.airports?.get(legDest);
      if (!from || !to) return fail("unknown_airport", "Unknown mission airport");
      for (const j of jobs) {
        const final = this.airports?.get(j.destination);
        if (!final) return fail("unknown_airport", `Unknown airport ${j.destination}`);
        const progress = checkTransitProgress(j, from, to, final);
        if (!progress.ok) return fail(progress.code, progress.message);
      }
    }
    // P4: the mission is flown with a fleet aircraft parked at the origin.
    const selection = this.selection();
    const aircraft = this.book.aircraft(selection.id);
    if (!aircraft) {
      return selection.ambiguous
        ? fail(
            "aircraft_ambiguous",
            "Several fleet aircraft match the simulator aircraft: pick one on the Fleet page",
          )
        : fail("no_aircraft", "Select an aircraft you own or lease (Fleet page)");
    }
    const ready = this.aircraftReady(aircraft, first.origin);
    if (!ready.ok) {
      if (this.book.hasPending) this.publish();
      return ready;
    }
    const type = aircraftTypeByKey(aircraft.typeKey) ?? this.activeType().type;
    const origin = this.airports?.get(first.origin);
    const dest = this.airports?.get(first.destination);
    if (!origin || !dest) return fail("unknown_airport", "Unknown mission airport");
    const distanceNm = round1(greatCircleNm(origin, dest));
    if (distanceNm > maxJobDistanceNm(type)) {
      return fail(
        "out_of_range",
        `${distanceNm} nm is beyond 80 % of the ${type.name}'s ${type.rangeNm} nm range`,
      );
    }
    const rwy = runwaySuitability(dest, type);
    if (!rwy.ok) {
      return fail(
        "runway_unsuitable",
        `${dest.ident} runway does not suit the ${type.name} (${rwy.issues.join(", ")})`,
      );
    }
    const payloadKg = jobs.reduce((s, j) => s + j.weightKg, 0);
    // P5: open major defects reduce the max payload (≤ 30 %).
    const penalty = this.book.gate(aircraft).payloadPenaltyPct;
    const limit = Math.floor(payloadLimitKg(type, distanceNm) * (1 - penalty / 100));
    if (payloadKg > limit) {
      return fail(
        "payload_exceeded",
        `${payloadKg} kg exceeds the ${limit} kg the ${type.name} can carry on this leg (max payload − leg fuel${penalty > 0 ? `, −${penalty} % for major defects` : ""})`,
      );
    }
    const id = this.newId();
    const loaded = jobs.map((j) => ({ ...j, status: "loaded" as const, missionId: id }));
    const transitIds = loaded.filter((j) => j.destination !== first.destination).map((j) => j.id);
    const gameMs = this.company.gameMs;
    const mission: Mission = {
      id,
      status: "loaded",
      origin: first.origin,
      destination: first.destination,
      jobIds: loaded.map((j) => j.id),
      jobs: loaded,
      aircraftKey: type.key,
      aircraftId: aircraft.id,
      registration: aircraft.registration,
      payloadKg,
      distanceNm,
      // Tightest time left (a transit job has already used part of its chain; negative = late)
      // and the payout of the jobs delivered on this leg (transit cargo pays on its final
      // delivery, with the late penalty it has accrued).
      ...missionLegTerms(loaded, first.destination, gameMs, this.company.reputation),
      createdAt: new Date(this.now()).toISOString(),
      ...(transitIds.length ? { transitJobIds: transitIds } : {}),
      ...(enteredPayloadKg !== undefined ? { enteredPayloadKg: round1(enteredPayloadKg) } : {}),
    };
    mission.payloadCheck = this.payloadCheckNow(mission, "preview");
    this.repoTx(() => {
      for (const j of loaded) this.setJob(j);
      this.mission = mission;
      this.persistMission();
    });
    this.publish();
    return { ok: true, data: mission };
  }

  /**
   * The aircraft can fly a mission from `origin` now: not in maintenance or busy, no ferry
   * permit (a ferry carries no revenue), and the P5 airworthiness gate passes after any
   * hidden defects surface (`aircraft_unairworthy` with every reason).
   */
  private aircraftReady(a: BookAircraft, origin: string): Ok<null> | Fail {
    if (a.status === "maintenance") {
      const at = a.readyAtGameMs !== null ? ` until ${formatGameTime(a.readyAtGameMs)}` : "";
      return fail("aircraft_in_maintenance", `${a.registration} is in maintenance${at}`);
    }
    if (a.status === "hired") {
      const pilot = this.book.pilotOf(a.id);
      const route = pilot?.assignment
        ? ` on ${pilot.assignment.origin}–${pilot.assignment.destination}`
        : "";
      return fail(
        "aircraft_with_hired_pilot",
        `${a.registration} is flown by hired pilot ${pilot?.name ?? ""}${route} (simulated): unassign the pilot on the Fleet page to fly it yourself`,
      );
    }
    if (a.status !== "available") return fail("aircraft_busy", `${a.registration} is ${a.status}`);
    if (a.ferryPermit) {
      return fail(
        "ferry_only",
        `${a.registration} holds a ferry permit to ${a.ferryPermit.destination}: fly the ferry first (no revenue)`,
      );
    }
    const gate = this.book.dispatchCheck(a.id);
    if (!gate.ok) return fail(gate.code, gate.message, gate.reasons);
    if (a.location !== origin) {
      return fail(
        "aircraft_not_at_origin",
        `${a.registration} is parked at ${a.location}, not at ${origin}`,
      );
    }
    return { ok: true, data: null };
  }

  // ---- boards ----

  private currentAirport(): string {
    const pos = this.store.getDomain("position") as { lat: number; lon: number } | null | undefined;
    const motion = this.store.getDomain("motion") as { onGround: boolean } | null | undefined;
    if (pos && motion?.onGround && this.airports) {
      const near = nearestAirport(this.airports.list, pos, 3);
      if (near) return near.airport.ident;
    }
    return this.company.boards[0]?.origin ?? this.company.base;
  }

  /** Replace `airport`'s available jobs with a fresh board (newest first, max 4 boards). */
  generateBoard(airport: string, focus?: string): Job[] {
    if (!this.airports) return [];
    const origin = this.airports.get(airport);
    if (!origin) return [];
    const type = this.activeType().type;
    const counter = this.company.boardCounter + 1;
    const seed = boardSeed(this.company.seed, origin.ident, type.key, counter);
    const focusAirport = focus ? this.airports.get(focus) : null;
    // P5 part 2: local demand and an own cargo terminal shape the board.
    const market = this.book.jobDemand(origin.ident);
    const jobs = generateJobs({
      demand: market.demand,
      extraJobs: market.extraJobs,
      // Transit cargo: long-haul jobs that need a stop (drawn after the rest).
      longHaulJobs: LONG_HAUL_JOBS_PER_BOARD,
      origin,
      airports: this.airports.list,
      aircraft: type,
      seed,
      nowMs: this.now(),
      reputation: this.company.reputation,
      focus: focusAirport,
    });
    const board: JobBoard = {
      origin: origin.ident,
      generatedAt: new Date(this.now()).toISOString(),
      seed,
      aircraftKey: type.key,
      ...(focusAirport ? { focus: focusAirport.ident } : {}),
    };
    const boards = [board, ...this.company.boards.filter((b) => b.origin !== origin.ident)];
    const dropped = boards.slice(MAX_BOARDS).map((b) => b.origin);
    const drop = new Set([origin.ident, ...dropped]);
    const stale = [...this.jobs.values()].filter(
      (j) => j.status === "available" && drop.has(j.origin),
    );
    this.repoTx(() => {
      for (const j of stale) this.jobs.delete(j.id);
      this.repo?.deleteJobs(stale.map((j) => j.id));
      for (const j of jobs) {
        if (this.jobs.has(j.id)) continue;
        this.jobs.set(j.id, j);
        this.repo?.saveJob(j);
      }
      this.company = {
        ...this.company,
        boardCounter: counter,
        boards: boards.slice(0, MAX_BOARDS),
      };
      this.repo?.saveCompany(this.company);
    });
    this.simMinSinceBoard = 0;
    this.log("info", `Job board ${origin.ident}: ${jobs.length} jobs for the ${type.name}`);
    return jobs;
  }

  private retypeBoard(): void {
    const newest = this.company.boards[0];
    if (newest && newest.aircraftKey !== this.activeType().type.key)
      this.generateBoard(newest.origin);
  }

  /** Drop available jobs past their expiry. Returns true when anything changed. */
  private expire(force: boolean): boolean {
    const now = this.now();
    this.lastExpiryCheck = now;
    const gone = [...this.jobs.values()].filter(
      (j) => j.status === "available" && Date.parse(j.expiresAt) <= now,
    );
    if (gone.length === 0) return false;
    this.repoTx(() => {
      for (const j of gone) {
        this.jobs.delete(j.id);
        this.repo?.saveJob({ ...j, status: "expired" });
      }
    });
    if (force) this.log("info", `${gone.length} job(s) expired`);
    return true;
  }

  // ---- persistence helpers ----

  private setJob(job: Job): void {
    if (
      job.status === "available" ||
      job.status === "accepted" ||
      job.status === "loaded" ||
      job.status === "in_transit"
    ) {
      this.jobs.set(job.id, job);
    } else this.jobs.delete(job.id);
    this.persist(() => this.repo?.saveJob(job));
  }

  /**
   * Move a mission's jobs to a new status (accepted again, delivered or failed). "accepted"
   * puts transit cargo back where it was stored (in_transit, its stop and clock unchanged).
   */
  private returnJobs(m: Mission, status: "accepted" | "delivered" | "failed"): void {
    for (const j of m.jobs) {
      const current = this.jobs.get(j.id) ?? j;
      if (status === "accepted") {
        const { missionId: _m, ...rest } = current;
        this.setJob({ ...rest, status: current.transit ? "in_transit" : "accepted" });
      } else this.setJob({ ...current, status });
    }
  }

  /** job.release of cargo in transit: abandoned there, failed, no payout, reputation −3. */
  private abandonTransit(job: Job): Ok<unknown> | Fail {
    const { missionId: _m, ...rest } = job;
    this.repoTx(() => {
      this.setJob({ ...rest, status: "failed" });
      this.book.adjustReputation(TRANSIT_ABANDON_REPUTATION);
      this.flushBook();
    });
    this.log(
      "warn",
      `Job ${job.id} abandoned in transit at ${jobLocation(job)} (reputation ${TRANSIT_ABANDON_REPUTATION})`,
    );
    this.store.event("job.abandoned", {
      jobId: job.id,
      location: jobLocation(job),
      reputationDelta: TRANSIT_ABANDON_REPUTATION,
    });
    this.publish();
    return {
      ok: true,
      data: { jobId: job.id, status: "failed", reputationDelta: TRANSIT_ABANDON_REPUTATION },
    };
  }

  private persistMission(): void {
    const m = this.mission;
    if (m) this.persist(() => this.repo?.saveMission(m));
  }

  private repoTx(fn: () => void): void {
    if (!this.repo) {
      fn();
      return;
    }
    try {
      this.repo.transaction(fn);
    } catch (err) {
      this.log("warn", `Could not write economy data: ${err instanceof Error ? err.message : err}`);
    }
  }

  private persist(write: () => void): void {
    if (!this.repo) return;
    try {
      write();
    } catch (err) {
      this.log("warn", `Could not write economy data: ${err instanceof Error ? err.message : err}`);
    }
  }

  private persistRead<T>(read: () => T): T | null {
    try {
      return read();
    } catch (err) {
      this.log("warn", `Could not read economy data: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  /** Reload everything from the database (after an import). */
  reload(): void {
    this.ferry = null;
    this.abortedFlight = null;
    this.aiDetector.reset();
    this.book = this.loadBook();
    this.jobs.clear();
    for (const job of this.persistRead(
      () => this.repo?.listJobs(["available", "accepted", "loaded", "in_transit"]) ?? [],
    ) ?? [])
      this.jobs.set(job.id, job);
    this.mission = this.persistRead(() => this.repo?.openMission() ?? null);
    this.recoverAfterRestart();
    this.publishedMissionId = null;
    this.store.apply({ mission: null });
    this.publish();
  }

  /** True while a mission is flying (imports are refused then). */
  get missionInProgress(): boolean {
    return (
      this.mission?.status === "in_progress" || this.ferry !== null || this.abortedFlight !== null
    );
  }
}
