// Plan resolver: owns the published `plan` domain (plan §6.1 `plan`, §14.1).
//
// Three possible destinations, in this precedence:
//   1. gps     the simulator's active GPS flight plan, as the source reports it (SimConnect:
//              mapPlan over the deprecated GPS SimVars; replays: the fixture's plan). Inactive,
//              empty or rejected means "no GPS plan" — never a guessed one.
//   2. manual  a destination the player picked with `plan.destination`, for the current
//              flight only: kept in memory, cleared when the flight ends, on a replay restart
//              or with `{ icao: null }`. Never written to the database.
//   3. mission the loaded (or flying) mission's destination.
// For manual and mission the connector computes the remaining distance (great circle from the
// live position to the airport's reference point) and the ETE (distance / ground speed, only
// at or above MIN_ETE_GS_KT). They are labelled with their basis and are never GPS values.
//
// Frames carry the session's source (`sim` live, `replay` for FakeSource), as everything else.
// While the simulator is offline nothing is published: the session clears `plan` with the
// other sim-derived domains and the resolver waits for the next real data.

import {
  PROTOCOL_VERSION,
  planDestinationArgsSchema,
  planDomainSchema,
  type Command,
  type Mission,
  type MotionState,
  type PlanState,
  type PositionState,
  type Result,
  type SimStatePatch,
} from "../protocol";
import { greatCircleNm, nearestAirport, type AirportLookup } from "../economy";
import type { LogFn } from "../sim/source";
import type { StateStore } from "./store";

/** Below this ground speed the connector reports no ETE for manual/mission plans, kt. */
export const MIN_ETE_GS_KT = 30;
/** A manual pick on the ground within this distance of an airport records it as the origin, nm. */
export const MANUAL_ORIGIN_RADIUS_NM = 3;
/** Position-only changes republish the plan at most this often (receive clock), ms. */
export const PLAN_PUBLISH_INTERVAL_MS = 1_000;

const ACTIVE_MISSION = new Set<Mission["status"]>(["loaded", "in_progress"]);

const round1 = (n: number) => Math.round(n * 10) / 10;

interface ManualChoice {
  destination: string;
  origin?: string;
}

export interface PlanResolverOptions {
  store: StateStore;
  airports: AirportLookup | null;
  log?: LogFn;
  /** True until the source's first `connected` (live mode): nothing is published offline. */
  startOffline?: boolean;
}

export class PlanResolver {
  private readonly store: StateStore;
  private readonly airports: AirportLookup | null;
  private readonly log: LogFn;
  /** The GPS plan as the source last reported it (merged partial patches), or null. */
  private gpsRaw: Record<string, unknown> | null = null;
  private manual: ManualChoice | null = null;
  private published: PlanState | null = null;
  private lastPublishMs = Number.NEGATIVE_INFINITY;
  private lastAtMs = 0;
  private offline: boolean;

  constructor(options: PlanResolverOptions) {
    this.store = options.store;
    this.airports = options.airports;
    this.log = options.log ?? (() => {});
    this.offline = options.startOffline ?? false;
  }

  /** The manual destination for the current flight, if any. */
  get manualDestination(): string | null {
    return this.manual?.destination ?? null;
  }

  /** The source reported its GPS plan: a full object, a partial patch, or null for none. */
  ingest(patch: SimStatePatch["plan"]): void {
    if (patch === undefined) return;
    if (patch === null) {
      this.gpsRaw = null;
      return;
    }
    const fields: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) fields[k] = v;
    this.gpsRaw = this.gpsRaw ? { ...this.gpsRaw, ...fields } : fields;
  }

  /** The store was reset (session start, replay restart): a new flight context. */
  reset(plan: SimStatePatch["plan"], atMs: number): void {
    this.gpsRaw = null;
    this.ingest(plan ?? null);
    if (this.manual) this.log("info", "Manual destination cleared (replay restarted)");
    this.manual = null;
    // store.reset replaced the whole state, so nothing of ours is in it any more.
    this.published = null;
    this.lastPublishMs = Number.NEGATIVE_INFINITY;
    this.refresh(atMs, true);
  }

  /** The simulator link dropped; the session already cleared the `plan` domain. */
  onDisconnect(): void {
    this.offline = true;
    this.gpsRaw = null;
    this.published = null;
  }

  onConnect(): void {
    this.offline = false;
  }

  /** The tracked flight ended: the manual destination was for that flight only. */
  onFlightEnded(): void {
    if (!this.manual) return;
    this.log("info", `Manual destination ${this.manual.destination} cleared (flight ended)`);
    this.manual = null;
  }

  /** `plan.destination { icao }`: set (or clear with null) the manual destination. */
  command(cmd: Command): Result {
    const parsed = planDestinationArgsSchema.safeParse(cmd.args ?? {});
    if (!parsed.success) {
      return failure(
        cmd.id,
        "invalid_args",
        "plan.destination expects { icao: <airport ident> } or { icao: null }",
      );
    }
    const icao = parsed.data.icao;
    if (icao === null) {
      if (this.manual) this.log("info", `Manual destination ${this.manual.destination} cleared`);
      this.manual = null;
      this.refresh(this.lastAtMs, true);
      return success(cmd.id, { destination: null, basis: this.published?.basis ?? null });
    }
    if (!this.airports) {
      return failure(cmd.id, "no_airport_data", "Airport data is not available in this connector");
    }
    const airport = this.airports.get(icao);
    if (!airport) {
      return failure(cmd.id, "unknown_airport", `${icao} is not in the airport list`);
    }
    const choice: ManualChoice = { destination: airport.ident };
    const origin = this.originHere(airport.ident);
    if (origin) choice.origin = origin;
    this.manual = choice;
    this.log(
      "info",
      `Manual destination ${airport.ident}${origin ? ` (from ${origin})` : ""} for this flight`,
    );
    this.refresh(this.lastAtMs, true);
    return success(cmd.id, { destination: airport.ident, basis: this.published?.basis ?? null });
  }

  /**
   * Recompute and publish. Changes of basis, destination or shape go out at once; distance
   * and ETE updates at most every PLAN_PUBLISH_INTERVAL_MS unless `force`.
   */
  refresh(atMs: number, force = false): void {
    this.lastAtMs = atMs;
    if (this.offline) return;
    const next = this.resolve();
    const prev = this.published;
    if (!next) {
      if (prev) {
        this.store.apply({ plan: null });
        this.published = null;
      }
      return;
    }
    const removed = prev ? Object.keys(prev).some((k) => !(k in next)) : false;
    const identity =
      !prev ||
      removed ||
      prev.basis !== next.basis ||
      prev.destination !== next.destination ||
      prev.origin !== next.origin;
    if (!identity && !force && atMs - this.lastPublishMs < PLAN_PUBLISH_INTERVAL_MS) return;
    // The store merges patches: a plan that lost fields (another basis, GPS values gone) is
    // cleared first so nothing of the previous one survives.
    if (prev && removed) this.store.apply({ plan: null });
    this.store.apply({ plan: next });
    this.published = next;
    this.lastPublishMs = atMs;
  }

  /** Republish at once on the source's clock (after a command changed the inputs). */
  refreshNow(): void {
    this.refresh(this.lastAtMs, true);
  }

  /** The plan in use right now, by precedence, or null. */
  resolve(): PlanState | null {
    const gps = this.gpsPlan();
    if (gps) return gps;
    if (this.manual) {
      return this.computed("manual", this.manual.destination, this.manual.origin);
    }
    const mission = (this.store.getDomain("mission") ?? null) as Mission | null;
    if (mission && ACTIVE_MISSION.has(mission.status)) {
      return this.computed("mission", mission.destination, mission.origin);
    }
    return null;
  }

  private gpsPlan(): PlanState | null {
    const raw = this.gpsRaw;
    if (!raw) return null;
    // A recorded manual/mission plan in a fixture is derived data, not a GPS plan.
    if (raw["basis"] !== undefined && raw["basis"] !== "gps") return null;
    if (raw["active"] !== true) return null;
    if (raw["wpCount"] === 0 || raw["nextWpId"] === "") return null;
    const parsed = planDomainSchema.safeParse({ ...raw, basis: "gps" });
    return parsed.success ? parsed.data : null;
  }

  private computed(
    basis: "manual" | "mission",
    destination: string,
    origin: string | undefined,
  ): PlanState {
    const plan: PlanState = { active: true, basis, destination };
    if (origin) plan.origin = origin;
    const airport = this.airports?.get(destination) ?? null;
    const position = (this.store.getDomain("position") ?? null) as PositionState | null;
    const motion = (this.store.getDomain("motion") ?? null) as MotionState | null;
    if (!airport || !position) return plan;
    const distanceNm = round1(greatCircleNm(position, airport));
    plan.destDistanceNm = distanceNm;
    if (motion && Number.isFinite(motion.gsKt) && motion.gsKt >= MIN_ETE_GS_KT) {
      plan.eteSec = Math.round((distanceNm / motion.gsKt) * 3600);
    }
    return plan;
  }

  /** The airport the aircraft is parked at (on the ground, within 3 nm), if not `exclude`. */
  private originHere(exclude: string): string | null {
    if (!this.airports) return null;
    const position = (this.store.getDomain("position") ?? null) as PositionState | null;
    const motion = (this.store.getDomain("motion") ?? null) as MotionState | null;
    if (!position || motion?.onGround !== true) return null;
    const near = nearestAirport(this.airports.list, position, MANUAL_ORIGIN_RADIUS_NM);
    return near && near.airport.ident !== exclude ? near.airport.ident : null;
  }
}

function success(id: string, data: unknown): Result {
  return { type: "result", v: PROTOCOL_VERSION, id, ok: true, data };
}

function failure(id: string, code: string, message: string): Result {
  return { type: "result", v: PROTOCOL_VERSION, id, ok: false, error: { code, message } };
}
