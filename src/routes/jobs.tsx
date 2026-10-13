import { createFileRoute } from "@tanstack/react-router";
import { PageHero } from "@/components/AppNav";
import { jobs } from "@/lib/mock-data";

export const Route = createFileRoute("/jobs")({
  head: () => ({
    meta: [
      { title: "Cargo Jobs — Cargo Ops" },
      {
        name: "description",
        content: "Browse and accept cargo contracts for your MSFS 2024 fleet.",
      },
      { property: "og:title", content: "Cargo Jobs — Cargo Ops" },
      {
        property: "og:description",
        content: "Browse and accept cargo contracts for your MSFS 2024 fleet.",
      },
    ],
  }),
  component: Jobs,
});

function Jobs() {
  return (
    <>
      <PageHero eyebrow="Job board" title="Cargo Jobs" sub="Contracts available from your bases." />
      <div className="grid gap-4">
        {jobs.map((j) => (
          <div key={j.id} className="panel flex flex-wrap items-center justify-between gap-4 p-6">
            <div>
              <p className="text-xs text-muted-foreground">
                {j.id} · due in {j.deadline}
              </p>
              <p className="mt-1 font-display text-3xl font-bold">
                {j.from} <span className="text-gradient">→</span> {j.to}
              </p>
              <p className="text-muted-foreground">
                {j.cargo} · {j.weightKg.toLocaleString()} kg
              </p>
            </div>
            <div className="text-right">
              <p className="font-display text-3xl font-bold text-gradient">
                ${j.payout.toLocaleString()}
              </p>
              <button className="mt-2 rounded-lg bg-secondary px-4 py-2 text-sm hover:bg-muted">
                Accept
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
