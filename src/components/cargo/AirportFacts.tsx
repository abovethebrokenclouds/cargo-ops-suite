import type { ReactNode } from "react";
import { surfaceClass } from "@cargo-ops/protocol";
import type { FacilityLookup, FieldSource } from "@cargo-ops/economy";

import { fieldSourceLabel } from "@/lib/economy/facilities";
import { formatFeet } from "@/lib/format";
import { cn } from "@/lib/utils";

/** "MSFS" / "OurAirports" chip next to one field. */
export function FieldSourceTag({
  source,
  className,
}: {
  source: FieldSource | null;
  className?: string;
}) {
  if (!source) return null;
  return (
    <span
      className={cn(
        "ml-1.5 inline-block rounded-sm px-1 py-0.5 align-middle font-mono text-[0.5625rem] font-semibold leading-none tracking-[0.12em]",
        source === "msfs"
          ? "bg-primary/15 text-accent"
          : "border border-border text-muted-foreground",
        className,
      )}
      data-field-source={source}
    >
      {fieldSourceLabel(source)}
    </span>
  );
}

function Fact({
  label,
  source,
  children,
  testId,
}: {
  label: string;
  source: FieldSource | null;
  children: ReactNode;
  testId: string;
}) {
  return (
    <div data-testid={testId}>
      <dt className="label-eyebrow text-[0.5625rem]">{label}</dt>
      <dd className="font-tabular text-sm text-foreground">
        {children}
        <FieldSourceTag source={source} />
      </dd>
    </div>
  );
}

/**
 * The board airport as the job generator sees it: OurAirports data, with the connected
 * sim's facility data (MSFS, add-on scenery included) merged over it field by field.
 */
export function AirportFacts({
  ident,
  lookup,
}: {
  ident: string | null;
  lookup: FacilityLookup | null;
}) {
  const airport = lookup?.get(ident) ?? null;
  const sources = lookup?.sourcesOf(ident) ?? null;
  const msfs = lookup?.msfsOf(ident) ?? null;
  if (!airport || !sources) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="airport-facts-empty">
        {ident ? `No airport data for ${ident}.` : "No board airport yet."}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-4" data-testid="airport-facts">
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-mono text-base font-semibold tracking-[0.12em] text-accent">
          {airport.ident}
        </span>
        <span className="truncate text-sm text-foreground">
          {airport.name}
          <FieldSourceTag source={sources.name} />
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-3 font-mono text-xs md:grid-cols-4">
        <Fact label="Position" source={sources.position} testId="fact-position">
          {airport.lat.toFixed(4)}, {airport.lon.toFixed(4)}
        </Fact>
        <Fact label="Elevation" source={sources.elevation} testId="fact-elevation">
          {formatFeet(airport.elevFt)}
        </Fact>
        <Fact label="Longest rwy" source={sources.runway} testId="fact-runway">
          {formatFeet(airport.longestRwyFt)}
        </Fact>
        <Fact label="Surface" source={sources.surface} testId="fact-surface">
          {surfaceClass(airport.surface)}
        </Fact>
      </dl>
      {msfs && msfs.runways.length > 0 ? (
        <table className="w-full font-mono text-xs" data-testid="msfs-runways">
          <caption className="label-eyebrow mb-1 text-left text-[0.5625rem]">
            Runways in the simulator
            <FieldSourceTag source="msfs" />
          </caption>
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 text-left font-normal">Runway</th>
              <th className="py-1 text-right font-normal">Length</th>
              <th className="py-1 text-right font-normal">Heading (true)</th>
              <th className="py-1 text-right font-normal">Surface</th>
            </tr>
          </thead>
          <tbody>
            {msfs.runways.map((r, i) => (
              <tr key={`${r.ident}-${i}`} className="border-t border-border text-foreground">
                <td className="py-1">{r.ident || "—"}</td>
                <td className="py-1 text-right font-tabular">{formatFeet(r.lengthFt)}</td>
                <td className="py-1 text-right font-tabular">{r.headingTrueDeg.toFixed(1)}°</td>
                <td className="py-1 text-right">{r.surface ?? `code ${r.surfaceCode}`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {msfs ? (
        <p className="text-xs text-muted-foreground">
          From {msfs.sim ?? "the simulator"}, {new Date(msfs.fetchedAt).toLocaleDateString()}. MSFS
          data can change which jobs this airport offers.
        </p>
      ) : null}
    </div>
  );
}
