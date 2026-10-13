import { Route as RouteIcon } from "lucide-react";
import { useMemo, useState } from "react";

import type { AircraftType, Job, Source } from "@cargo-ops/protocol";
import { findRoutes } from "@cargo-ops/economy";
import { EmptyState } from "@/components/EmptyState";
import { Panel } from "@/components/dashboard/Panel";
import { SourceTag } from "@/components/status/SourceTag";
import { formatInt, formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Multi-hop suggestions (max 3 legs) over the jobs on offer, best total payout first. */
export function RouteFinder({
  start,
  jobs,
  type,
  source,
  className,
}: {
  start: string | null;
  jobs: readonly Job[];
  type: AircraftType;
  source: Source | null;
  className?: string;
}) {
  const [hops, setHops] = useState(3);
  const routes = useMemo(
    () => (start ? findRoutes({ start, jobs, aircraft: type, maxHops: hops, limit: 5 }) : []),
    [start, jobs, type, hops],
  );
  return (
    <Panel
      {...(className ? { className } : {})}
      eyebrow="Route finder"
      title={start ? `Best chains from ${start}` : "Best chains"}
      icon={RouteIcon}
      action={
        <div className="flex items-center gap-2">
          <SourceTag source={source} />
          <label className="sr-only" htmlFor="route-hops">
            Maximum legs
          </label>
          <select
            id="route-hops"
            value={hops}
            onChange={(e) => setHops(Number(e.target.value))}
            className="rounded-md border border-input bg-secondary px-2 py-1 text-xs text-foreground"
          >
            {[1, 2, 3].map((n) => (
              <option key={n} value={n}>
                ≤ {n} leg{n === 1 ? "" : "s"}
              </option>
            ))}
          </select>
        </div>
      }
    >
      {routes.length === 0 ? (
        <EmptyState
          icon={RouteIcon}
          title="No chains yet"
          description="Chains link jobs whose destination has its own board. Refresh a board at a destination to plan the next legs."
        />
      ) : (
        <ol className="flex flex-col gap-2" data-testid="route-finder">
          {routes.map((r, i) => (
            <li
              key={r.legs.map((l) => `${l.origin}${l.destination}`).join("-")}
              className={cn("panel-inset px-4 py-3", i === 0 && "border-primary/40")}
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="font-mono text-sm font-semibold text-foreground">
                  {[r.legs[0]?.origin, ...r.legs.map((l) => l.destination)].join(" → ")}
                </p>
                <p className="font-mono text-sm font-tabular text-accent">
                  {formatUsd(r.totalPayout)}
                </p>
              </div>
              <p className="mt-1 text-xs text-muted-foreground">
                {r.legs.length} leg{r.legs.length === 1 ? "" : "s"} ·{" "}
                {r.legs.reduce((s, l) => s + l.jobIds.length, 0)} jobs ·{" "}
                <span className="font-tabular">{formatInt(r.totalNm)} nm</span> ·{" "}
                <span className="font-tabular">{formatUsd(r.payoutPerNm)}/nm</span>
              </p>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
