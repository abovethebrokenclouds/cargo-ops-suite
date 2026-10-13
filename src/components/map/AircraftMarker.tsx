import { cn } from "@/lib/utils";

/**
 * In-house top-down twin-engine cargo aircraft silhouette (nose up = north), drawn in
 * `currentColor`. The map rotates its container by true heading.
 */
export function AircraftSilhouette({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 64 64" className={className} aria-hidden="true" focusable="false">
      <g fill="currentColor">
        {/* fuselage */}
        <path d="M32 2.5c2.5 0 3.7 3.4 3.7 7.2V49c0 4.4-1.6 9.6-3.7 12.5-2.1-2.9-3.7-8.1-3.7-12.5V9.7c0-3.8 1.2-7.2 3.7-7.2Z" />
        {/* wings */}
        <path d="M35.4 23.5 61.5 33.6v3.6L35.4 32.8Z" />
        <path d="M28.6 23.5 2.5 33.6v3.6l26.1-4.4Z" />
        {/* engine nacelles */}
        <rect x="44.2" y="22.6" width="4.4" height="11" rx="2.2" />
        <rect x="15.4" y="22.6" width="4.4" height="11" rx="2.2" />
        {/* horizontal stabiliser */}
        <path d="M35.2 49.2 45.6 54v2.9l-10.4-2Z" />
        <path d="M28.8 49.2 18.4 54v2.9l10.4-2Z" />
      </g>
      {/* cockpit glazing */}
      <path
        className="fill-background/70"
        d="M30.2 8.6c.5-1.6 1.1-2.4 1.8-2.4s1.3.8 1.8 2.4l-1.8.9Z"
      />
    </svg>
  );
}

/** Map marker: glowing halo plus the silhouette, rotated by `headingDeg` (true). */
export function AircraftMarker({
  headingDeg,
  stale = false,
  className,
}: {
  headingDeg: number | null;
  stale?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn("aircraft-marker relative grid size-14 place-items-center", className)}
      data-testid="aircraft-marker"
      data-stale={stale ? "" : undefined}
      role="img"
      aria-label={
        headingDeg === null ? "Aircraft position" : `Aircraft, heading ${Math.round(headingDeg)}°`
      }
    >
      <span aria-hidden="true" className="aircraft-marker-halo absolute inset-1 rounded-full" />
      <span
        className="relative grid size-11 place-items-center text-accent"
        style={{ transform: `rotate(${headingDeg ?? 0}deg)` }}
      >
        <AircraftSilhouette className="aircraft-marker-glyph size-11" />
      </span>
    </div>
  );
}
