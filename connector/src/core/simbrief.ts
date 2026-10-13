// Optional SimBrief OFP import (P6, OFF by default). The player's own SimBrief username or
// pilot ID lives in the connector's settings table; `import()` fetches the latest OFP from
// SimBrief's public fetch endpoint and keeps the mapped "planned flight" for the job board.
//
// Network etiquette: one request at a time, at most one per `minIntervalMs` (default 30 s,
// also after failures), a hard timeout, no automatic retries. The username is sent to
// simbrief.com and nowhere else; nothing is fetched unless the player enabled the feature
// and pressed Import.

import {
  DEFAULT_SIMBRIEF_SETTINGS,
  mapSimbriefOfp,
  plannedFlightSchema,
  simbriefFetchUrl,
  simbriefSettingsSchema,
  type PlannedFlight,
  type SimbriefSettings,
  type SimbriefSettingsUpdate,
} from "../protocol";
import type { LogFn } from "../sim/source";
import type { Storage } from "../storage/db";

export const SIMBRIEF_SETTINGS_KEY = "simbrief.settings";
export const SIMBRIEF_PLAN_KEY = "simbrief.plan";
export const SIMBRIEF_TIMEOUT_MS = 10_000;
export const SIMBRIEF_MIN_INTERVAL_MS = 30_000;
/** Largest OFP body accepted, bytes (real OFPs are a few hundred KB). */
export const SIMBRIEF_MAX_BYTES = 8 * 1024 * 1024;

export interface SimbriefServiceOptions {
  storage: Pick<Storage, "getSetting" | "setSetting">;
  version: string;
  log: LogFn;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  minIntervalMs?: number;
}

export type SimbriefImportResult =
  | { ok: true; plan: PlannedFlight }
  | {
      ok: false;
      status: number;
      code:
        | "simbrief_disabled"
        | "simbrief_no_user"
        | "simbrief_busy"
        | "rate_limited"
        | "simbrief_timeout"
        | "simbrief_unreachable"
        | "simbrief_error"
        | "simbrief_invalid";
      message: string;
      retryAfterSec?: number;
    };

export class SimbriefService {
  private readonly options: SimbriefServiceOptions;
  private inFlight = false;
  private lastAttemptAt = -Infinity;

  constructor(options: SimbriefServiceOptions) {
    this.options = options;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  settings(): SimbriefSettings {
    const parsed = simbriefSettingsSchema.safeParse(
      this.options.storage.getSetting(SIMBRIEF_SETTINGS_KEY),
    );
    return parsed.success ? parsed.data : { ...DEFAULT_SIMBRIEF_SETTINGS };
  }

  update(input: SimbriefSettingsUpdate): SimbriefSettings {
    const current = this.settings();
    const blank = (v: string | null | undefined) => (v === undefined ? undefined : v || null);
    const username = blank(input.username);
    const userId = blank(input.userId);
    const next: SimbriefSettings = {
      enabled: input.enabled ?? current.enabled,
      username: username === undefined ? current.username : username,
      userId: userId === undefined ? current.userId : userId,
    };
    this.options.storage.setSetting(SIMBRIEF_SETTINGS_KEY, next);
    return next;
  }

  plan(): PlannedFlight | null {
    const parsed = plannedFlightSchema.safeParse(
      this.options.storage.getSetting(SIMBRIEF_PLAN_KEY),
    );
    return parsed.success ? parsed.data : null;
  }

  clearPlan(): void {
    this.options.storage.setSetting(SIMBRIEF_PLAN_KEY, null);
  }

  async import(): Promise<SimbriefImportResult> {
    const settings = this.settings();
    if (!settings.enabled) {
      return {
        ok: false,
        status: 409,
        code: "simbrief_disabled",
        message: "SimBrief import is off. Turn it on in Settings first.",
      };
    }
    const url = simbriefFetchUrl(settings);
    if (!url) {
      return {
        ok: false,
        status: 409,
        code: "simbrief_no_user",
        message: "Enter your SimBrief username or pilot ID first.",
      };
    }
    if (this.inFlight) {
      return {
        ok: false,
        status: 409,
        code: "simbrief_busy",
        message: "An import is already running.",
      };
    }
    const interval = this.options.minIntervalMs ?? SIMBRIEF_MIN_INTERVAL_MS;
    const wait = this.lastAttemptAt + interval - this.now();
    if (wait > 0) {
      const retryAfterSec = Math.ceil(wait / 1000);
      return {
        ok: false,
        status: 429,
        code: "rate_limited",
        message: `Please wait ${retryAfterSec} s before importing again.`,
        retryAfterSec,
      };
    }
    this.inFlight = true;
    this.lastAttemptAt = this.now();
    const fetchImpl = this.options.fetch ?? globalThis.fetch;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? SIMBRIEF_TIMEOUT_MS,
    );
    try {
      let res: Response;
      try {
        res = await fetchImpl(url, {
          signal: controller.signal,
          headers: {
            Accept: "application/json",
            "User-Agent": `CargoOps/${this.options.version} (private use)`,
          },
        });
      } catch (err) {
        if (controller.signal.aborted) {
          return {
            ok: false,
            status: 504,
            code: "simbrief_timeout",
            message: "SimBrief did not answer in time.",
          };
        }
        this.options.log(
          "warn",
          `SimBrief fetch failed: ${err instanceof Error ? err.message : err}`,
        );
        return {
          ok: false,
          status: 502,
          code: "simbrief_unreachable",
          message: "Could not reach simbrief.com. Check the internet connection.",
        };
      }
      const body = await res.text();
      if (body.length > SIMBRIEF_MAX_BYTES) {
        return {
          ok: false,
          status: 502,
          code: "simbrief_invalid",
          message: "The SimBrief response is unexpectedly large.",
        };
      }
      let json: unknown;
      try {
        json = JSON.parse(body);
      } catch {
        return {
          ok: false,
          status: 502,
          code: res.ok ? "simbrief_invalid" : "simbrief_error",
          message: res.ok
            ? "SimBrief did not return JSON."
            : `SimBrief answered HTTP ${res.status}.`,
        };
      }
      // SimBrief answers unknown users / missing OFPs with an error status in the body.
      const mapped = mapSimbriefOfp(json, new Date(this.now()).toISOString());
      if (!mapped.ok) {
        return { ok: false, status: 502, code: mapped.code, message: mapped.message };
      }
      if (!res.ok) {
        return {
          ok: false,
          status: 502,
          code: "simbrief_error",
          message: `SimBrief answered HTTP ${res.status}.`,
        };
      }
      this.options.storage.setSetting(SIMBRIEF_PLAN_KEY, mapped.plan);
      this.options.log(
        "info",
        `SimBrief OFP imported: ${mapped.plan.origin} → ${mapped.plan.destination}`,
      );
      return { ok: true, plan: mapped.plan };
    } finally {
      clearTimeout(timer);
      this.inFlight = false;
    }
  }
}
