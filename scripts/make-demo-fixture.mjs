#!/usr/bin/env node
// Generates SYNTHETIC demo telemetry for the in-browser DemoTransport: a KMEM → KATL
// flight in a Cessna 208B-style single turboprop. It is computed from a simple
// kinematic profile, not recorded from a simulator. Deterministic: same output on
// every run. Usage: node scripts/make-demo-fixture.mjs (then `npm run fixtures:sync`
// in connector/).
//
// The phase/flight domains and the phase.changed/touchdown/flight.* events written
// here are AUTHORED for the browser-only demo. The connector's FakeSource strips
// them and recomputes everything from the raw telemetry (position, motion, sim
// clock), so the connector's flight core is the only source of truth in replays.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, "src/lib/transport/fixtures/demo-kmem-katl.jsonl");

const ORIGIN = { icao: "KMEM", lat: 35.0424, lon: -89.9767, elevFt: 341, magVarDeg: 1 };
const DEST = { icao: "KATL", lat: 33.6367, lon: -84.4281, elevFt: 1026, magVarDeg: 5 };

const EMPTY_LB = 4730;
const MAX_GROSS_LB = 8750;
const LB_PER_GAL = 6.7; // Jet-A
const START_FUEL_LB = 1700;
const STATIONS = [
  { name: "Pilot", weightLb: 170 },
  { name: "Cargo Zone A", weightLb: 450 },
  { name: "Cargo Zone B", weightLb: 520 },
  { name: "Cargo Zone C", weightLb: 480 },
  { name: "Cargo Pod", weightLb: 380 },
];
const PAYLOAD_LB = STATIONS.reduce((s, x) => s + x.weightLb, 0);

// ---- geodesy (spherical earth, nautical miles) ----
const R_NM = 3440.065;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

function distanceNm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.sqrt(h));
}

function bearingDeg(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function interpolate(a, b, f) {
  const d = distanceNm(a, b) / R_NM;
  if (d === 0) return { lat: a.lat, lon: a.lon };
  const A = Math.sin((1 - f) * d) / Math.sin(d);
  const B = Math.sin(f * d) / Math.sin(d);
  const x =
    A * Math.cos(rad(a.lat)) * Math.cos(rad(a.lon)) +
    B * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon));
  const y =
    A * Math.cos(rad(a.lat)) * Math.sin(rad(a.lon)) +
    B * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon));
  const z = A * Math.sin(rad(a.lat)) + B * Math.sin(rad(b.lat));
  return { lat: deg(Math.atan2(z, Math.hypot(x, y))), lon: deg(Math.atan2(y, x)) };
}

const ROUTE_NM = distanceNm(ORIGIN, DEST);
const CRUISE_FT = 9500;
/** Sink rate of the last airborne frame; the authored touchdown event repeats it. */
const TOUCHDOWN_RATE_FPM = -142;
const TOD_FT = DEST.elevFt + 3000;

// ---- profile ----
// Each segment covers `frames` fixture seconds and `simSec` simulated seconds
// (cruise is solved so the route ends exactly at KATL). Altitude is linear across a
// segment; speeds are linear from `ias[0]` to `ias[1]`.
const segments = [
  {
    phase: "Boarding",
    frames: 20,
    simSec: 300,
    ground: true,
    ias: [0, 0],
    alt: [ORIGIN.elevFt, ORIGIN.elevFt],
    flow: 0,
  },
  {
    phase: "TaxiOut",
    frames: 25,
    simSec: 420,
    ground: true,
    ias: [12, 12],
    alt: [ORIGIN.elevFt, ORIGIN.elevFt],
    flow: 150,
  },
  {
    phase: "Takeoff",
    frames: 4,
    simSec: 30,
    ground: true,
    ias: [20, 80],
    alt: [ORIGIN.elevFt, ORIGIN.elevFt],
    flow: 420,
  },
  {
    phase: "Takeoff",
    frames: 4,
    simSec: 30,
    ground: false,
    ias: [85, 95],
    alt: [ORIGIN.elevFt, ORIGIN.elevFt + 500],
    flow: 420,
  },
  {
    phase: "Climb",
    frames: 60,
    simSec: 1080,
    ground: false,
    ias: [105, 115],
    alt: [ORIGIN.elevFt + 500, CRUISE_FT],
    flow: 380,
  },
  {
    phase: "Cruise",
    frames: 110,
    simSec: null,
    ground: false,
    ias: [150, 150],
    alt: [CRUISE_FT, CRUISE_FT],
    flow: 340,
  },
  {
    phase: "Descent",
    frames: 60,
    simSec: 600,
    ground: false,
    ias: [160, 140],
    alt: [CRUISE_FT, TOD_FT],
    flow: 250,
  },
  {
    phase: "Approach",
    frames: 35,
    simSec: 600,
    ground: false,
    ias: [120, 80],
    alt: [TOD_FT, DEST.elevFt],
    flow: 280,
  },
  {
    phase: "Landing",
    frames: 8,
    simSec: 40,
    ground: true,
    ias: [72, 15],
    alt: [DEST.elevFt, DEST.elevFt],
    flow: 140,
  },
  {
    phase: "TaxiIn",
    frames: 20,
    simSec: 300,
    ground: true,
    ias: [12, 12],
    alt: [DEST.elevFt, DEST.elevFt],
    flow: 140,
  },
  {
    phase: "Arrived",
    frames: 15,
    simSec: 120,
    ground: true,
    ias: [0, 0],
    alt: [DEST.elevFt, DEST.elevFt],
    flow: 0,
  },
];

const tasFor = (ias, altFt) => ias * (1 + 0.02 * (altFt / 1000));
const lerp = (a, b, f) => a + (b - a) * f;
const frameFraction = (i, n) => (n <= 1 ? 1 : i / (n - 1));

// Solve the cruise duration so the integrated ground track equals the route length.
function groundDistance(seg) {
  let nm = 0;
  for (let i = 0; i < seg.frames; i++) {
    const f = frameFraction(i, seg.frames);
    const alt = lerp(seg.alt[0], seg.alt[1], f);
    nm +=
      (tasFor(lerp(seg.ias[0], seg.ias[1], f), seg.ground ? 0 : alt) * (seg.simSec / seg.frames)) /
      3600;
  }
  return nm;
}
const cruise = segments.find((s) => s.simSec === null);
const otherNm = segments.filter((s) => s !== cruise).reduce((sum, s) => sum + groundDistance(s), 0);
const cruiseGs = tasFor(cruise.ias[0], CRUISE_FT);
cruise.simSec = Math.round(((ROUTE_NM - otherNm) / cruiseGs) * 3600);

// ---- emit ----
const round = (x, d = 0) => {
  const p = 10 ** d;
  return Math.round(x * p) / p;
};
const lines = [];
let seq = 0;
let t = 0;
const push = (msg) =>
  lines.push(JSON.stringify({ t, msg: { ...msg, v: 1, seq: seq++, source: "demo" } }));
const pushEvent = (name, data) => push({ type: "event", name, data });

let flownNm = 0;
let elapsedSec = 0;
let fuelLb = START_FUEL_LB;
let prevPhase = null;
let engineOn = false;
let brake = true;
let touchdown = null;
let lastEngine = engineOn;
let lastBrake = brake;
const totalFrames = segments.reduce((s, x) => s + x.frames, 0);
let frameNo = 0;

for (const seg of segments) {
  const dt = seg.simSec / seg.frames;
  for (let i = 0; i < seg.frames; i++, frameNo++, t += 1000) {
    const f = frameFraction(i, seg.frames);
    const routeF = Math.min(1, flownNm / ROUTE_NM);
    const pos = interpolate(ORIGIN, DEST, routeF);
    const ahead = interpolate(ORIGIN, DEST, Math.min(1, routeF + 0.001));
    const hdgTrue =
      routeF >= 0.999 ? bearingDeg(interpolate(ORIGIN, DEST, 0.998), DEST) : bearingDeg(pos, ahead);
    const magVar = lerp(ORIGIN.magVarDeg, DEST.magVarDeg, routeF);
    const wobble = Math.sin(frameNo / 7) * (seg.ground ? 0 : 1);
    const altFt = lerp(seg.alt[0], seg.alt[1], f) + wobble * 15;
    const groundElev = lerp(ORIGIN.elevFt, DEST.elevFt, routeF);
    const ias = lerp(seg.ias[0], seg.ias[1], f) + wobble;
    const tas = tasFor(ias, seg.ground ? 0 : altFt);
    const gs = Math.max(0, tas);
    let vsFpm = seg.ground ? 0 : ((seg.alt[1] - seg.alt[0]) / seg.simSec) * 60 + wobble * 40;
    // Flare: the last two approach frames sink slower, ending at the touchdown rate.
    if (seg.phase === "Approach" && i >= seg.frames - 2) {
      vsFpm = i === seg.frames - 1 ? TOUCHDOWN_RATE_FPM : -225;
    }

    // Engine start late in boarding; shutdown two frames after arrival.
    if (seg.phase === "Boarding" && i === seg.frames - 5) engineOn = true;
    if (seg.phase === "Arrived" && i === 2) engineOn = false;
    if (seg.phase === "TaxiOut" && i === 0) brake = false;
    if (seg.phase === "Arrived" && i === 0) brake = true;
    const flow = engineOn ? seg.flow || 120 : 0;

    const isTouchdown = seg.phase === "Landing" && i === 0;
    const gForce = isTouchdown ? 1.18 : 1 + (seg.ground ? 0 : wobble * 0.02);
    const remainingNm = Math.max(0, ROUTE_NM - flownNm);

    const position = {
      lat: round(pos.lat, 5),
      lon: round(pos.lon, 5),
      altFt: round(altFt),
      aglFt: round(Math.max(0, altFt - groundElev)),
    };
    if (seg.ground) position.aglFt = 0;
    const motion = {
      iasKt: round(ias, 1),
      tasKt: round(tas, 1),
      gsKt: round(gs, 1),
      hdgMagDeg: round((hdgTrue + magVar + 360) % 360, 1),
      hdgTrueDeg: round(hdgTrue, 1),
      vsFpm: round(vsFpm),
      gForce: round(gForce, 2),
      onGround: seg.ground,
    };
    const fuel = {
      totalGal: round(fuelLb / LB_PER_GAL, 1),
      totalLb: round(fuelLb, 1),
      flowPph: [flow],
    };
    const weights = {
      totalLb: round(EMPTY_LB + PAYLOAD_LB + fuelLb),
      emptyLb: EMPTY_LB,
      maxGrossLb: MAX_GROSS_LB,
      payloadLb: PAYLOAD_LB,
    };
    const plan = {
      nextWpDistanceNm: round(remainingNm, 1),
      destDistanceNm: round(remainingNm, 1),
      ...(gs > 30 ? { eteSec: round((remainingNm / gs) * 3600) } : {}),
    };
    const flight = { flownDistanceNm: round(flownNm, 1), elapsedSec: round(elapsedSec) };

    if (frameNo === 0) {
      push({
        type: "snapshot",
        state: {
          sim: { connected: false, paused: false, simRate: 1, simTimeSec: 0 },
          aircraft: { title: "Cessna 208B Grand Caravan EX", atcId: "N401CO" },
          position,
          motion,
          fuel,
          weights,
          payload: { stations: STATIONS },
          engines: { running: [engineOn] },
          controls: { parkingBrake: brake },
          plan: {
            active: true,
            origin: ORIGIN.icao,
            destination: DEST.icao,
            wpIndex: 1,
            wpCount: 2,
            nextWpId: DEST.icao,
            nextWpLat: DEST.lat,
            nextWpLon: DEST.lon,
            ...plan,
          },
          flight: {
            active: false,
            origin: ORIGIN.icao,
            destination: DEST.icao,
            plannedDistanceNm: round(ROUTE_NM, 1),
            flownDistanceNm: 0,
            elapsedSec: 0,
          },
          phase: { current: seg.phase },
        },
      });
      prevPhase = seg.phase;
    } else {
      // simTimeSec: the fixture compresses ~2 h of flight into ~6 min of frames, so it
      // states its simulated clock explicitly (protocol sim.simTimeSec).
      const sim = { simTimeSec: round(elapsedSec, 1) };
      const patch = { sim, position, motion, fuel, weights, plan, flight };
      if (engineOn !== lastEngine) patch.engines = { running: [engineOn] };
      if (brake !== lastBrake) patch.controls = { parkingBrake: brake };
      if (frameNo === 1) patch.flight = { ...flight, active: true };
      if (seg.phase !== prevPhase) patch.phase = { current: seg.phase };
      if (seg.phase === "Arrived" && i === 4) patch.flight = { ...flight, active: false };
      push({ type: "delta", patch });

      if (frameNo === 1) {
        pushEvent("flight.started", {
          origin: ORIGIN.icao,
          destination: DEST.icao,
          aircraft: "Cessna 208B Grand Caravan EX",
          payloadLb: PAYLOAD_LB,
          fuelLb: START_FUEL_LB,
        });
      }
      if (seg.phase !== prevPhase) {
        pushEvent("phase.changed", { from: prevPhase, to: seg.phase });
        prevPhase = seg.phase;
      }
      if (isTouchdown) {
        touchdown = {
          rateFpm: TOUCHDOWN_RATE_FPM,
          gForce: 1.18,
          gsKt: round(gs, 1),
          bankDeg: 0.8,
          pitchDeg: 4.6,
          lat: position.lat,
          lon: position.lon,
        };
        pushEvent("touchdown", touchdown);
      }
      if (seg.phase === "Arrived" && i === 4) {
        pushEvent("flight.ended", {
          origin: ORIGIN.icao,
          destination: DEST.icao,
          distanceNm: round(flownNm, 1),
          blockTimeSec: round(elapsedSec),
          fuelUsedLb: round(START_FUEL_LB - fuelLb, 1),
          landingRateFpm: touchdown?.rateFpm ?? null,
        });
      }
    }
    lastEngine = engineOn;
    lastBrake = brake;

    // Advance the simulation to the next frame.
    flownNm += (gs * dt) / 3600;
    elapsedSec += dt;
    fuelLb = Math.max(0, fuelLb - (flow * dt) / 3600);
  }
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, lines.join("\n") + "\n");
const blockMin = Math.round(elapsedSec / 60);
console.log(
  `Wrote ${lines.length} lines (${totalFrames} s of fixture, ${blockMin} min simulated, ${round(ROUTE_NM, 1)} nm) to ${out}`,
);
