import { createFileRoute } from "@tanstack/react-router";

import { PageHero } from "@/components/AppNav";
import {
  BasemapPanel,
  ConnectorPanel,
  DataPanel,
  DemoPanel,
  SimbriefPanel,
  UnitsPanel,
  type SettingsContext,
} from "@/components/settings/SettingsPanels";
import { useSimConnection } from "@/lib/transport/useSimConnection";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Cargo Ops" },
      {
        name: "description",
        content: "Units, connector, basemap, backups, career export and SimBrief import.",
      },
      { property: "og:title", content: "Settings — Cargo Ops" },
      {
        property: "og:description",
        content: "Units, connector, basemap, backups, career export and SimBrief import.",
      },
    ],
  }),
  component: SettingsPage,
});

function SettingsPage() {
  const { state, transportKind } = useSimConnection();
  const ctx: SettingsContext = {
    state,
    served: transportKind === "live",
    connected: state.connection === "live" || state.connection === "replay",
  };
  return (
    <>
      <PageHero
        eyebrow="Settings"
        title="Configure."
        sub="Display units for this browser, the connector link, the basemap, backups and your career data."
      />
      <div className="grid-ops">
        <UnitsPanel />
        <ConnectorPanel ctx={ctx} />
        <BasemapPanel ctx={ctx} />
        <DemoPanel ctx={ctx} />
        <DataPanel ctx={ctx} />
        <SimbriefPanel ctx={ctx} />
      </div>
    </>
  );
}
