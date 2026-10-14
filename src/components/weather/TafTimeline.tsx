import { useId, useState } from "react";
import {
  formatObservationAge,
  formatTafTime,
  isTafExpired,
  tafAt,
  tafPeriodLabel,
  type TafPeriod,
  type TafStationResult,
} from "@cargo-ops/weather";

import { cn } from "@/lib/utils";

import { CATEGORY_FILL, CATEGORY_OUTLINE, CATEGORY_TEXT, UNKNOWN_FILL } from "./category-classes";
import { FlightCategoryChip } from "./FlightCategoryChip";
import { MetarOriginTag } from "./MetarStation";

const HOUR = 3600_000;

const isPrevailing = (p: TafPeriod) => p.kind === "BASE" || p.kind === "FM";

/** Body of a period without its change indicator and time group. */
function periodBody(p: TafPeriod): string {
  const words = p.text.split(" ");
  let i = 0;
  while (
    i < words.length &&
    /^(FM\d{6}|BECMG|TEMPO|PROB\d{2}|\d{4}\/\d{4})$/.test(words[i] ?? "")
  ) {
    i++;
  }
  return words.slice(i).join(" ");
}

/**
 * Compact TAF timeline for one station: prevailing periods as a coloured bar (flight category
 * per period), TEMPO/PROB/BECMG as outlined bars below it, a "now" tick and an ETA marker.
 */
export function TafTimeline({
  role = "Destination",
  result,
  now,
  etaMs = null,
  attribution,
  className,
}: {
  role?: string;
  result: TafStationResult | null;
  /** Current time (null before mount). */
  now: number | null;
  /** Estimated arrival, ms since epoch; null when there is none. */
  etaMs?: number | null;
  /** Data credit shown under live forecasts. */
  attribution?: string;
  className?: string;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const rawId = useId();
  const received = result?.report ?? null;
  // Checked here too, not only in the connector: a TAF that ends between two polls (or a
  // NIL/CNL one) must leave the screen at once.
  const expired = received !== null && now !== null && isTafExpired(received, now);
  const cancelled = received?.cancelled === true;
  const taf = expired || cancelled ? null : received;
  const note = cancelled
    ? "The TAF for this station is NIL or cancelled (CNL): no forecast."
    : expired
      ? "The last TAF for this station has expired."
      : (result?.note ?? "Loading forecast…");
  const from = taf?.validFrom ? Date.parse(taf.validFrom) : NaN;
  const to = taf?.validTo ? Date.parse(taf.validTo) : NaN;
  const span = to - from;
  const usable = taf !== null && Number.isFinite(span) && span > 0;
  const pct = (t: number) => `${(Math.min(Math.max((t - from) / span, 0), 1) * 100).toFixed(3)}%`;
  const width = (a: number, b: number) =>
    `${((Math.max(0, Math.min(b, to) - Math.max(a, from)) / span) * 100).toFixed(3)}%`;

  const ticks: number[] = [];
  if (usable) {
    const first = Math.ceil(from / (6 * HOUR)) * 6 * HOUR;
    for (let t = first; t <= to; t += 6 * HOUR) ticks.push(t);
  }
  const issuedAge =
    taf && now !== null && taf.issuedAt ? formatObservationAge(taf.issuedAt, now) : null;
  const nowInside = usable && now !== null && now >= from && now <= to;
  const eta = etaMs !== null && Number.isFinite(etaMs) ? etaMs : null;
  const etaInside = usable && eta !== null && eta >= from && eta < to;
  const atEta = usable && etaInside && taf ? tafAt(taf, eta as number) : null;
  const prevailing = taf?.periods.filter(isPrevailing) ?? [];
  const changes = taf?.periods.filter((p) => !isPrevailing(p)) ?? [];

  return (
    <div
      className={cn("panel-inset flex min-w-0 flex-col gap-3 p-4", className)}
      data-testid="taf-timeline"
      data-station={result?.station ?? ""}
      data-origin={taf?.origin ?? "none"}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="label-eyebrow">{role} forecast</span>
        <span className="font-display text-base font-bold tracking-tight">
          TAF {result?.station ?? "—"}
        </span>
        {taf ? <MetarOriginTag origin={taf.origin} stale={taf.stale} /> : null}
        {taf?.amended ? (
          <span className="font-mono text-[0.625rem] font-semibold tracking-[0.16em] text-muted-foreground">
            AMD
          </span>
        ) : null}
        {taf ? (
          <span className="ml-auto text-xs text-muted-foreground" data-testid="taf-validity">
            {formatTafTime(taf.validFrom)} – {formatTafTime(taf.validTo)}
            {issuedAge ? ` · issued ${issuedAge}` : ""}
          </span>
        ) : null}
      </div>

      {!taf ? (
        <p className="text-sm text-muted-foreground" data-testid="taf-note">
          {note}
        </p>
      ) : !usable ? (
        <p className="text-sm text-muted-foreground" data-testid="taf-note">
          This TAF has no readable validity period.
        </p>
      ) : (
        <>
          <div className="relative pt-4" aria-hidden="true">
            {/* Prevailing conditions */}
            <div className="relative h-5 overflow-hidden rounded-md bg-secondary">
              {prevailing.map((p, i) => {
                const a = Date.parse(p.from);
                const b = Date.parse(p.to);
                return (
                  <div
                    key={`${p.from}-${i}`}
                    className={cn(
                      "absolute inset-y-0 border-r border-background/60",
                      p.category ? CATEGORY_FILL[p.category] : UNKNOWN_FILL,
                    )}
                    style={{ left: pct(a), width: width(a, b) }}
                    data-testid="taf-segment"
                    data-category={p.category ?? "unknown"}
                  />
                );
              })}
            </div>
            {/* Temporary / probable / becoming changes */}
            {changes.length > 0 ? (
              <div className="relative mt-1 h-3">
                {changes.map((p, i) => {
                  const a = Date.parse(p.from);
                  const b = Date.parse(p.to);
                  return (
                    <div
                      key={`${p.from}-${p.kind}-${i}`}
                      className={cn(
                        "absolute inset-y-0 rounded-sm border",
                        p.category ? CATEGORY_OUTLINE[p.category] : "border-border",
                        p.kind === "PROB" && "border-dashed",
                      )}
                      style={{ left: pct(a), width: width(a, b) }}
                    />
                  );
                })}
              </div>
            ) : null}
            {nowInside && now !== null ? (
              <div
                className="absolute bottom-0 top-3 w-px bg-foreground/70"
                style={{ left: pct(now) }}
                data-testid="taf-now"
              />
            ) : null}
            {etaInside && eta !== null ? (
              <div
                className="absolute bottom-0 top-0 flex w-0 flex-col items-center"
                style={{ left: pct(eta) }}
                data-testid="taf-eta-marker"
              >
                <span className="-mt-0.5 font-mono text-[0.5625rem] font-semibold leading-none tracking-[0.12em] text-accent">
                  ETA
                </span>
                <span className="mt-0.5 w-0.5 flex-1 rounded-full bg-accent" />
              </div>
            ) : null}
          </div>
          <div className="relative h-3" aria-hidden="true">
            {ticks.map((t) => (
              <span
                key={t}
                className="absolute -translate-x-1/2 font-mono text-[0.625rem] leading-none text-muted-foreground"
                style={{ left: pct(t) }}
              >
                {String(new Date(t).getUTCHours()).padStart(2, "0")}Z
              </span>
            ))}
          </div>

          {eta !== null ? (
            <p className="flex flex-wrap items-center gap-2 text-sm" data-testid="taf-eta">
              <span className="text-muted-foreground">
                At ETA {formatTafTime(new Date(eta).toISOString())}
              </span>
              {atEta ? (
                <>
                  <FlightCategoryChip category={atEta.category} />
                  {atEta.changes.map((c, i) => (
                    <span
                      key={`${c.from}-${i}`}
                      className={cn(
                        "font-mono text-xs",
                        c.category ? CATEGORY_TEXT[c.category] : "text-muted-foreground",
                      )}
                    >
                      {tafPeriodLabel(c)} {c.category ?? "?"}
                    </span>
                  ))}
                </>
              ) : (
                <span className="text-muted-foreground">
                  {eta < from ? "before this TAF starts" : "after this TAF ends"}
                </span>
              )}
            </p>
          ) : null}

          <ol
            className="flex flex-col gap-1 text-xs"
            aria-label={`TAF ${result?.station ?? ""} periods`}
          >
            {taf.periods.map((p, i) => (
              <li
                key={`${p.from}-${p.kind}-${i}`}
                className={cn(
                  "grid grid-cols-[6rem_6.5rem_minmax(0,1fr)] items-baseline gap-x-2 sm:grid-cols-[6rem_6.5rem_2.75rem_minmax(0,1fr)]",
                  !isPrevailing(p) && "text-muted-foreground",
                )}
                data-testid="taf-period"
                data-kind={p.kind}
                data-category={p.category ?? "unknown"}
              >
                <span className="font-mono font-semibold tracking-[0.08em]">
                  {tafPeriodLabel(p)}
                </span>
                <span className="font-mono font-tabular">
                  {formatTafTime(p.from)}–{formatTafTime(p.to)}
                </span>
                <span
                  className={cn(
                    "font-mono font-semibold",
                    p.category ? CATEGORY_TEXT[p.category] : "text-muted-foreground",
                  )}
                >
                  {p.category ?? "—"}
                </span>
                <span
                  className="col-span-full break-words font-mono sm:col-span-1 sm:truncate"
                  title={p.text}
                >
                  {periodBody(p)}
                </span>
              </li>
            ))}
          </ol>

          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span data-testid="taf-source">
              {taf.origin === "sample"
                ? "SAMPLE TAF built into Cargo Ops: not a real forecast."
                : `${attribution ?? "TAF: aviationweather.gov"}. For simulation only.`}
            </span>
            <button
              type="button"
              className="ml-auto font-medium text-accent hover:text-foreground"
              aria-expanded={showRaw}
              aria-controls={rawId}
              onClick={() => setShowRaw((v) => !v)}
              data-testid="taf-raw-toggle"
            >
              {showRaw ? "Hide raw TAF" : "Raw TAF"}
            </button>
          </div>
          {showRaw ? (
            <pre
              id={rawId}
              className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-background/60 px-3 py-2 font-mono text-xs text-foreground"
              data-testid="taf-raw"
            >
              {taf.rawText}
            </pre>
          ) : null}
        </>
      )}
      {taf && result?.note && taf.origin === "live" ? (
        <p className="text-xs text-muted-foreground">{result.note}</p>
      ) : null}
    </div>
  );
}
