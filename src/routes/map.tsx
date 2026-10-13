import { createFileRoute } from "@tanstack/react-router";
import { Map as MapIcon } from "lucide-react";

import { PageHero } from "@/components/AppNav";
import { EmptyState } from "@/components/EmptyState";
import { MetricTile } from "@/components/dashboard/MetricTile";

export const Route = createFileRoute("/map")({
  head: () => ({
    meta: [
      { title: "Ops Map — Cargo Ops" },
      {
        name: "description",
        content: "Aircraft position, route, trail and nearby airports on a self-hosted map.",
      },
      { property: "og:title", content: "Ops Map — Cargo Ops" },
      {
        property: "og:description",
        content: "Aircraft position, route, trail and nearby airports on a self-hosted map.",
      },
    ],
  }),
  component: OpsMap,
});

function OpsMap() {
  return (
    <>
      <PageHero
        eyebrow="Ops map"
        title="Situational awareness."
        sub="Aircraft, route, breadcrumb trail and nearby airports with weather badges."
      />
      <div className="grid-ops">
        <section
          aria-label="Map"
          className="panel-elevated relative col-span-12 grid min-h-[22rem] place-items-center overflow-hidden p-6 md:min-h-[32rem] lg:col-span-9"
        >
          <div aria-hidden="true" className="bg-radar absolute inset-0 overflow-hidden" />
          <EmptyState
            className="relative z-10 max-w-md bg-background/70 backdrop-blur-md"
            icon={MapIcon}
            eyebrow="Phase P2"
            title="The map arrives in P2"
            description="A self-hosted vector basemap with the live aircraft marker, great-circle route and follow mode. No map tiles are requested until then."
          />
        </section>
        <div className="col-span-12 grid gap-3 sm:grid-cols-2 md:gap-4 lg:col-span-3 lg:grid-cols-1">
          <MetricTile label="Distance remaining" value={null} unit="nm" />
          <MetricTile label="Nearby airports" value={null} size="md" />
        </div>
      </div>
    </>
  );
}
