import { SourceTag } from "@/components/status/SourceTag";
import { boardSummary, type Lamp, type LampState } from "@/lib/ops/mission-control";
import { cn } from "@/lib/utils";

import { ConsolePanel } from "./Console";

const STATE_WORD: Record<LampState, string> = {
  go: "GO",
  hold: "HOLD",
  nogo: "NO-GO",
  info: "INFO",
  nodata: "NO DATA",
};

function sampleTag() {
  return (
    <span
      className="shrink-0 rounded-sm bg-warning/15 px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold leading-none tracking-[0.16em] text-warning"
      title="Built-in sample report, not real weather"
      data-metar-origin="sample"
    >
      SAMPLE
    </span>
  );
}

/**
 * GO / NO-GO status board: one lamp per real check. A lamp lights only from data the app
 * holds; unknown checks stay dark grey and read NO DATA.
 */
export function GoNoGoBoard({ lamps, className }: { lamps: readonly Lamp[]; className?: string }) {
  const s = boardSummary(lamps);
  return (
    <ConsolePanel
      callsign="STATUS"
      title="Go / No-go board"
      className={className}
      testId="go-nogo-board"
      action={
        <span
          className="hidden font-mono text-[0.625rem] tracking-[0.14em] text-muted-foreground sm:inline"
          data-testid="board-summary"
        >
          <span className="text-phosphor-green">{s.go} GO</span> ·{" "}
          <span className="text-phosphor-amber">{s.hold} HOLD</span> ·{" "}
          <span className="text-phosphor-red">{s.nogo} NO-GO</span> · {s.nodata} NO DATA
        </span>
      }
    >
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-4 2xl:grid-cols-5">
        {lamps.map((lamp) => (
          <li
            key={lamp.id}
            className="lamp flex min-w-0 flex-col gap-1 px-2.5 py-2"
            data-testid="lamp"
            data-lamp={lamp.id}
            data-state={lamp.state}
            title={lamp.detail}
          >
            <span className="flex items-center justify-between gap-1.5">
              <span className="truncate font-mono text-[0.625rem] font-semibold tracking-[0.18em] text-console-foreground">
                {lamp.label}
              </span>
              {lamp.sample ? sampleTag() : <SourceTag source={lamp.source} />}
            </span>
            <span
              className={cn(
                "truncate font-mono text-base font-bold tracking-[0.1em] tabular-nums",
                lamp.state === "nodata" && "text-sm font-semibold",
              )}
              data-testid="lamp-value"
            >
              {lamp.value}
            </span>
            <span className="sr-only">
              {STATE_WORD[lamp.state]}: {lamp.detail}
            </span>
          </li>
        ))}
      </ul>
    </ConsolePanel>
  );
}
