import { createFileRoute } from "@tanstack/react-router";
import { BookOpen, Download } from "lucide-react";

import { PageHero } from "@/components/AppNav";
import { EmptyState } from "@/components/EmptyState";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { Panel } from "@/components/dashboard/Panel";

export const Route = createFileRoute("/logbook")({
  head: () => ({
    meta: [
      { title: "Logbook — Cargo Ops" },
      {
        name: "description",
        content:
          "Every flight with landing grade, distance and payload, exportable to CSV, GPX and JSON.",
      },
      { property: "og:title", content: "Logbook — Cargo Ops" },
      {
        property: "og:description",
        content:
          "Every flight with landing grade, distance and payload, exportable to CSV, GPX and JSON.",
      },
    ],
  }),
  component: Logbook,
});

const columns = ["Date", "Route", "Aircraft", "Block", "Distance", "Payload", "Landing"];

function Logbook() {
  return (
    <>
      <PageHero
        eyebrow="Logbook"
        title="Every leg, on record."
        sub="Verified flights with landing grades, distance flown and payload delivered."
      />
      <div className="grid-ops">
        <MetricTile
          className="col-span-12 md:col-span-6"
          label="Total hours"
          value={null}
          unit="h"
          size="xl"
        />
        <MetricTile className="col-span-6 md:col-span-3" label="Flights" value={null} />
        <MetricTile className="col-span-6 md:col-span-3" label="Distance" value={null} unit="nm" />
        <Panel
          className="col-span-12"
          eyebrow="History"
          title="Flights"
          icon={BookOpen}
          action={
            <button
              type="button"
              disabled
              title="Exports arrive in P3"
              className="inline-flex items-center gap-2 rounded-lg border border-border bg-secondary px-3 py-1.5 text-xs font-medium text-muted-foreground disabled:cursor-not-allowed"
            >
              <Download className="size-3.5" aria-hidden="true" /> Export
            </button>
          }
          bodyClassName="p-0 md:p-0"
        >
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-border">
                  {columns.map((c) => (
                    <th
                      key={c}
                      scope="col"
                      className="label-eyebrow px-5 py-3 font-semibold md:px-6"
                    >
                      {c}
                    </th>
                  ))}
                </tr>
              </thead>
            </table>
          </div>
          <div className="p-5 md:p-6">
            <EmptyState
              icon={BookOpen}
              title="No flights logged yet"
              description="Flights are recorded automatically from the simulator once tracking lands in P2."
            />
          </div>
        </Panel>
      </div>
    </>
  );
}
