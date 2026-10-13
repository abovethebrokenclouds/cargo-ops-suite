import { createFileRoute } from "@tanstack/react-router";
import { Database, Gauge, Map as MapIcon, Plug } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { PageHero } from "@/components/AppNav";
import { Panel } from "@/components/dashboard/Panel";
import { Switch } from "@/components/ui/switch";
import { useOnlineMapsSetting } from "@/lib/settings/map-settings";

export const Route = createFileRoute("/settings")({
  head: () => ({
    meta: [
      { title: "Settings — Cargo Ops" },
      {
        name: "description",
        content: "Units, connector, basemap, backups and demo mode.",
      },
      { property: "og:title", content: "Settings — Cargo Ops" },
      { property: "og:description", content: "Units, connector, basemap, backups and demo mode." },
    ],
  }),
  component: SettingsPage,
});

type Row = { label: string; value: string; note?: string; control?: "online-maps" };
type Group = { title: string; eyebrow: string; icon: LucideIcon; rows: Row[] };

const groups: Group[] = [
  {
    title: "Units",
    eyebrow: "Display",
    icon: Gauge,
    rows: [
      { label: "Altitude", value: "ft" },
      { label: "Speed", value: "kt" },
      { label: "Weight", value: "kg" },
      { label: "Fuel", value: "lb" },
    ],
  },
  {
    title: "Connector",
    eyebrow: "Simulator link",
    icon: Plug,
    rows: [
      { label: "Address", value: "127.0.0.1:4311", note: "P1" },
      { label: "Pairing token", value: "Not paired", note: "P1" },
      { label: "Demo mode", value: "On" },
    ],
  },
  {
    title: "Basemap",
    eyebrow: "Map",
    icon: MapIcon,
    rows: [
      { label: "Order", value: "Local → Online → Outline" },
      { label: "Local", value: "PMTiles via connector" },
      { label: "Online maps (OpenFreeMap)", value: "", control: "online-maps" },
      { label: "Offline floor", value: "Natural Earth outline" },
    ],
  },
  {
    title: "Data",
    eyebrow: "Backups",
    icon: Database,
    rows: [
      { label: "Daily backup", value: "Not configured", note: "P6" },
      { label: "Export / import", value: "Not available", note: "P6" },
    ],
  },
];

function SettingsPage() {
  return (
    <>
      <PageHero
        eyebrow="Settings"
        title="Configure."
        sub="Mostly read-only for now. Each setting becomes editable in the phase noted beside it."
      />
      <div className="grid-ops">
        {groups.map((g) => (
          <Panel
            key={g.title}
            className="col-span-12 md:col-span-6"
            eyebrow={g.eyebrow}
            title={g.title}
            icon={g.icon}
          >
            <dl className="flex flex-col divide-y divide-border">
              {g.rows.map((r) => (
                <div key={r.label} className="flex items-center justify-between gap-4 py-3">
                  <dt className="text-sm text-muted-foreground">{r.label}</dt>
                  <dd className="flex items-center gap-2 font-mono text-sm text-foreground">
                    {r.control === "online-maps" ? <OnlineMapsSwitch /> : r.value}
                    {r.note ? (
                      <span className="rounded-sm bg-secondary px-1.5 py-0.5 text-[0.625rem] tracking-[0.12em] text-muted-foreground">
                        {r.note}
                      </span>
                    ) : null}
                  </dd>
                </div>
              ))}
            </dl>
          </Panel>
        ))}
      </div>
    </>
  );
}

/** Per-browser toggle; off keeps the map fully offline (local PMTiles or the outline). */
function OnlineMapsSwitch() {
  const [enabled, setEnabled] = useOnlineMapsSetting();
  return (
    <span className="flex items-center gap-2">
      <span className="text-xs text-muted-foreground">
        {enabled === null ? "…" : enabled ? "On" : "Off"}
      </span>
      <Switch
        checked={enabled ?? false}
        disabled={enabled === null}
        onCheckedChange={setEnabled}
        aria-label="Allow online maps (OpenFreeMap)"
        data-testid="online-maps-switch"
      />
    </span>
  );
}
