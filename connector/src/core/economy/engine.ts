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
// - deliver: when the flight completes (Arrived: parked, engines off, brake set) the
//   leg is verified (distance ≥ 90 % of the great circle, parked within 3 nm of the
//   destination, no teleport, not invalidated) and every job is paid with a full
//   breakdown. Crash → mission failed, no payout, −20 reputation. A flight that is
//   aborted (flight.end abort, session reset) aborts the mission; its jobs go back to
//   accepted.
//
// All of it is deterministic: boards come from the company seed, the board airport,
// the aircraft type and a counter; the clock and ids are injected.

import { randomInt, randomUUID } from "node:crypto";
import {
  PROTOCOL_VERSION,
  jobIdArgsSchema,
  jobsRefreshArgsSchema,
  missionLoadArgsSchema,
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
} from "../../protocol";
import {
  BOARD_REFRESH_SIM_MIN,
  REPUTATION,
  STARTING_CASH,
  airportLookup,
  boardSeed,
  checkAtOrigin,
  clampReputation,
  computePayout,
  deliveryReputationDelta,
  generateJobs,
  greatCircleNm,
  legFuelKg,
  maxJobDistanceNm,
  nearestAirport,
  payloadLimitKg,
  reputationTier,
  round1,
  runwaySuitability,
  verifyLeg,
  type AirportLookup,
  type EconomyAirport,
} from "../../economy";
import type { LogFn } from "../../sim/source";
import type { CompanyRecord, EconomyRepo } from "../../storage/economy";
import type { FlightHooks } from "../flight-core";
import type { FlightSample } from "../flight-sample";
import type { FlightRecord } from "../flight-tracker";
import type { StateStore } from "../store";

const KG_PER_LB = 0.45359237;
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
}

type Fail = { ok: false; code: string; message: string };
type Ok<T> = { ok: true; data: T };

const fail = (code: string, message: string): Fail => ({ ok: false, code, message });

export class EconomyEngine {
  private readonly store: StateStore;
  private readonly repo: EconomyRepo | null;
  private readonly airports: AirportLookup | null;
  private readonly log: LogFn;
  private readonly now: () => number;
  private readonly newId: () => string;
  private company: CompanyRecord;
  /** Open jobs: available, accepted or loaded. */
  private readonly jobs = new Map<string, Job>();
  private mission: Mission | null = null;
  private publishedMissionId: string | null = null;
  private title: string | null = null;
  private lastParked: { lat: number; lon: number } | null = null;
  private lastTMs: number | null = null;
  private simMinSinceBoard = 0;
  private lastExpiryCheck = 0;

  constructor(options: EconomyOptions) {
    this.store = options.store;
    this.repo = options.repo ?? null;
    this.airports = options.airports ? airportLookup(options.airports) : null;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => `M-${randomUUID().slice(0, 8).toUpperCase()}`);
    const stored = this.persistRead(() => this.repo?.getCompany() ?? null);
    this.company = stored ?? {
      name: "Cargo Ops Logistics",
      base: "KMEM",
      cash: STARTING_CASH,
      reputation: REPUTATION.start,
      seed: options.seed ?? (options.replay ? DEMO_COMPANY_SEED : randomInt(0, 2 ** 31)),
      boardCounter: 0,
      boards: [],
      aircraftTypeOverride: null,
    };
    if (!stored) this.persist(() => this.repo?.saveCompany(this.company));
    for (const job of this.persistRead(
      () => this.repo?.listJobs(["available", "accepted", "loaded"]) ?? [],
    ) ?? [])
      this.jobs.set(job.id, job);
    this.mission = this.persistRead(() => this.repo?.openMission() ?? null);
    if (!this.airports) this.log("warn", "No airport data: job boards are disabled");
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

  activeType(): { type: AircraftType; source: AircraftTypeSource } {
    return resolveAircraftType(this.title, this.company.aircraftTypeOverride);
  }

  companyDomain(): CompanyState {
    return {
      name: this.company.name,
      base: this.company.base,
      cash: Math.round(this.company.cash * 100) / 100,
      reputation: this.company.reputation,
      reputationTier: reputationTier(this.company.reputation),
    };
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
      aircraft: {
        typeKey: type.key,
        name: type.name,
        source,
        ...(this.title ? { title: this.title } : {}),
      },
    };
  }

  /** Domains merged into a reset snapshot so a replay restart never drops them. */
  domains(): { company: CompanyState; jobs: JobsState; mission?: Mission } {
    return {
      company: this.companyDomain(),
      jobs: this.jobsDomain(),
      ...(this.mission ? { mission: this.mission } : {}),
    };
  }

  publish(): void {
    if (this.mission && this.mission.id !== this.publishedMissionId) {
      if (this.publishedMissionId !== null) this.store.apply({ mission: null });
      this.publishedMissionId = this.mission.id;
    }
    this.store.apply({
      company: this.companyDomain(),
      jobs: this.jobsDomain(),
      ...(this.mission ? { mission: this.mission } : {}),
    });
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
      referenceSpeedKt: () => this.activeType().type.approachKt,
    };
  }

  private beforeStart(s: FlightSample): { code: string; message: string } | null {
    const m = this.mission;
    if (!m || m.status !== "loaded") return null;
    const r = this.startChecks(m, s);
    return r.ok ? null : { code: r.code, message: r.message };
  }

  private startChecks(m: Mission, at: { lat: number; lon: number } | null): Ok<null> | Fail {
    const origin = this.airports?.get(m.origin);
    if (!origin) return fail("unknown_airport", `Unknown origin ${m.origin}`);
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

  private onSample(s: FlightSample, flight: FlightState | null, onGround: boolean | null): void {
    if (onGround === true && s.parkingBrake === true) this.lastParked = { lat: s.lat, lon: s.lon };
    else if (onGround === false) this.lastParked = null;

    if (this.lastTMs !== null && s.tMs > this.lastTMs && s.tMs - this.lastTMs < 600_000) {
      this.simMinSinceBoard += (s.tMs - this.lastTMs) / 60_000;
    }
    this.lastTMs = s.tMs;
    let changed = false;
    if (this.simMinSinceBoard >= BOARD_REFRESH_SIM_MIN && this.company.boards[0]) {
      this.log("info", "Scheduled job board refresh (in-game time)");
      this.generateBoard(this.company.boards[0].origin);
      changed = true;
    }
    const wall = this.now();
    if (wall - this.lastExpiryCheck > 60_000) changed = this.expire(false) || changed;

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
    const m = this.mission;
    if (!m || m.status !== "loaded") return;
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
    this.mission = {
      ...rest,
      status: "in_progress",
      flightId: record.id,
      startedAt: new Date(this.now()).toISOString(),
      flownNm: record.distanceNm,
      elapsedMin: record.blockMin,
    };
    this.persist(() => this.repo?.linkFlight(record.id, m.jobIds, m.payloadKg, null));
    this.persistMission();
    this.log("info", `Mission ${m.id} started on flight ${record.id}`);
    this.store.event("mission.started", { missionId: m.id, flightId: record.id });
    this.publish();
  }

  private onFlightEnded(record: FlightRecord, last: FlightSample | null): void {
    const m = this.mission;
    if (!m || m.status !== "in_progress" || m.flightId !== record.id) return;
    const endedAt = new Date(this.now()).toISOString();
    const base: Mission = {
      ...m,
      endedAt,
      flownNm: record.distanceNm,
      elapsedMin: record.blockMin,
    };
    if (record.status === "aborted") {
      this.mission = { ...base, status: "aborted" };
      this.returnJobs(m, "accepted");
      this.persistMission();
      this.log("info", `Mission ${m.id} aborted with its flight; jobs returned to accepted`);
      this.publish();
      return;
    }
    const origin = this.airports?.get(m.origin) ?? null;
    const dest = this.airports?.get(m.destination) ?? null;
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
      const delta = verdict.code === "crashed" ? REPUTATION.crash : 0;
      this.company = {
        ...this.company,
        reputation: clampReputation(this.company.reputation + delta),
      };
      this.mission = {
        ...base,
        status: "failed",
        failure: { code: verdict.code, message: verdict.message },
        ...(grade ? { landingGrade: grade } : {}),
        reputationDelta: delta,
      };
      this.returnJobs(m, "failed");
      this.persist(() => this.repo?.saveCompany(this.company));
      this.persistMission();
      this.persist(() =>
        this.repo?.linkFlight(record.id, m.jobIds, m.payloadKg, { failure: verdict }),
      );
      this.log("warn", `Mission ${m.id} failed: ${verdict.message}`);
      this.store.event("mission.failed", {
        missionId: m.id,
        code: verdict.code,
        message: verdict.message,
      });
      this.publish();
      return;
    }

    const reputation = this.company.reputation;
    const breakdowns = m.jobs.map((job) =>
      computePayout({
        jobId: job.id,
        kind: job.kind,
        weightKg: job.weightKg,
        distanceNm: job.distanceNm,
        units: job.units,
        reputation,
        estimate: false,
        landingGrade: grade,
        lateMin: record.blockMin - job.timeLimitMin,
        peakG: landing?.peakG ?? null,
        noBonus: record.flags.noBonus,
      }),
    );
    const total = breakdowns.reduce((s, b) => s + b.total, 0);
    const maxLate = Math.max(0, ...m.jobs.map((j) => record.blockMin - j.timeLimitMin));
    const delta = deliveryReputationDelta(grade, maxLate);
    const at = this.now();
    this.company = {
      ...this.company,
      cash: this.company.cash + total,
      reputation: clampReputation(reputation + delta),
    };
    const payout = { total, jobs: breakdowns };
    this.mission = {
      ...base,
      status: "delivered",
      payout,
      reputationDelta: delta,
      ...(grade ? { landingGrade: grade } : {}),
    };
    this.repoTx(() => {
      this.returnJobs(m, "delivered");
      this.repo?.saveCompany(this.company);
      for (const [i, job] of m.jobs.entries()) {
        this.repo?.addLedger({
          at,
          category: "job_payout",
          amount: breakdowns[i]?.total ?? 0,
          refType: "job",
          refId: job.id,
          memo: `${job.origin}→${job.destination} ${job.kind} ${job.weightKg} kg (mission ${m.id})`,
        });
      }
      this.persistMission();
      this.repo?.linkFlight(record.id, m.jobIds, m.payloadKg, payout);
    });
    this.log(
      "info",
      `Mission ${m.id} delivered: $${total} (reputation ${delta >= 0 ? "+" : ""}${delta})`,
    );
    for (const [i, job] of m.jobs.entries()) {
      this.store.event("job.completed", {
        jobId: job.id,
        missionId: m.id,
        payout: breakdowns[i]?.total ?? 0,
      });
    }
    this.store.event("mission.delivered", { missionId: m.id, flightId: record.id, payout });
    this.publish();
  }

  // ---- commands ----

  handles(name: string): boolean {
    return (
      name.startsWith("job.") ||
      name.startsWith("jobs.") ||
      name.startsWith("mission.") ||
      name === "settings.update"
    );
  }

  command(cmd: Command): Result {
    const r = this.run(cmd);
    if (!r.ok) {
      return {
        type: "result",
        v: PROTOCOL_VERSION,
        id: cmd.id,
        ok: false,
        error: { code: r.code, message: r.message },
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
        return this.load(p.data.jobIds);
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
        this.mission = { ...m, status: "aborted", endedAt: new Date(this.now()).toISOString() };
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

  private load(ids: string[]): Ok<Mission> | Fail {
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
      if (!job || job.status !== "accepted")
        return fail("job_not_accepted", `Job ${id} is not accepted`);
      jobs.push(job);
    }
    const first = jobs[0];
    if (!first) return fail("bad_args", "No jobs");
    if (jobs.some((j) => j.origin !== first.origin || j.destination !== first.destination)) {
      return fail("mixed_route", "Stacked jobs must share the same origin and destination");
    }
    const type = this.activeType().type;
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
    const limit = payloadLimitKg(type, distanceNm);
    if (payloadKg > limit) {
      return fail(
        "payload_exceeded",
        `${payloadKg} kg exceeds the ${limit} kg the ${type.name} can carry on this leg (max payload − leg fuel)`,
      );
    }
    const id = this.newId();
    const loaded = jobs.map((j) => ({ ...j, status: "loaded" as const, missionId: id }));
    const mission: Mission = {
      id,
      status: "loaded",
      origin: first.origin,
      destination: first.destination,
      jobIds: loaded.map((j) => j.id),
      jobs: loaded,
      aircraftKey: type.key,
      payloadKg,
      distanceNm,
      timeLimitMin: Math.min(...loaded.map((j) => j.timeLimitMin)),
      expectedPayout: loaded.reduce((s, j) => s + j.payoutEstimate, 0),
      createdAt: new Date(this.now()).toISOString(),
    };
    this.repoTx(() => {
      for (const j of loaded) this.setJob(j);
      this.mission = mission;
      this.persistMission();
    });
    this.publish();
    return { ok: true, data: mission };
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
    const jobs = generateJobs({
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
    if (job.status === "available" || job.status === "accepted" || job.status === "loaded") {
      this.jobs.set(job.id, job);
    } else this.jobs.delete(job.id);
    this.persist(() => this.repo?.saveJob(job));
  }

  /** Move a mission's jobs to a new status (accepted again, delivered or failed). */
  private returnJobs(m: Mission, status: "accepted" | "delivered" | "failed"): void {
    for (const j of m.jobs) {
      const current = this.jobs.get(j.id) ?? j;
      if (status === "accepted") {
        const { missionId: _m, ...rest } = current;
        this.setJob({ ...rest, status: "accepted" });
      } else this.setJob({ ...current, status });
    }
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
    const stored = this.persistRead(() => this.repo?.getCompany() ?? null);
    if (stored) this.company = stored;
    this.jobs.clear();
    for (const job of this.persistRead(
      () => this.repo?.listJobs(["available", "accepted", "loaded"]) ?? [],
    ) ?? [])
      this.jobs.set(job.id, job);
    this.mission = this.persistRead(() => this.repo?.openMission() ?? null);
    this.publishedMissionId = null;
    this.store.apply({ mission: null });
    this.publish();
  }

  /** True while a mission is flying (imports are refused then). */
  get missionInProgress(): boolean {
    return this.mission?.status === "in_progress";
  }
}
