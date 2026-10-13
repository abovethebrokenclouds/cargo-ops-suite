import { Wrench } from "lucide-react";

import type { MaintenanceOrder } from "@cargo-ops/protocol";
import { formatGameTime } from "@cargo-ops/economy";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const kindLabel = { overhaul: "Overhaul", defect: "Repair", annual: "Annual" } as const;

/** Queued and running maintenance orders with progress and estimated completion. */
export function MaintenanceBoard({
  orders,
  gameMs,
}: {
  orders: readonly MaintenanceOrder[];
  /** Company clock now, for progress. */
  gameMs: number | null;
}) {
  if (orders.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="maintenance-empty">
        No aircraft in the shop.
      </p>
    );
  }
  return (
    <ol className="flex flex-col gap-2" data-testid="maintenance-board">
      {orders.map((o) => {
        const span = Math.max(1, o.readyAtGameMs - o.startGameMs);
        const done =
          gameMs === null ? 0 : Math.max(0, Math.min(1, (gameMs - o.startGameMs) / span));
        const running = gameMs !== null && gameMs >= o.startGameMs;
        return (
          <li
            key={o.id}
            className="panel-inset grid gap-2 px-4 py-3 md:grid-cols-[8rem_minmax(0,1fr)_auto] md:items-center"
            data-testid="maintenance-order"
          >
            <div className="flex items-center gap-2">
              <Wrench
                className={cn("size-4", running ? "text-warning" : "text-muted-foreground")}
                aria-hidden="true"
              />
              <span className="font-mono text-sm font-semibold text-foreground">
                {o.registration ?? o.aircraftId}
              </span>
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm text-foreground">
                <span className="label-eyebrow mr-2">{kindLabel[o.kind]}</span>
                {o.label}
              </p>
              <div
                className="relative mt-1.5 h-1.5 overflow-hidden rounded-full bg-secondary"
                role="progressbar"
                aria-label={`${o.label} progress`}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(done * 100)}
              >
                <span
                  className="absolute inset-y-0 left-0 rounded-full bg-gradient-brand"
                  style={{ width: `${done * 100}%` }}
                />
              </div>
            </div>
            <div className="text-right font-mono text-xs text-muted-foreground font-tabular">
              <p className="text-foreground" data-testid="maintenance-eta">
                ETA {formatGameTime(o.readyAtGameMs)}
              </p>
              <p>
                {o.airport} · {o.shop === "field" ? "field repair" : "maintenance base"} ·{" "}
                {o.hours.toFixed(0)} h · {formatUsd(o.cost)}
              </p>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
