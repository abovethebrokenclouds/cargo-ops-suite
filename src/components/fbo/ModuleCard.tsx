import { Building, Fuel, Package, PlaneLanding, Wrench, type LucideIcon } from "lucide-react";

import type { FboModule, FboModuleKind } from "@cargo-ops/protocol";
import { formatGameTime } from "@cargo-ops/economy";
import { ghostButton } from "@/components/company/styles";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

const ICONS: Record<FboModuleKind, LucideIcon> = {
  fuel: Fuel,
  hangar: Building,
  maintenance: Wrench,
  cargo: Package,
  ramp: PlaneLanding,
};

/** One FBO module: level pips, what it does, upkeep, and the buy/upgrade action. */
export function ModuleCard({
  module: m,
  gameMs,
  enabled,
  busy,
  disabledNote,
  onBuy,
  onUpgrade,
}: {
  module: FboModule;
  gameMs: number | null;
  enabled: boolean;
  busy: boolean;
  disabledNote: string | undefined;
  onBuy: () => void;
  onUpgrade: () => void;
}) {
  const Icon = ICONS[m.kind];
  const installed = m.level > 0;
  const pending = m.pending;
  const action = installed ? "Upgrade" : "Install";
  return (
    <article
      className={cn(
        "panel-inset flex min-w-0 flex-col gap-3 p-4",
        !installed && !pending && "opacity-80",
      )}
      data-testid="fbo-module"
      data-kind={m.kind}
      data-level={m.level}
    >
      <header className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "grid size-8 shrink-0 place-items-center rounded-lg border",
              installed
                ? "border-primary/30 bg-primary/10 text-accent"
                : "border-border bg-secondary text-muted-foreground",
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
          </span>
          <h3 className="truncate text-sm font-semibold text-foreground">{m.label}</h3>
        </div>
        <span className="flex items-center gap-1" role="img" aria-label={`Level ${m.level} of 3`}>
          {[1, 2, 3].map((l) => (
            <span
              key={l}
              className={cn(
                "h-1.5 w-4 rounded-full",
                l <= m.level ? "bg-gradient-brand" : "bg-secondary",
              )}
            />
          ))}
        </span>
      </header>
      <p className="min-h-10 text-xs text-muted-foreground">{m.effect}</p>
      <dl className="grid grid-cols-2 gap-2 font-mono text-[0.6875rem]">
        <div>
          <dt className="text-muted-foreground">Upkeep</dt>
          <dd className="text-foreground font-tabular">{formatUsd(m.upkeepMonthly)}/mo</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">{installed ? "Next level" : "Install"}</dt>
          <dd className="text-foreground font-tabular">
            {m.nextCost === null ? "Max level" : `${formatUsd(m.nextCost)} · ${m.nextDays ?? 0} d`}
          </dd>
        </div>
      </dl>
      {pending ? (
        <p className="rounded-md bg-warning/10 px-2 py-1 font-mono text-[0.6875rem] text-warning">
          Level {pending.toLevel} ready {formatGameTime(pending.readyAtGameMs)}
          {gameMs !== null && pending.readyAtGameMs > gameMs
            ? ` (${Math.ceil((pending.readyAtGameMs - gameMs) / 3_600_000)} h)`
            : ""}
        </p>
      ) : m.nextCost !== null ? (
        <button
          type="button"
          className={cn(ghostButton, "self-start border border-border")}
          disabled={!enabled || busy}
          title={disabledNote ?? `${action} for ${formatUsd(m.nextCost)}`}
          onClick={installed ? onUpgrade : onBuy}
          data-testid="fbo-module-action"
        >
          {action} {formatUsd(m.nextCost)}
        </button>
      ) : null}
    </article>
  );
}
