import { createFileRoute } from "@tanstack/react-router";
import { Activity, Terminal } from "lucide-react";

import { PageHero } from "@/components/AppNav";
import { EmptyState } from "@/components/EmptyState";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { Panel } from "@/components/dashboard/Panel";
import { SimStatusChip } from "@/components/status/SimStatusChip";

export const Route = createFileRoute("/diagnostics")({
  head: () => ({
    meta: [
      { title: "Diagnostics — Cargo Ops" },
      {
        name: "description",
        content: "Connector health, raw telemetry, event log and protocol version.",
      },
      { property: "og:title", content: "Diagnostics — Cargo Ops" },
      {
        property: "og:description",
        content: "Connector health, raw telemetry, event log and protocol version.",
      },
    ],
  }),
  component: Diagnostics,
});

function Diagnostics() {
  return (
    <>
      <PageHero
        eyebrow="Diagnostics"
        title="Under the hood."
        sub="Round-trip time, update rate, raw telemetry and the connector event log."
      >
        <SimStatusChip status="demo" detail="No connector configured" />
      </PageHero>
      <div className="grid-ops">
        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="Round trip"
          value={null}
          unit="ms"
        />
        <MetricTile
          className="col-span-6 lg:col-span-3"
          label="Update rate"
          value={null}
          unit="Hz"
        />
        <MetricTile className="col-span-6 lg:col-span-3" label="Frames" value={null} />
        <MetricTile className="col-span-6 lg:col-span-3" label="Protocol" value={null} unit="ver" />
        <Panel
          className="col-span-12 lg:col-span-7"
          eyebrow="Stream"
          title="Raw telemetry"
          icon={Terminal}
        >
          <pre className="panel-inset min-h-48 overflow-x-auto p-4 font-mono text-xs leading-relaxed text-muted-foreground">
            {"// awaiting connector frames\n// nothing is synthesised here"}
          </pre>
        </Panel>
        <Panel
          className="col-span-12 lg:col-span-5"
          eyebrow="Events"
          title="Connection log"
          icon={Activity}
        >
          <EmptyState
            icon={Activity}
            title="No events"
            description="Handshakes, reconnects and simulator events are listed here from P1."
          />
        </Panel>
      </div>
    </>
  );
}
