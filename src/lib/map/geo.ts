// Spherical geometry for the ops map. Pure functions, WGS84 treated as a sphere
// (mean Earth radius), which is well within display accuracy for routes and readouts.

/** Mean Earth radius in nautical miles (6,371.0088 km / 1.852). */
export const EARTH_RADIUS_NM = 3440.065;

export interface LatLon {
  lat: number;
  lon: number;
}

/** [lon, lat] as GeoJSON orders it. */
export type LonLat = [number, number];

const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Normalise a bearing to [0, 360). */
export function normalizeBearing(deg: number): number {
  const d = deg % 360;
  return d < 0 ? d + 360 : d;
}

/** Normalise a longitude to [-180, 180). */
export function normalizeLon(lon: number): number {
  const l = (((lon + 180) % 360) + 360) % 360;
  return l - 180;
}

/** Central angle between two points, radians (haversine formula). */
function centralAngle(a: LatLon, b: LatLon): number {
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Great-circle distance in nautical miles. */
export function haversineNm(a: LatLon, b: LatLon): number {
  return centralAngle(a, b) * EARTH_RADIUS_NM;
}

/** Initial true bearing from a to b, degrees [0, 360). */
export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const φ1 = toRad(a.lat);
  const φ2 = toRad(b.lat);
  const Δλ = toRad(b.lon - a.lon);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeBearing(toDeg(Math.atan2(y, x)));
}

/** Point at `fraction` (0–1) along the great circle from a to b. */
export function intermediatePoint(a: LatLon, b: LatLon, fraction: number): LatLon {
  const δ = centralAngle(a, b);
  if (δ < 1e-12) return { lat: a.lat, lon: a.lon };
  const φ1 = toRad(a.lat);
  const λ1 = toRad(a.lon);
  const φ2 = toRad(b.lat);
  const λ2 = toRad(b.lon);
  const A = Math.sin((1 - fraction) * δ) / Math.sin(δ);
  const B = Math.sin(fraction * δ) / Math.sin(δ);
  const x = A * Math.cos(φ1) * Math.cos(λ1) + B * Math.cos(φ2) * Math.cos(λ2);
  const y = A * Math.cos(φ1) * Math.sin(λ1) + B * Math.cos(φ2) * Math.sin(λ2);
  const z = A * Math.sin(φ1) + B * Math.sin(φ2);
  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lon: normalizeLon(toDeg(Math.atan2(y, x))),
  };
}

/**
 * Longitudes made continuous (successive steps under 180°), so a line crossing the
 * antimeridian draws across it instead of around the world.
 */
export function unwrapLongitudes(points: readonly LonLat[]): LonLat[] {
  const out: LonLat[] = [];
  let prev: number | null = null;
  for (const [lon, lat] of points) {
    let l = lon;
    if (prev !== null) {
      while (l - prev > 180) l -= 360;
      while (l - prev < -180) l += 360;
    }
    out.push([l, lat]);
    prev = l;
  }
  return out;
}

/**
 * Great-circle polyline from a to b as [lon, lat] pairs, endpoints included.
 * Segment count scales with distance (about one point per `stepNm`), between 2 and 256.
 */
export function greatCirclePoints(a: LatLon, b: LatLon, stepNm = 25): LonLat[] {
  const distance = haversineNm(a, b);
  const segments = Math.max(1, Math.min(256, Math.ceil(distance / stepNm)));
  const points: LonLat[] = [];
  for (let i = 0; i <= segments; i++) {
    const p = i === 0 ? a : i === segments ? b : intermediatePoint(a, b, i / segments);
    points.push([p.lon, p.lat]);
  }
  return unwrapLongitudes(points);
}

/** Graticule lines every `stepDeg` as GeoJSON MultiLineString coordinates. */
export function graticuleLines(stepDeg = 10): LonLat[][] {
  const lines: LonLat[][] = [];
  for (let lon = -180; lon <= 180; lon += stepDeg) {
    const line: LonLat[] = [];
    for (let lat = -80; lat <= 80; lat += 2) line.push([lon, lat]);
    lines.push(line);
  }
  for (let lat = -80; lat <= 80; lat += stepDeg) {
    const line: LonLat[] = [];
    for (let lon = -180; lon <= 180; lon += 2) line.push([lon, lat]);
    lines.push(line);
  }
  return lines;
}

/** Valid WGS84 coordinates (finite, in range). */
export function isValidLatLon(
  p: { lat?: number | undefined; lon?: number | undefined } | null | undefined,
): p is LatLon {
  return (
    !!p &&
    typeof p.lat === "number" &&
    typeof p.lon === "number" &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    Math.abs(p.lat) <= 90 &&
    Math.abs(p.lon) <= 180
  );
}
