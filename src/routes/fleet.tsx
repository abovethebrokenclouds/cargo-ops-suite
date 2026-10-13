import { createFileRoute } from "@tanstack/react-router";
import { MapPin, Plane } from "lucide-react";

import { PageHero } from "@/components/AppNav";
import { MetricTile } from "@/components/dashboard/MetricTile";
import { DemoTag } from "@/components/dashboard/Panel";
import { formatInt, formatUsd } from "@/lib/format";
import { fleet } from "@/lib/mock-data";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/fleet")({
  head: () => ({
    meta: [
      { title: "Fleet — Cargo Ops" },
      { name: "description", content: "Your cargo aircraft, bases, condition and status." },
      { property: "og:title", content: "Fleet — Cargo Ops" },
      { property: "og:description", content: "Your cargo aircraft, bases, condition and status." },
    ],
  }),
  component: Fleet,
});

const tone = {
  Ready: "text-success",
  "En route": "text-accent",
  Maintenance: "text-warning",
} as const;

function Fleet() {
  const ready = fleet.filter((a) => a.status === "Ready").length;
  return (
    <>
      <PageHero eyebrow="Hangar" title="Fleet" sub="Every airframe in your company." />

      <div className="grid-ops">
        <MetricTile
          className="col-span-12 md:col-span-6"
          label="Fleet value"
          value={null}
          format={formatUsd}
          size="xl"
          hint="Valuation arrives with the economy in P4."
        />
        <MetricTile
          className="col-span-6 md:col-span-3"
          label="Airframes"
          value={fleet.length}
          source="demo"
        />
        <MetricTile
          className="col-span-6 md:col-span-3"
          label="Ready"
          value={ready}
          source="demo"
        />

        {fleet.map((a) => (
          <article
            key={a.reg}
            className="panel-elevated col-span-12 flex flex-col gap-5 p-5 md:col-span-6 md:p-6 xl:col-span-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="metric-md">{a.reg}</p>
                <p className="mt-2 truncate text-sm text-foreground">{a.type}</p>
              </div>
              <DemoTag />
            </div>
            <div className="panel-inset grid h-20 place-items-center">
              <Plane className="size-10 text-primary/60" strokeWidth={1.25} aria-hidden="true" />
            </div>
            <dl className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <dt className="label-eyebrow">Base</dt>
                <dd className="mt-1 flex items-center gap-1.5 font-mono text-foreground">
                  <MapPin className="size-3.5 text-accent" aria-hidden="true" />
                  {a.base}
                </dd>
              </div>
              <div>
                <dt className="label-eyebrow">Status</dt>
                <dd className={cn("mt-1 flex items-center gap-2", tone[a.status])}>
                  <span className="status-dot" aria-hidden="true" />
                  {a.status}
                </dd>
              </div>
              <div className="col-span-2">
                <dt className="label-eyebrow">Max payload</dt>
                <dd className="mt-1 font-mono text-foreground font-tabular">
                  {formatInt(a.payloadKg)} kg
                </dd>
              </div>
            </dl>
          </article>
        ))}
      </div>
    </>
  );
}
