import { PHASE_LABELS } from "@/components/flight/phases";
import { SourceTag, StaleTag } from "@/components/status/SourceTag";
import { isSessionUp, isStale } from "@/lib/flight/flight-view";
import { formatDegrees, formatInt } from "@/lib/format";
import { formatMet, formatUtc, missionElapsedSec, utcDayOfYear } from "@/lib/ops/mission-control";
import { altitudeFromFt, useUnits } from "@/lib/settings/units";
import type { ClientSimState } from "@/lib/sim-state";
import type { TransportKind } from "@/lib/transport/useSimConnection";
import { cn } from "@/lib/utils";

import { Readout } from "./Console";
import { OpsMapCompact } from "./OpsMapCompact";

function signed(n: number): string {
  const r = Math.round(n);
  if (r === 0) return "0";
  return `${r > 0 ? "+" : "−"}${formatInt(Math.abs(r))}`;
}

/**
 * Front wall of the operations room: the world/route display flanked by the big clocks
 * (mission elapsed, UTC), the phase of flight and the ALT / GS / VS / HDG readouts.
 */
export function FrontWall({
  state,
  transportKind,
  now,
}: {
  state: ClientSimState;
  transportKind: TransportKind | null;
  now: number | null;
}) {
  const [units] = useUnits();
  const up = isSessionUp(state);
  const stale = isStale(state, now);
  const position = up ? (state.sim.position ?? null) : null;
  const motion = up ? (state.sim.motion ?? null) : null;
  const phase = up ? (state.sim.phase?.current ?? null) : null;
  const met = missionElapsedSec(state);
  const source = up ? state.source : null;
  const day = utcDayOfYear(now);
  const origin = up ? (state.sim.plan?.origin ?? state.sim.flight?.origin ?? null) : null;
  const destination = up
    ? (state.sim.plan?.destination ?? state.sim.flight?.destination ?? null)
    : null;

  return (
    <section
      aria-label="Front wall"
      className="console-panel overflow-hidden"
      data-testid="front-wall"
      data-stale={stale ? "" : undefined}
    >
      <header className="console-strip">
        <h2 className="flex min-w-0 items-baseline gap-2">
          <span>FLIGHT</span>
          <span className="truncate text-[0.625rem] font-medium tracking-[0.16em] text-muted-foreground">
            Front wall · {origin && destination ? `${origin} → ${destination}` : "No route"}
          </span>
        </h2>
        <span className="flex shrink-0 items-center gap-1.5">
          {stale ? <StaleTag /> : null}
          <SourceTag source={source} />
        </span>
      </header>
      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)_minmax(0,15rem)]">
        {/* Clocks and phase */}
        <dl className="console-rule grid grid-cols-1 gap-4 border-b p-4 sm:grid-cols-2 lg:order-1 lg:grid-cols-1 lg:content-start lg:border-b-0 lg:border-r">
          <Readout
            label="MET · block time"
            value={met === null ? null : formatMet(met)}
            tone="amber"
            size="lg"
            testId="readout-met"
          />
          <Readout
            label={day ? `UTC · day ${day}` : "UTC"}
            value={now === null ? null : formatUtc(now)}
            tone="cyan"
            size="lg"
            testId="readout-utc"
          />
          <Readout
            label="Phase"
            value={phase ? PHASE_LABELS[phase].toUpperCase() : null}
            tone="green"
            size="lg"
            className="sm:col-span-2 lg:col-span-1"
            testId="readout-phase"
          />
        </dl>

        {/* World / route display */}
        <div
          className={cn(
            "relative order-first h-56 border-b sm:h-72 lg:order-2 lg:h-auto lg:min-h-[22rem] lg:border-b-0",
            "console-rule",
          )}
          data-testid="front-wall-map"
        >
          <OpsMapCompact
            state={state}
            transportKind={transportKind}
            now={now}
            className="absolute inset-0"
          />
          {!position ? (
            <p
              className="pointer-events-none absolute inset-x-0 top-3 z-10 text-center font-mono text-xs tracking-[0.2em] text-muted-foreground"
              data-testid="front-wall-no-position"
            >
              NO POSITION DATA
            </p>
          ) : null}
        </div>

        {/* Flight readouts */}
        <dl className="grid grid-cols-2 gap-4 p-4 lg:order-3 lg:grid-cols-1 lg:content-start lg:border-l lg:console-rule">
          <Readout
            label="ALT"
            value={position ? formatInt(altitudeFromFt(position.altFt, units.altitude)) : null}
            unit={units.altitude}
            size="lg"
            testId="readout-alt"
          />
          <Readout
            label="GS"
            value={motion ? formatInt(motion.gsKt) : null}
            unit="kt"
            size="lg"
            testId="readout-gs"
          />
          <Readout
            label="VS"
            value={motion ? signed(motion.vsFpm) : null}
            unit="fpm"
            size="lg"
            testId="readout-vs"
          />
          <Readout
            label="HDG"
            value={motion ? formatDegrees(motion.hdgMagDeg) : null}
            unit="mag"
            size="lg"
            testId="readout-hdg"
          />
        </dl>
      </div>
    </section>
  );
}
