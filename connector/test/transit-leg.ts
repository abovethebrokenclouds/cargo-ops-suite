// SYNTHETIC second leg for the transit cargo replay test. There is no recorded KATL → KRDU
// flight: this re-projects the synthetic KMEM → KATL fixture (itself computed by
// scripts/make-demo-fixture.mjs, not recorded from a simulator) onto another route. Every
// position is moved by the same spherical similarity: its distance from the old origin is
// scaled by new route / old route and its bearing rotated by the difference of the two
// initial courses, so the parked frames sit at the new origin and the arrival lands near the
// new destination. Headings rotate with it; altitudes, speeds, fuel, payload stations and the
// sim clock are left as recorded. Nothing here is simulator telemetry.

import type { FixtureFrame } from "../src/protocol";

interface Point {
  lat: number;
  lon: number;
}

const R_NM = 3440.065;
const rad = (d: number) => (d * Math.PI) / 180;
const deg = (r: number) => (r * 180) / Math.PI;

function distanceNm(a: Point, b: Point): number {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

function bearingDeg(a: Point, b: Point): number {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x =
    Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) -
    Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

function destination(a: Point, nm: number, bearing: number): Point {
  const d = nm / R_NM;
  const b = rad(bearing);
  const lat1 = rad(a.lat);
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(b));
  const lon2 =
    rad(a.lon) +
    Math.atan2(
      Math.sin(b) * Math.sin(d) * Math.cos(lat1),
      Math.cos(d) - Math.sin(lat1) * Math.sin(lat2),
    );
  return { lat: Math.round(deg(lat2) * 1e5) / 1e5, lon: Math.round(deg(lon2) * 1e5) / 1e5 };
}

/**
 * Re-project a fixture flown `from` → `to` onto `newFrom` → `newTo` (SYNTHETIC; see the file
 * header). `t` is shifted by `tOffsetMs` so the frames can follow another leg in one list.
 */
export function reprojectLeg(
  frames: readonly FixtureFrame[],
  from: Point,
  to: Point,
  newFrom: Point & { ident: string },
  newTo: Point & { ident: string },
  tOffsetMs = 0,
): FixtureFrame[] {
  const scale = distanceNm(newFrom, newTo) / distanceNm(from, to);
  const rotate = bearingDeg(newFrom, newTo) - bearingDeg(from, to);
  const move = (p: Point): Point => {
    const d = distanceNm(from, p);
    if (d < 1e-6) return { lat: newFrom.lat, lon: newFrom.lon };
    return destination(newFrom, d * scale, bearingDeg(from, p) + rotate);
  };
  const turn = (h: unknown) =>
    typeof h === "number" ? Math.round(((((h + rotate) % 360) + 360) % 360) * 10) / 10 : h;
  const fix = (state: Record<string, unknown>) => {
    const pos = state["position"] as Point | undefined;
    if (pos && typeof pos.lat === "number" && typeof pos.lon === "number") {
      const p = move(pos);
      state["position"] = { ...pos, lat: p.lat, lon: p.lon };
    }
    const motion = state["motion"] as Record<string, unknown> | undefined;
    if (motion) {
      state["motion"] = {
        ...motion,
        ...(motion["hdgTrueDeg"] !== undefined ? { hdgTrueDeg: turn(motion["hdgTrueDeg"]) } : {}),
        ...(motion["hdgMagDeg"] !== undefined ? { hdgMagDeg: turn(motion["hdgMagDeg"]) } : {}),
      };
    }
    const plan = state["plan"] as Record<string, unknown> | undefined;
    if (plan) {
      const next = { ...plan };
      if (next["origin"] !== undefined) next["origin"] = newFrom.ident;
      if (next["destination"] !== undefined) next["destination"] = newTo.ident;
      if (next["nextWpId"] !== undefined) next["nextWpId"] = newTo.ident;
      if (typeof next["nextWpLat"] === "number") next["nextWpLat"] = newTo.lat;
      if (typeof next["nextWpLon"] === "number") next["nextWpLon"] = newTo.lon;
      state["plan"] = next;
    }
  };
  return frames.map((f) => {
    const msg = structuredClone(f.msg);
    if (msg.type === "snapshot") fix(msg.state as Record<string, unknown>);
    else if (msg.type === "delta") fix(msg.patch as Record<string, unknown>);
    return { t: f.t + tOffsetMs, msg } as FixtureFrame;
  });
}
