import { createFileRoute } from "@tanstack/react-router";

import { PageHero } from "@/components/AppNav";
import { DiagnosticsView } from "@/components/diagnostics/DiagnosticsView";
import { ConnectedStatusChip } from "@/components/status/ConnectedStatusChip";

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
        sub="Connection state, update rate, the event stream and the raw state the connector sends."
      >
        <ConnectedStatusChip />
      </PageHero>
      <DiagnosticsView />
    </>
  );
}
