import { TRACK_H as H, TRACK_W as W, projectTrack, type TrackPoint } from "@/lib/economy/track";

// Small static SVG of a recorded track (no map library): equirectangular projection
// scaled by cos(mid-latitude), fitted to the box. Pure render, SSR-safe.

export function TrackMap({
  points,
  origin,
  destination,
}: {
  points: readonly TrackPoint[];
  origin: string | null;
  destination: string | null;
}) {
  const xy = projectTrack(points);
  const first = xy[0];
  const last = xy.at(-1);
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      className="panel-inset h-auto w-full"
      role="img"
      aria-label={`Track ${origin ?? ""} to ${destination ?? ""}`}
      data-testid="track-map"
    >
      <defs>
        <pattern id="track-grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" className="fill-none stroke-border" strokeWidth="0.5" />
        </pattern>
      </defs>
      <rect width={W} height={H} fill="url(#track-grid)" />
      {xy.length > 1 ? (
        <polyline
          points={xy.map(([x, y]) => `${x},${y}`).join(" ")}
          className="fill-none stroke-primary"
          strokeWidth="2.5"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      ) : null}
      {first ? (
        <g>
          <circle cx={first[0]} cy={first[1]} r="4.5" className="fill-accent" />
          <text x={first[0] + 8} y={first[1] - 6} className="fill-foreground font-mono text-[11px]">
            {origin}
          </text>
        </g>
      ) : null}
      {last && xy.length > 1 ? (
        <g>
          <circle cx={last[0]} cy={last[1]} r="4.5" className="fill-tertiary" />
          <text x={last[0] + 8} y={last[1] - 6} className="fill-foreground font-mono text-[11px]">
            {destination}
          </text>
        </g>
      ) : null}
    </svg>
  );
}
