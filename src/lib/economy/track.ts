// Projection for the logbook track SVG: equirectangular scaled by cos(mid-latitude).

export interface TrackPoint {
  lat: number;
  lon: number;
}

export const TRACK_W = 400;
export const TRACK_H = 220;
const PAD = 18;

export function projectTrack(points: readonly TrackPoint[]): Array<[number, number]> {
  if (points.length === 0) return [];
  const lats = points.map((p) => p.lat);
  const lons = points.map((p) => p.lon);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const minLon = Math.min(...lons);
  const maxLon = Math.max(...lons);
  const k = Math.cos((((minLat + maxLat) / 2) * Math.PI) / 180);
  const spanX = Math.max(1e-6, (maxLon - minLon) * k);
  const spanY = Math.max(1e-6, maxLat - minLat);
  const scale = Math.min((TRACK_W - 2 * PAD) / spanX, (TRACK_H - 2 * PAD) / spanY);
  const offX = (TRACK_W - spanX * scale) / 2;
  const offY = (TRACK_H - spanY * scale) / 2;
  return points.map((p) => [
    Math.round((offX + (p.lon - minLon) * k * scale) * 10) / 10,
    Math.round((offY + (maxLat - p.lat) * scale) * 10) / 10,
  ]);
}
