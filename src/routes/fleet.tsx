import { createFileRoute } from "@tanstack/react-router";
import { Plane, Store } from "lucide-react";
import { useState } from "react";

import type { FleetAircraft } from "@cargo-ops/protocol";
import { PageHero } from "@/components/AppNav";
import { EmptyState } from "@/components/EmptyState";
import { ghostButton } from "@/components/company/styles";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { DemoTag, Panel } from "@/components/dashboard/Panel";
import { AircraftMarket } from "@/components/fleet/AircraftMarket";
import { FleetCard } from "@/components/fleet/FleetCard";
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
        content: "Owned and leased aircraft, condition, location, repairs and the aircraft market.",
      },
      { property: "og:title", content: "Fleet — Cargo Ops" },
      {
        property: "og:description",
        content: "Owned and leased aircraft, condition, location, repairs and the aircraft market.",
      },
    ],
  }),
  component: Fleet,
});

function Fleet() {
  const { state } = useSimConnection();
  const command = useCommand();
  const lookup = useAirportLookup();
  const { company, fleet, loans, source, connector, demo } = useCompanyView(state, lookup);
  const [busy, setBusy] = useState(false);
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
        sub="Every airframe in your company, and the market for the next one."
      />

      <div className="grid-ops">
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
          className="col-span-12 md:col-span-6"
          label="Fleet value"
          value={fleet?.value ?? null}
          format={formatUsd}
          size="lg"
          source={fleet ? source : null}
          hint="Owned aircraft at market value (price × hours × condition)."
        />
        <MetricTile
          className="col-span-6 md:col-span-3"
          label="Airframes"
          value={fleet ? aircraft.length : null}
          source={fleet ? source : null}
        />
        <MetricTile
          className="col-span-6 md:col-span-3"
          label="Ready"
          value={fleet ? ready : null}
          source={fleet ? source : null}
          hint="Available and ≥ 20 % condition"
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

        <Panel
          className="col-span-12"
          eyebrow="Market"
          title="New aircraft"
          icon={Store}
          action={<SourceTag source={source} />}
        >
          <p className="mb-4 text-sm text-muted-foreground">
            Catalogue prices and lease rates are approximate, for gameplay. Reputation tier gates
            which classes you may buy (leasing is allowed one tier lower).
            {company ? ` Your tier: ${company.reputationTier} · ${company.tierName ?? ""}.` : ""}
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
      </div>
    </>
  );
}
