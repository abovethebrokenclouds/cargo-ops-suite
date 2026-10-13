// Landing analyser (plan §6.3). Pure and deterministic over FlightSamples.
//
// - Touchdown = the debounced airborne → on-ground transition; the values come
//   from the FIRST raw on-ground sample of that contact.
// - Rate: PLANE TOUCHDOWN NORMAL VELOCITY when the simulator reports a fresh value
//   (one that changed from what it showed while airborne), else the last airborne
//   VERTICAL SPEED sample. `rateSource` says which one was used.
// - Peak G: highest G FORCE from first contact to 800 ms after it.
// - Bounce: after first contact, AGL rises above 35 ft and then re-descends below 5 ft.
// - The result is final (and emitted once) when the aircraft has stayed on the
//   ground for `settleMs`, or has been airborne again for `goAroundMs` (a
//   touch-and-go with a short contact).
// - grade = min(rate grade, G grade, speed grade); speed grade is null until the
//   aircraft catalogue provides reference speeds.

import { gGrade, landingGrade, rateGrade, type RateSource, type Touchdown } from "../protocol";
import { GroundDebouncer, type FlightSample } from "./flight-sample";

export interface LandingConfig {
  groundDebounceSamples: number;
  peakGWindowMs: number;
  bounceAboveFt: number;
  bounceBelowFt: number;
  settleMs: number;
  goAroundMs: number;
}

export const DEFAULT_LANDING_CONFIG: LandingConfig = {
  groundDebounceSamples: 3,
  peakGWindowMs: 800,
  bounceAboveFt: 35,
  bounceBelowFt: 5,
  settleMs: 2_000,
  goAroundMs: 15_000,
};

interface Contact {
  first: FlightSample;
  /** Last airborne sample before the contact (null if the session started on the ground). */
  lastAirborne: FlightSample | null;
  peakG: number;
  bounces: number;
  bounceArmed: boolean;
  groundSince: number | null;
  airSince: number | null;
  fresh: { rateFpm: number; bankDeg: number | null; pitchDeg: number | null } | null;
}

export class LandingAnalyser {
  private readonly config: LandingConfig;
  private readonly ground: GroundDebouncer;
  private lastAirborne: FlightSample | null = null;
  /** First raw on-ground sample of the current (not yet confirmed) contact. */
  private candidate: FlightSample | null = null;
  private candidatePeakG = 0;
  private candidateAirSamples = 0;
  private rawGroundSince: number | null = null;
  private contact: Contact | null = null;
  /** Sim time of the first contact of the last final touchdown. */
  lastContactMs: number | null = null;

  constructor(config: Partial<LandingConfig> = {}) {
    this.config = { ...DEFAULT_LANDING_CONFIG, ...config };
    this.ground = new GroundDebouncer(this.config.groundDebounceSamples);
  }

  reset(): void {
    this.ground.reset();
    this.lastAirborne = null;
    this.candidate = null;
    this.candidatePeakG = 0;
    this.candidateAirSamples = 0;
    this.rawGroundSince = null;
    this.contact = null;
  }

  /** True between a confirmed contact and the final touchdown result. */
  get analysing(): boolean {
    return this.contact !== null;
  }

  /** Feed one sample; returns the touchdown when it becomes final. */
  update(s: FlightSample): Touchdown | null {
    const c = this.config;
    const wasGround = this.ground.value;
    const onGround = this.ground.update(s.onGround);

    if (s.onGround) {
      if (this.rawGroundSince === null) this.rawGroundSince = s.tMs;
    } else {
      this.rawGroundSince = null;
    }

    if (!this.contact) {
      // A raw contact while (debounced) airborne becomes the candidate touchdown.
      if (s.onGround) {
        if (wasGround === false && !this.candidate) {
          this.candidate = s;
          this.candidatePeakG = s.gForce;
          this.candidateAirSamples = 0;
        }
      } else if (this.candidate) {
        // A ground blip followed by real flight is not a touchdown.
        this.candidateAirSamples++;
        if (
          s.aglFt > c.bounceAboveFt ||
          this.candidateAirSamples >= this.config.groundDebounceSamples
        ) {
          this.candidate = null;
        }
      }
      if (!s.onGround && !this.candidate && onGround === false) this.lastAirborne = s;
      if (this.candidate && s.tMs - this.candidate.tMs <= c.peakGWindowMs) {
        this.candidatePeakG = Math.max(this.candidatePeakG, s.gForce);
      }
      if (wasGround === false && onGround && this.candidate) {
        this.contact = {
          first: this.candidate,
          lastAirborne: this.lastAirborne,
          peakG: this.candidatePeakG,
          bounces: 0,
          bounceArmed: false,
          groundSince: this.rawGroundSince,
          airSince: null,
          fresh: null,
        };
        this.candidate = null;
        this.checkFresh(s);
        return this.maybeFinal(s);
      }
      return null;
    }

    const contact = this.contact;
    if (s.tMs - contact.first.tMs <= c.peakGWindowMs) {
      contact.peakG = Math.max(contact.peakG, s.gForce);
    }
    this.checkFresh(s);
    if (!s.onGround && s.aglFt > c.bounceAboveFt) contact.bounceArmed = true;
    // Back below 5 ft (or on the wheels: AGL on the ground depends on the airframe).
    if (contact.bounceArmed && (s.aglFt < c.bounceBelowFt || s.onGround)) {
      contact.bounces++;
      contact.bounceArmed = false;
    }
    contact.groundSince = this.rawGroundSince;
    if (s.onGround) contact.airSince = null;
    else if (contact.airSince === null) contact.airSince = s.tMs;
    return this.maybeFinal(s);
  }

  private checkFresh(s: FlightSample): void {
    const contact = this.contact;
    if (!contact || s.touchdownVelocityFpm === undefined) return;
    const baseline = contact.lastAirborne?.touchdownVelocityFpm;
    if (baseline !== undefined && baseline === s.touchdownVelocityFpm) return;
    if (baseline === undefined && s.touchdownVelocityFpm === 0) return;
    contact.fresh = {
      rateFpm: -Math.abs(s.touchdownVelocityFpm),
      bankDeg: s.touchdownBankDeg ?? null,
      pitchDeg: s.touchdownPitchDeg ?? null,
    };
  }

  private maybeFinal(s: FlightSample): Touchdown | null {
    const c = this.config;
    const contact = this.contact;
    if (!contact) return null;
    const sinceContact = s.tMs - contact.first.tMs;
    const settled =
      contact.groundSince !== null &&
      s.tMs - contact.groundSince >= c.settleMs &&
      sinceContact >= c.peakGWindowMs;
    const wentAround = contact.airSince !== null && s.tMs - contact.airSince >= c.goAroundMs;
    if (!settled && !wentAround) return null;
    this.contact = null;
    this.lastAirborne = null;
    this.lastContactMs = contact.first.tMs;
    return buildTouchdown(contact);
  }
}

function buildTouchdown(contact: Contact): Touchdown {
  const first = contact.first;
  let rateFpm: number;
  let rateSource: RateSource;
  let bankDeg: number | null = null;
  let pitchDeg: number | null = null;
  if (contact.fresh) {
    rateFpm = contact.fresh.rateFpm;
    rateSource = "touchdownVelocity";
    bankDeg = contact.fresh.bankDeg;
    pitchDeg = contact.fresh.pitchDeg;
  } else {
    rateFpm = (contact.lastAirborne ?? first).vsFpm;
    rateSource = "verticalSpeed";
  }
  const peakG = contact.peakG;
  const rate = rateGrade(rateFpm) ?? "F";
  const g = gGrade(peakG) ?? "F";
  return {
    rateFpm: Math.round(rateFpm),
    rateSource,
    peakG: Math.round(peakG * 100) / 100,
    gsKt: Math.round(first.gsKt * 10) / 10,
    bankDeg: bankDeg === null ? null : Math.round(bankDeg * 10) / 10,
    pitchDeg: pitchDeg === null ? null : Math.round(pitchDeg * 10) / 10,
    lat: first.lat,
    lon: first.lon,
    bounces: contact.bounces,
    grade: landingGrade(rateFpm, peakG, null) ?? "F",
    rateGrade: rate,
    gGrade: g,
    speedGrade: null,
  };
}
