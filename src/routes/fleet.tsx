import { createFileRoute } from "@tanstack/react-router";
import { PageHero } from "@/components/AppNav";
import { fleet } from "@/lib/mock-data";

export const Route = createFileRoute("/fleet")({
  head: () => ({
    meta: [
      { title: "Fleet — Cargo Ops" },
      { name: "description", content: "Your cargo aircraft, bases and status." },
      { property: "og:title", content: "Fleet — Cargo Ops" },
      { property: "og:description", content: "Your cargo aircraft, bases and status." },
    ],
  }),
  component: Fleet,
});

const tone = {
  Ready: "text-success",
  "En route": "text-accent",
  Maintenance: "text-destructive",
} as const;

function Fleet() {
  return (
    <>
      <PageHero eyebrow="Hangar" title="Fleet" sub="Every airframe in your company." />
      <div className="grid gap-4 md:grid-cols-3">
        {fleet.map((a) => (
          <div key={a.reg} className="panel p-6">
            <p className="font-display text-3xl font-bold text-gradient">{a.reg}</p>
            <p className="mt-1">{a.type}</p>
            <div className="mt-4 flex justify-between text-sm text-muted-foreground">
              <span>Base {a.base}</span>
              <span className={tone[a.status]}>{a.status}</span>
            </div>
            <p className="mt-2 text-sm text-muted-foreground">
              Max payload {a.payloadKg.toLocaleString()} kg
            </p>
          </div>
        ))}
      </div>
    </>
  );
}
