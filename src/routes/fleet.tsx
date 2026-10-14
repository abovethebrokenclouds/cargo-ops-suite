import { createFileRoute } from "@tanstack/react-router";
import { ClipboardList, Plane, Store, UserRound, Warehouse, Wrench } from "lucide-react";
import { useState } from "react";

import type { FleetAircraft } from "@cargo-ops/protocol";
import { PageHero } from "@/components/AppNav";
import { ConnectionNotice } from "@/components/status/ConnectionNotice";
import { EmptyState } from "@/components/EmptyState";
import { ghostButton } from "@/components/company/styles";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { DemoTag, Panel } from "@/components/dashboard/Panel";
import { AircraftMarket } from "@/components/fleet/AircraftMarket";
import { SystemsPanel } from "@/components/fleet/Airworthiness";
import { FleetCard } from "@/components/fleet/FleetCard";
import { HiredPilots } from "@/components/fleet/HiredPilots";
import { MaintenanceBoard } from "@/components/fleet/MaintenanceBoard";
import { UsedMarket } from "@/components/fleet/UsedMarket";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SourceTag } from "@/components/status/SourceTag";
import { useAirportLookup } from "@/lib/economy/board";
import { useCompanyView } from "@/lib/economy/company";
import { formatUsd } from "@/lib/format";
import { useCommand, useSimConnection } from "@/lib/transport/useSimConnection";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/fleet")({
  head: () => ({
    meta: [
      { title: "Fleet — Cargo Ops" },
      {
        name: "description",
        content:
          "Owned and leased aircraft, systems and airworthiness, maintenance, and the new and used aircraft markets.",
      },
      { property: "og:title", content: "Fleet — Cargo Ops" },
      {
        property: "og:description",
        content:
          "Owned and leased aircraft, systems and airworthiness, maintenance, and the new and used aircraft markets.",
      },
    ],
  }),
  component: Fleet,
});

function Fleet() {
  const { state } = useSimConnection();
  const command = useCommand();
  const lookup = useAirportLookup();
  const { company, fleet, loans, market, pilots, source, connector, demo } = useCompanyView(
    state,
    lookup,
  );
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState("hangar");
  const [detailId, setDetailId] = useState<string | null>(null);
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
    ? "Demo fleet: buying, leasing and repairs need the local connector"
    : !connector
      ? "Not connected to the connector"
      : undefined;
  const aircraft = fleet?.aircraft ?? [];
  const ready = aircraft.filter((a) => a.status === "available" && a.airworthy).length;
  const inShop = aircraft.filter((a) => a.status === "maintenance").length;
  const detail = aircraft.find((a) => a.id === detailId) ?? aircraft[0] ?? null;

  const actions = (a: FleetAircraft) => (
    <>
      <button
        type="button"
        className={ghostButton}
        disabled={!connector || busy || fleet?.selectedId === a.id}
        title={disabledNote}
        onClick={() =>
          void run("fleet.select", { aircraftId: a.id }, `${a.registration} is the active aircraft`)
        }
        data-testid="select-aircraft"
      >
        Fly this one
      </button>
      <button
        type="button"
        className={ghostButton}
        aria-pressed={detail?.id === a.id}
        onClick={() => setDetailId(a.id)}
        data-testid="show-systems"
      >
        Systems
      </button>
      <button
        type="button"
        className={ghostButton}
        disabled={!connector || busy || a.repairCost <= 0 || a.status !== "available"}
        title={
          disabledNote ?? `${formatUsd(a.repairCost)}, ${a.repairHours.toFixed(1)} in-game hours`
        }
        onClick={() =>
          void run("fleet.repair", { aircraftId: a.id }, `${a.registration} is in maintenance`)
        }
        data-testid="repair-aircraft"
      >
        Repair {a.repairCost > 0 ? formatUsd(a.repairCost) : ""}
      </button>
      {a.ownership === "owned" && a.insurance ? (
        <button
          type="button"
          className={ghostButton}
          disabled={!connector || busy}
          title={
            disabledNote ??
            (a.insurance.insured
              ? `Covers ${Math.round(a.insurance.coverageShare * 100)} % of a write-off and of incident repairs above ${formatUsd(a.insurance.deductible)}; risk × ${a.insurance.riskFactor}`
              : `Hull policy: ${formatUsd(a.insurance.premiumMonthly)} a month (risk × ${a.insurance.riskFactor})`)
          }
          onClick={() =>
            void run(
              a.insurance?.insured ? "insurance.cancel" : "insurance.buy",
              { aircraftId: a.id },
              a.insurance?.insured
                ? `${a.registration} insurance cancelled`
                : `${a.registration} insured`,
            )
          }
          data-testid="insurance-toggle"
        >
          {a.insurance.insured
            ? `Insured · ${formatUsd(a.insurance.premiumMonthly)}/mo`
            : `Insure ${formatUsd(a.insurance.premiumMonthly)}/mo`}
        </button>
      ) : null}
      {a.ownership === "owned" ? (
        <button
          type="button"
          className={cn(ghostButton, "ml-auto")}
          disabled={!connector || busy || a.status !== "available"}
          title={disabledNote ?? "Dealer pays 90 % of the value; an open loan is paid off first"}
          onClick={() => void run("fleet.sell", { aircraftId: a.id }, `${a.registration} sold`)}
        >
          Sell
        </button>
      ) : (
        <button
          type="button"
          className={cn(ghostButton, "ml-auto")}
          disabled={!connector || busy || a.status !== "available"}
          title={disabledNote ?? "Wear is charged on return"}
          onClick={() =>
            void run("fleet.return", { aircraftId: a.id }, `${a.registration} returned`)
          }
        >
          Return lease
        </button>
      )}
    </>
  );

  return (
    <>
      <PageHero
        eyebrow="Hangar"
        title="Fleet"
        sub="Every airframe in your company, its systems and paperwork, and the market for the next one."
      />

      <div className="grid-ops">
        <ConnectionNotice state={state} />
        {demo ? (
          <div
            className="panel-inset col-span-12 flex flex-wrap items-center gap-3 px-5 py-4 text-sm text-muted-foreground"
            data-testid="demo-fleet-note"
          >
            <DemoTag />A seeded demo fleet computed in your browser with the shared economy code.
            Buying, leasing, repairs and selection are disabled: they need the local connector.
          </div>
        ) : null}

        <MetricTile
          className="col-span-12 md:col-span-4"
          label="Fleet value"
          animate
          value={fleet?.value ?? null}
          format={formatUsd}
          size="lg"
          source={fleet ? source : null}
          hint="Owned aircraft at market value (price × hours × condition)."
        />
        <MetricTile
          className="col-span-4 md:col-span-2"
          label="Airframes"
          value={fleet ? aircraft.length : null}
          source={fleet ? source : null}
        />
        <MetricTile
          className="col-span-4 md:col-span-3"
          label="Ready"
          value={fleet ? ready : null}
          source={fleet ? source : null}
          hint="Available and airworthy: no grounding defect, minors deferred, every system ≥ 20 %, annual current"
        />
        <MetricTile
          className="col-span-4 md:col-span-3"
          label="In the shop"
          value={fleet ? inShop : null}
          source={fleet ? source : null}
          hint="Aircraft with maintenance orders running or queued"
        />

        <p
          role="status"
          aria-live="polite"
          className={cn(
            "col-span-12 min-h-5 text-sm",
            message?.ok === false ? "text-destructive" : "text-success",
          )}
          data-testid="command-message"
        >
          {message?.text ?? ""}
          {fleet?.ambiguous ? (
            <span className="text-warning">
              Several aircraft match the simulator aircraft: choose one with “Fly this one”.
            </span>
          ) : null}
        </p>

        <Tabs value={tab} onValueChange={setTab} className="col-span-12">
          <TabsList className="h-auto flex-wrap gap-1 bg-secondary p-1">
            <TabsTrigger value="hangar" className="gap-1.5" data-testid="tab-hangar">
              <Warehouse className="size-4" aria-hidden="true" /> Hangar
            </TabsTrigger>
            <TabsTrigger value="used" className="gap-1.5" data-testid="tab-used-market">
              <ClipboardList className="size-4" aria-hidden="true" /> Used market
              {market ? (
                <span className="font-mono text-[0.6875rem] text-muted-foreground">
                  {market.listings.length}
                </span>
              ) : null}
            </TabsTrigger>
            <TabsTrigger value="new" className="gap-1.5" data-testid="tab-new-aircraft">
              <Store className="size-4" aria-hidden="true" /> New aircraft
            </TabsTrigger>
            <TabsTrigger value="pilots" className="gap-1.5" data-testid="tab-hired-pilots">
              <UserRound className="size-4" aria-hidden="true" /> Hired pilots
              {pilots ? (
                <span className="font-mono text-[0.6875rem] text-muted-foreground">
                  {pilots.pilots.length}
                </span>
              ) : null}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="hangar" className="mt-5">
            <div className="grid-ops">
              {fleet === null ? (
                <div className="col-span-12">
                  <EmptyState
                    icon={Plane}
                    title={demo ? "Building the demo fleet…" : "No fleet data"}
                    description={
                      demo
                        ? "Loading the bundled airport list for the seeded demo company."
                        : "Start the local connector to manage your fleet."
                    }
                  />
                </div>
              ) : (
                aircraft.map((a) => (
                  <div key={a.id} className="col-span-12 md:col-span-6 xl:col-span-4">
                    <FleetCard
                      aircraft={a}
                      source={source}
                      selected={fleet.selectedId === a.id}
                      focused={detail?.id === a.id && aircraft.length > 1}
                      actions={actions(a)}
                    />
                  </div>
                ))
              )}
              {demo ? (
                <p
                  className="col-span-12 text-xs text-muted-foreground"
                  data-testid="fleet-disabled-note"
                >
                  Fleet actions are disabled in demo mode: they need the connector.
                </p>
              ) : null}

              {detail && detail.systems ? (
                <Panel
                  className="col-span-12"
                  eyebrow="Airworthiness"
                  title={`Systems · ${detail.registration}`}
                  icon={Plane}
                  action={<SourceTag source={source} />}
                >
                  <SystemsPanel
                    aircraft={detail}
                    enabled={connector}
                    disabledNote={disabledNote}
                    busy={busy}
                    run={run}
                  />
                </Panel>
              ) : null}

              <Panel
                className="col-span-12"
                eyebrow="Maintenance"
                title="Maintenance board"
                icon={Wrench}
                action={<SourceTag source={fleet ? source : null} />}
              >
                <MaintenanceBoard
                  orders={fleet?.maintenance ?? []}
                  gameMs={company?.clock?.gameMs ?? null}
                />
              </Panel>
            </div>
          </TabsContent>

          <TabsContent value="used" className="mt-5">
            <Panel
              eyebrow="Market"
              title="Used aircraft"
              icon={ClipboardList}
              action={<SourceTag source={source} />}
            >
              {demo ? (
                <p
                  className="mb-4 text-sm text-muted-foreground"
                  data-testid="market-disabled-note"
                >
                  Seeded demo listings computed in your browser; inspecting and buying need the
                  connector.
                </p>
              ) : null}
              <UsedMarket
                market={market}
                company={company}
                loans={loans}
                source={source}
                enabled={connector}
                disabledNote={disabledNote}
                busy={busy}
                run={run}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="new" className="mt-5">
            <Panel
              eyebrow="Market"
              title="New aircraft"
              icon={Store}
              action={<SourceTag source={source} />}
            >
              <p className="mb-4 text-sm text-muted-foreground">
                Catalogue prices and lease rates are approximate, for gameplay. Reputation tier
                gates which classes you may buy (leasing is allowed one tier lower).
                {company
                  ? ` Your tier: ${company.reputationTier} · ${company.tierName ?? ""}.`
                  : ""}
              </p>
              <AircraftMarket
                company={company}
                loans={loans}
                source={source}
                enabled={connector}
                disabledNote={disabledNote}
                busy={busy}
                run={run}
              />
            </Panel>
          </TabsContent>

          <TabsContent value="pilots" className="mt-5">
            <Panel
              eyebrow="Simulated operations"
              title="Hired pilots"
              icon={UserRound}
              action={<SourceTag source={pilots ? source : null} />}
            >
              {demo ? (
                <p
                  className="mb-4 text-sm text-muted-foreground"
                  data-testid="pilots-disabled-note"
                >
                  <DemoTag className="mr-2" />A seeded demo pilot computed in your browser; hiring,
                  routes and letting go need the connector.
                </p>
              ) : null}
              <HiredPilots
                pilots={pilots}
                source={source}
                enabled={connector}
                disabledNote={disabledNote}
                busy={busy}
                run={run}
              />
            </Panel>
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
