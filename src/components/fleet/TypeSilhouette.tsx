import { cn } from "@/lib/utils";

type Category =
  | "single-piston"
  | "single-turboprop"
  | "twin-turboprop"
  | "regional-turboprop"
  | "narrowbody-jet"
  | "widebody-jet";

/**
 * In-house top-down aircraft silhouettes per catalogue category, drawn in `currentColor`
 * with the same construction as the map marker (nose up): fuselage, wings, nacelles,
 * tailplane and cockpit glazing.
 */
export function TypeSilhouette({
  category,
  className,
}: {
  category: Category | string;
  className?: string;
}) {
  const jet = category === "narrowbody-jet" || category === "widebody-jet";
  const wide = category === "widebody-jet";
  const single = category === "single-piston" || category === "single-turboprop";
  const regional = category === "regional-turboprop";
  // Wing geometry: straight high wings for turboprops, swept wings for jets.
  const wing = jet
    ? wide
      ? "M35.6 22 62 38.5v3.6L35.6 33Z M28.4 22 2 38.5v3.6L28.4 33Z"
      : "M35.4 23.5 60.5 37v3.4L35.4 32.6Z M28.6 23.5 3.5 37v3.4l25.1-7.8Z"
    : regional
      ? "M35.4 22.5 62 26v4l-26.6-1.8Z M28.6 22.5 2 26v4l26.6-1.8Z"
      : "M35.4 21.5 60.5 24.6v3.8L35.4 27.4Z M28.6 21.5 3.5 24.6v3.8l25.1-1Z";
  const nacelles: Array<[number, number]> = jet
    ? wide
      ? [
          [44, 29],
          [52.5, 33.6],
          [15.5, 29],
          [7, 33.6],
        ]
      : [
          [45.5, 30.8],
          [14, 30.8],
        ]
    : single
      ? []
      : regional
        ? [
            [43.6, 20.5],
            [16, 20.5],
          ]
        : [
            [44.2, 19.8],
            [15.4, 19.8],
          ];
  return (
    <svg viewBox="0 0 64 64" className={cn(className)} aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <path
          d={
            wide
              ? "M32 1.5c3.2 0 4.6 4 4.6 8.4V50c0 4.6-2 9.8-4.6 12.6-2.6-2.8-4.6-8-4.6-12.6V9.9c0-4.4 1.4-8.4 4.6-8.4Z"
              : "M32 2.5c2.5 0 3.7 3.4 3.7 7.2V49c0 4.4-1.6 9.6-3.7 12.5-2.1-2.9-3.7-8.1-3.7-12.5V9.7c0-3.8 1.2-7.2 3.7-7.2Z"
          }
        />
        <path d={wing} />
        {nacelles.map(([x, y]) => (
          <rect key={`${x}-${y}`} x={x} y={y} width="4.4" height={jet ? 8 : 11} rx="2.2" />
        ))}
        {single ? <rect x="30.6" y="0.6" width="2.8" height="3" rx="1" /> : null}
        <path d="M35.2 49.2 45.6 54v2.9l-10.4-2Z" />
        <path d="M28.8 49.2 18.4 54v2.9l10.4-2Z" />
      </g>
      <path
        className="fill-background/70"
        d="M30.2 8.6c.5-1.6 1.1-2.4 1.8-2.4s1.3.8 1.8 2.4l-1.8.9Z"
      />
    </svg>
  );
}
