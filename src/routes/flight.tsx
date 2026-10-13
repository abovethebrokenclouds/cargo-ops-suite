import { createFileRoute } from "@tanstack/react-router";
import { CloudSun, Gauge, Plane, PlaneLanding, Route as RouteIcon } from "lucide-react";

import { PageHero } from "@/components/AppNav";
import { EmptyState } from "@/components/EmptyState";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { Panel } from "@/components/dashboard/Panel";
import { FlightProgressBar } from "@/components/flight/FlightProgressBar";
import { PhaseTimeline } from "@/components/flight/PhaseTimeline";
import { EMPTY, formatDegrees, formatFpm, formatMinutes } from "@/lib/format";

export const Route = createFileRoute("/flight")({
  head: () => ({
    meta: [
      { title: "Live Flight — Cargo Ops" },
      {
        name: "description",
        content: "Live altitude, speeds, heading, vertical speed, fuel and progress from MSFS.",
      },
      { property: "og:title", content: "Live Flight — Cargo Ops" },
      {
        property: "og:description",
        content: "Live altitude, speeds, heading, vertical speed, fuel and progress from MSFS.",
      },
    ],
  }),
  component: Flight,
});

// Values stay null until the connector (P1) streams real telemetry — never fabricated.
function Flight() {
  return (
    <>
      <PageHero
        eyebrow="Live flight"
        title="In the air."
        sub="Altitude, speeds, fuel and progress straight from the simulator. Waiting for a connection."
      />

      <div className="grid-ops">
        <section
          className="panel-elevated col-span-12 flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4 md:px-6"
          aria-label="Aircraft and mission"
        >
          <div className="flex min-w-0 items-center gap-3">
            <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-primary/25 bg-primary/10 text-accent">
              <Plane className="size-5" aria-hidden="true" />
            </span>
            <div className="min-w-0">
              <p className="label-eyebrow">Aircraft</p>
              <p className="truncate font-display text-lg font-semibold text-muted-foreground">
                No aircraft loaded
              </p>
            </div>
          </div>
          <div>
            <p className="label-eyebrow">Tail</p>
            <p className="font-mono text-sm text-muted-foreground">{EMPTY}</p>
          </div>
          <div>
            <p className="label-eyebrow">Mission</p>
            <p className="font-mono text-sm text-muted-foreground">None active</p>
          </div>
          <div>
            <p className="label-eyebrow">Phase</p>
            <p className="font-mono text-sm text-muted-foreground">{EMPTY}</p>
          </div>
        </section>

        <MetricTile
          className="col-span-12 md:col-span-6"
          label="Altitude"
          value={null}
          unit="ft"
          size="xl"
          hint="Indicated altitude · AGL shown when below 2,500 ft"
        />
        <MetricTile
          className="col-span-12 md:col-span-6"
          label="Airspeed"
          value={null}
          unit="kt IAS"
          size="xl"
          hint="Indicated airspeed · TAS alongside in cruise"
        />

        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="Ground speed"
          value={null}
          unit="kt"
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="Heading"
          value={null}
          format={(n) => formatDegrees(n).replace("°", "")}
          unit="° mag"
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="Vertical speed"
          value={null}
          format={(n) => formatFpm(n).replace(" fpm", "")}
          unit="fpm"
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="Fuel on board"
          value={null}
          unit="lb"
          hint={`Endurance ${formatMinutes(null)}`}
        />

        <Panel className="col-span-12" eyebrow="Route" title="Progress" icon={RouteIcon}>
          <FlightProgressBar origin={null} destination={null} progress={null} />
        </Panel>

        <Panel className="col-span-12" eyebrow="Flight phase" title="Phase timeline" icon={Gauge}>
          <PhaseTimeline current={null} />
        </Panel>

        <Panel
          className="col-span-12 lg:col-span-6"
          eyebrow="Destination"
          title="Weather"
          icon={CloudSun}
        >
          <EmptyState
            icon={CloudSun}
            title="No destination set"
            description="METAR for the destination appears here once a mission is active."
          />
        </Panel>
        <Panel
          className="col-span-12 lg:col-span-6"
          eyebrow="After touchdown"
          title="Landing"
          icon={PlaneLanding}
        >
          <EmptyState
            icon={PlaneLanding}
            title="Awaiting touchdown"
            description="Rate, G, ground speed and grade are recorded the moment the wheels touch."
          />
        </Panel>
      </div>
    </>
  );
}
