import type { Source } from "@cargo-ops/protocol";

import { SourceTag } from "@/components/status/SourceTag";
import type { ReceivedEvent } from "@/lib/sim-state";
import { formatUtc, loopLines, type LoopTone } from "@/lib/ops/mission-control";
import { cn } from "@/lib/utils";

import { ConsolePanel } from "./Console";

const TONE: Record<LoopTone, string> = {
  go: "text-phosphor-green",
  hold: "text-phosphor-amber",
  nogo: "text-phosphor-red",
  info: "text-phosphor-cyan",
};

/**
 * The comms loop: connector events as they arrive, newest first, stamped with the UTC time
 * this browser received them. Nothing is synthesised: no events, no lines.
 */
export function EventLoop({
  events,
  source,
  emptyText,
  className,
}: {
  events: readonly ReceivedEvent[];
  source: Source | null;
  emptyText: string;
  className?: string;
}) {
  const lines = loopLines(events, 60);
  return (
    <ConsolePanel
      callsign="COMMS"
      title="Event loop"
      source={lines.length > 0 ? source : null}
      className={className}
      bodyClassName="p-0 md:p-0"
      testId="event-loop"
    >
      {lines.length === 0 ? (
        <p className="p-4 font-mono text-xs text-muted-foreground" data-testid="event-loop-empty">
          {emptyText}
        </p>
      ) : (
        <ol
          role="log"
          aria-label="Connector events, newest first"
          className="max-h-72 overflow-y-auto overscroll-contain py-1 font-mono text-xs lg:max-h-[22rem]"
        >
          {lines.map((l) => (
            <li
              key={l.key}
              className="console-rule grid grid-cols-[auto_minmax(0,1fr)_auto] items-baseline gap-x-3 border-b px-3 py-1.5 last:border-b-0"
              data-testid="loop-line"
              data-event={l.name}
              data-source={l.source}
            >
              <time
                className="text-muted-foreground tabular-nums"
                dateTime={new Date(l.at).toISOString()}
              >
                {formatUtc(l.at)}
              </time>
              <span className={cn("truncate", TONE[l.tone])} title={l.text}>
                {l.text}
              </span>
              <SourceTag source={l.source} />
            </li>
          ))}
        </ol>
      )}
    </ConsolePanel>
  );
}
