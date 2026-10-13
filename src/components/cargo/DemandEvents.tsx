import { CloudLightning, Megaphone, PartyPopper, TrendingUp, type LucideIcon } from "lucide-react";

import type { DemandEventKind, DemandState, Source } from "@cargo-ops/protocol";
import { formatGameTime, type AirportLookup } from "@cargo-ops/economy";
import { Panel } from "@/components/dashboard/Panel";
import { SourceTag } from "@/components/status/SourceTag";
import { cn } from "@/lib/utils";

const ICONS: Record<DemandEventKind, LucideIcon> = {
  storm: CloudLightning,
  festival: PartyPopper,
  strike: Megaphone,
};

/**
 * Active local demand events (storm, festival, strike): job payouts and fuel prices are
 * higher at those airports for a few in-game days. Also lists airports whose demand index
 * your own deliveries moved.
 */
export function DemandEvents({
  demand,
  source,
  lookup,
  className,
}: {
  demand: DemandState | null;
  source: Source | null;
  lookup: AirportLookup | null;
  className?: string;
}) {
  const events = demand?.events ?? [];
  const moved = (demand?.indices ?? []).filter((i) => !i.eventId && Math.abs(i.index - 1) >= 0.01);
  return (
    <Panel
      {...(className ? { className } : {})}
      eyebrow="Local demand"
      title={
        events.length > 0
          ? `${events.length} active event${events.length === 1 ? "" : "s"}`
          : "No events right now"
      }
      icon={TrendingUp}
      action={<SourceTag source={demand ? source : null} />}
      bodyClassName="p-3 md:p-4"
    >
      {events.length > 0 ? (
        <ul className="grid gap-2 md:grid-cols-2 xl:grid-cols-3" data-testid="demand-events">
          {events.map((e) => {
            const Icon = ICONS[e.kind];
            return (
              <li
                key={e.id}
                className="panel-inset flex items-start gap-3 px-4 py-3"
                data-testid="demand-event"
              >
                <Icon
                  className={cn(
                    "mt-0.5 size-4 shrink-0",
                    e.kind === "storm" ? "text-warning" : "text-accent",
                  )}
                  aria-hidden="true"
                />
                <div className="min-w-0 text-sm">
                  <p className="truncate text-foreground">
                    <span className="font-mono font-semibold">{e.icao}</span> {e.label}
                    <span className="text-muted-foreground">
                      {" "}
                      · {lookup?.get(e.icao)?.name ?? ""}
                    </span>
                  </p>
                  <p className="font-mono text-xs text-muted-foreground">
                    payouts <span className="text-success">+{e.payoutPct} %</span> · fuel{" "}
                    <span className="text-warning">+{e.fuelPct} %</span> · until{" "}
                    {formatGameTime(e.endGameMs)}
                  </p>
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="px-1 text-sm text-muted-foreground">
          Storms, festivals and strikes lift payouts and fuel prices at an airport for a few in-game
          days; they appear here and on the map.
        </p>
      )}
      {moved.length > 0 ? (
        <p
          className="mt-3 px-1 font-mono text-xs text-muted-foreground"
          data-testid="demand-indices"
        >
          Demand moved by your deliveries:{" "}
          {moved
            .slice(0, 8)
            .map((i) => `${i.icao} ${i.index >= 1 ? "+" : ""}${Math.round((i.index - 1) * 100)} %`)
            .join(" · ")}
        </p>
      ) : null}
    </Panel>
  );
}
