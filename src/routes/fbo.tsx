import { createFileRoute } from "@tanstack/react-router";
import {
  BarChart3,
  Building2,
  CalendarClock,
  Gauge,
  ListOrdered,
  MapPinned,
  SlidersHorizontal,
  Store,
} from "lucide-react";
import { useMemo, useState } from "react";

import type { FboState, Source } from "@cargo-ops/protocol";
import { formatGameTime } from "@cargo-ops/economy";
import { PageHero } from "@/components/AppNav";
import { ConnectionNotice } from "@/components/status/ConnectionNotice";
import { EmptyState } from "@/components/EmptyState";
import { ghostButton } from "@/components/company/styles";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { DemoTag, Panel } from "@/components/dashboard/Panel";
import { FboBuyPanel, type FboFinancing } from "@/components/fbo/FboBuyPanel";
import { FboIncomeChart } from "@/components/fbo/FboIncomeChart";
import { ModuleCard } from "@/components/fbo/ModuleCard";
import { PricingPanel } from "@/components/fbo/PricingPanel";
import { SourceTag } from "@/components/status/SourceTag";
import { useAirportLookup } from "@/lib/economy/board";
import { useCompanyView } from "@/lib/economy/company";
import { formatInt, formatUsd } from "@/lib/format";
import { useCommand, useSimConnection } from "@/lib/transport/useSimConnection";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/fbo")({
  head: () => ({
    meta: [
      { title: "FBOs — Cargo Ops" },
      {
        name: "description",
        content:
          "Fixed-base operations you own: modules, pricing, traffic income, upkeep and the buy or build flow.",
      },
      { property: "og:title", content: "FBOs — Cargo Ops" },
      {
        property: "og:description",
        content:
          "Fixed-base operations you own: modules, pricing, traffic income, upkeep and the buy or build flow.",
      },
    ],
  }),
  component: Fbo,
});

function Fbo() {
  const { state } = useSimConnection();
  const command = useCommand();
  const lookup = useAirportLookup();
  const { company, fbos, loans, source, connector, demo } = useCompanyView(state, lookup);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async (name: string, args: unknown, success: string) => {
    setBusy(true);
    const r = await command(name, args);
    setBusy(false);
    setMessage(
      r.ok
        ? { ok: true, text: success }
        : { ok: false, text: `${r.error.message} (${r.error.code})` },
    );
    return r.ok;
  };
  const disabledNote = demo
    ? "Demo company: FBO actions need the local connector"
    : !connector
      ? "Not connected to the connector"
      : undefined;
  const list = useMemo(() => fbos?.fbos ?? [], [fbos]);
  const selected = list.find((f) => f.id === selectedId) ?? list[0] ?? null;
  const owned = useMemo(() => new Set(list.map((f) => f.icao)), [list]);
  const gameMs = company?.clock?.gameMs ?? null;
  const financingArgs = (f: FboFinancing | null) => (f ? { financing: f } : {});

  return (
    <>
      <PageHero
        eyebrow={company?.name ?? "FBOs"}
        title="FBOs"
        sub="Fuel, hangars, maintenance, cargo and ramp services at your airports. They earn from your own arrivals, the modelled traffic and, live, the sim's AI traffic."
      />
      <div className="grid-ops" data-testid="fbo-page">
        <ConnectionNotice state={state} />
        {demo ? (
          <div
            className="panel-inset col-span-12 flex flex-wrap items-center gap-3 px-5 py-4 text-sm text-muted-foreground"
            data-testid="demo-fbo-note"
          >
            <DemoTag />A seeded demo company computed in your browser with the same economy code the
            connector runs. Buying, building, upgrades and pricing are disabled: they need the local
            connector.
          </div>
        ) : null}

        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="FBOs"
          value={fbos ? list.length : null}
          size="lg"
          source={fbos ? source : null}
          hint={
            fbos
              ? `${list.filter((f) => f.status === "building").length} under construction`
              : "Start the local connector"
          }
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="Income this month"
          animate
          value={fbos?.monthIncome ?? null}
          format={formatUsd}
          size="lg"
          source={fbos ? source : null}
          hint="Modelled traffic + sim AI bonus"
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="Upkeep this month"
          animate
          value={fbos?.monthUpkeep ?? null}
          format={formatUsd}
          size="lg"
          source={fbos ? source : null}
          hint="Modules and land leases"
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="Book value"
          animate
          value={fbos?.value ?? null}
          format={formatUsd}
          size="lg"
          source={fbos ? source : null}
          hint="85 % of the money invested"
        />

        <div className="col-span-12 flex flex-col gap-3 md:gap-4 xl:col-span-4">
          <Panel
            eyebrow="Portfolio"
            title="Your FBOs"
            icon={Building2}
            action={<SourceTag source={fbos ? source : null} />}
            bodyClassName="p-3 md:p-4"
          >
            {list.length > 0 ? (
              <ul className="flex flex-col gap-2" data-testid="fbo-list">
                {list.map((f) => (
                  <li key={f.id}>
                    <FboListItem
                      fbo={f}
                      selected={selected?.id === f.id}
                      source={source}
                      onSelect={() => setSelectedId(f.id)}
                    />
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState
                icon={Building2}
                title="No FBO yet"
                description="Buy an existing FBO or build one below. Your own arrivals there refuel at cost and skip the landing fee."
              />
            )}
          </Panel>
          <Panel eyebrow="Acquire" title="Buy or build" icon={Store}>
            <FboBuyPanel
              lookup={lookup}
              owned={owned}
              loans={loans}
              enabled={connector}
              busy={busy}
              disabledNote={disabledNote}
              onBuy={(icao, f) =>
                void run("fbo.buy", { icao, ...financingArgs(f) }, `Bought the FBO at ${icao}`)
              }
              onBuild={(icao, f) =>
                void run(
                  "fbo.build",
                  { icao, ...financingArgs(f) },
                  `Construction started at ${icao}`,
                )
              }
            />
            <p
              role="status"
              aria-live="polite"
              className={cn(
                "mt-3 min-h-5 text-sm",
                message?.ok === false ? "text-destructive" : "text-success",
              )}
              data-testid="command-message"
            >
              {message?.text ?? ""}
            </p>
          </Panel>
        </div>

        <div
          className="col-span-12 flex flex-col gap-3 md:gap-4 xl:col-span-8"
          data-testid="fbo-detail"
        >
          {selected ? (
            <>
              <Panel
                eyebrow={`${selected.icao} · ${selected.origin === "built" ? "built" : "bought"}`}
                title={selected.name}
                icon={MapPinned}
                action={
                  <div className="flex items-center gap-2">
                    <SourceTag source={source} />
                    <button
                      type="button"
                      className={ghostButton}
                      disabled={!connector || busy || selected.status !== "active"}
                      title={disabledNote ?? "75 % of the money invested; an open loan is paid off"}
                      onClick={() =>
                        void run(
                          "fbo.sell",
                          { fboId: selected.id },
                          `Sold the FBO at ${selected.icao}`,
                        )
                      }
                    >
                      Sell
                    </button>
                  </div>
                }
              >
                <dl className="grid grid-cols-2 gap-4 font-mono text-xs md:grid-cols-5">
                  <Stat
                    label="Status"
                    value={selected.status === "active" ? "Operating" : "Building"}
                  />
                  <Stat label="Traffic" value={`${formatInt(selected.movementsPerDay)}/day`} />
                  <Stat
                    label="Today"
                    value={formatUsd(selected.today.modelled + selected.today.simAi)}
                    sub={`${selected.today.movements} movements`}
                  />
                  <Stat
                    label="Upkeep"
                    value={`${formatUsd(selected.upkeepMonthly)}/mo`}
                    {...(selected.landLeaseMonthly > 0
                      ? { sub: `incl. ${formatUsd(selected.landLeaseMonthly)} lease` }
                      : {})}
                  />
                  <Stat
                    label="Value"
                    value={formatUsd(selected.value)}
                    sub={
                      selected.financed ? `financed (${selected.loanId ?? "loan"})` : "unencumbered"
                    }
                  />
                </dl>
                <Occupancy fbo={selected} />
              </Panel>
              <Panel
                eyebrow="Last 30 in-game days"
                title="Daily income"
                icon={BarChart3}
                action={<SourceTag source={source} />}
              >
                {selected.daily.length > 0 ? (
                  <FboIncomeChart days={selected.daily} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    The first day closes at the next in-game midnight.
                  </p>
                )}
                <p className="mt-3 text-xs text-muted-foreground">
                  Modelled traffic is booked once a day ({formatUsd(selected.today.modelled)} so far
                  today); sim AI arrivals at once, labelled as a bonus; own-fleet savings are not
                  cash. {selected.aiArrivals} AI arrival{selected.aiArrivals === 1 ? "" : "s"}{" "}
                  credited.
                </p>
              </Panel>
              <Panel eyebrow="Modules" title="Services" icon={Gauge} bodyClassName="p-3 md:p-4">
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="fbo-modules">
                  {selected.modules.map((m) => (
                    <ModuleCard
                      key={m.kind}
                      module={m}
                      gameMs={gameMs}
                      enabled={connector && selected.status === "active"}
                      busy={busy}
                      disabledNote={
                        disabledNote ??
                        (selected.status !== "active" ? "Wait for the construction" : undefined)
                      }
                      onBuy={() =>
                        void run(
                          "fbo.module.buy",
                          { fboId: selected.id, module: m.kind },
                          `${m.label} ordered`,
                        )
                      }
                      onUpgrade={() =>
                        void run(
                          "fbo.module.upgrade",
                          { fboId: selected.id, module: m.kind },
                          `${m.label} upgrade ordered`,
                        )
                      }
                    />
                  ))}
                </div>
              </Panel>
              <div className="grid gap-3 md:gap-4 lg:grid-cols-2">
                <Panel eyebrow="Pricing" title="Fuel and handling" icon={SlidersHorizontal}>
                  <PricingPanel
                    fbo={selected}
                    enabled={connector}
                    busy={busy}
                    disabledNote={disabledNote}
                    onApply={(p) =>
                      void run("fbo.pricing", { fboId: selected.id, ...p }, "Prices updated")
                    }
                  />
                </Panel>
                <Panel eyebrow="Queue" title="Construction and upgrades" icon={CalendarClock}>
                  {selected.queue.length > 0 ? (
                    <ol className="flex flex-col gap-2" data-testid="fbo-queue">
                      {selected.queue.map((q) => (
                        <li
                          key={`${q.kind}-${q.module ?? ""}`}
                          className="panel-inset flex items-center justify-between gap-3 px-4 py-3 text-sm"
                        >
                          <span className="min-w-0 truncate text-foreground">{q.label}</span>
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            ETA {formatGameTime(q.readyAtGameMs)}
                          </span>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p className="text-sm text-muted-foreground">Nothing under way.</p>
                  )}
                </Panel>
              </div>
              <Panel eyebrow="Profit and loss" title="By in-game month" icon={ListOrdered}>
                <FboPnlTable fbo={selected} />
              </Panel>
            </>
          ) : (
            <Panel eyebrow="FBO" title="Nothing selected" icon={Building2}>
              <p className="text-sm text-muted-foreground">
                {fbos
                  ? "Buy or build your first FBO to manage it here."
                  : "FBOs appear once the connector (or the demo company) is loaded."}
              </p>
            </Panel>
          )}
        </div>
      </div>
    </>
  );
}

function FboListItem({
  fbo,
  selected,
  source,
  onSelect,
}: {
  fbo: FboState;
  selected: boolean;
  source: Source | null;
  onSelect: () => void;
}) {
  const month = fbo.pnl.at(-1);
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "panel-inset flex w-full flex-col gap-2 px-4 py-3 text-left transition-colors",
        selected ? "ring-1 ring-primary/60" : "hover:bg-secondary/50",
      )}
      data-testid="fbo-card"
    >
      <span className="flex items-center justify-between gap-2">
        <span className="font-mono text-base font-semibold tracking-[0.08em] text-foreground">
          {fbo.icao}
        </span>
        <span className="flex items-center gap-1.5">
          <SourceTag source={source} />
          <span
            className={cn(
              "rounded-sm px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold uppercase tracking-[0.14em]",
              fbo.status === "active" ? "bg-success/15 text-success" : "bg-warning/15 text-warning",
            )}
          >
            {fbo.status === "active" ? "Operating" : "Building"}
          </span>
        </span>
      </span>
      <span className="truncate text-xs text-muted-foreground">{fbo.name}</span>
      <span className="flex justify-between gap-2 font-mono text-[0.6875rem] text-muted-foreground font-tabular">
        <span>
          {fbo.modules.filter((m) => m.level > 0).length} modules · {formatInt(fbo.movementsPerDay)}{" "}
          mvts/day
        </span>
        <span className={cn((month?.net ?? 0) >= 0 ? "text-success" : "text-destructive")}>
          {formatUsd(month?.net ?? 0)} this month
        </span>
      </span>
    </button>
  );
}

function Stat({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate text-sm text-foreground font-tabular">{value}</dd>
      {sub ? <dd className="truncate text-muted-foreground">{sub}</dd> : null}
    </div>
  );
}

function Occupancy({ fbo }: { fbo: FboState }) {
  const o = fbo.occupancy;
  if (o.bays === 0) {
    return (
      <p className="mt-4 text-xs text-muted-foreground" data-testid="fbo-occupancy">
        No hangar: aircraft park outside (storms wear them).
      </p>
    );
  }
  return (
    <div className="mt-4 flex flex-col gap-1.5" data-testid="fbo-occupancy">
      <div className="flex justify-between font-mono text-xs text-muted-foreground">
        <span>Hangar occupancy</span>
        <span className="text-foreground font-tabular">
          {o.owned} own + {o.rented} rented / {o.bays} bays
        </span>
      </div>
      <div
        className="relative h-2 overflow-hidden rounded-full bg-secondary"
        role="progressbar"
        aria-label="Hangar occupancy"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(o.ratio * 100)}
      >
        <span
          className="absolute inset-y-0 left-0 bg-primary"
          style={{ width: `${(o.owned / o.bays) * 100}%` }}
        />
        <span
          className="absolute inset-y-0 bg-accent"
          style={{ left: `${(o.owned / o.bays) * 100}%`, width: `${(o.rented / o.bays) * 100}%` }}
        />
      </div>
    </div>
  );
}

function FboPnlTable({ fbo }: { fbo: FboState }) {
  if (fbo.pnl.length === 0) {
    return <p className="text-sm text-muted-foreground">No income or upkeep yet.</p>;
  }
  return (
    <table className="w-full text-sm" data-testid="fbo-pnl">
      <thead>
        <tr className="label-eyebrow text-left">
          <th className="py-1.5 font-normal">Month</th>
          <th className="py-1.5 text-right font-normal">Income</th>
          <th className="py-1.5 text-right font-normal">Upkeep</th>
          <th className="py-1.5 text-right font-normal">Net</th>
          <th className="py-1.5 text-right font-normal">Own-fleet savings</th>
        </tr>
      </thead>
      <tbody className="font-mono font-tabular">
        {[...fbo.pnl].reverse().map((m) => (
          <tr key={m.month} className="border-t border-border">
            <td className="py-1.5 text-muted-foreground">M{m.month + 1}</td>
            <td className="py-1.5 text-right text-success">{formatUsd(m.income)}</td>
            <td className="py-1.5 text-right text-destructive">{formatUsd(m.upkeep)}</td>
            <td
              className={cn(
                "py-1.5 text-right",
                m.net >= 0 ? "text-foreground" : "text-destructive",
              )}
            >
              {formatUsd(m.net)}
            </td>
            <td className="py-1.5 text-right text-muted-foreground">{formatUsd(m.savings)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
