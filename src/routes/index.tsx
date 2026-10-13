import { createFileRoute, Link } from "@tanstack/react-router";
import { PageHero } from "@/components/AppNav";
import { company, fleet, jobs } from "@/lib/mock-data";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "Cargo Ops — Dashboard" },
      { name: "description", content: "Run your MSFS 2024 cargo airline: fleet, jobs and operations." },
      { property: "og:title", content: "Cargo Ops — Dashboard" },
      { property: "og:description", content: "Run your MSFS 2024 cargo airline: fleet, jobs and operations." },
    ],
  }),
  component: Index,
});

function Index() {
  const stats = [
    { label: "Cash", value: `$${company.cash.toLocaleString()}` },
    { label: "Fleet", value: fleet.length },
    { label: "Open jobs", value: jobs.length },
    { label: "Reputation", value: `${company.reputation}★` },
  ];
  return (
    <>
      <PageHero eyebrow={`Hub · ${company.hub}`} title="Move the world." sub="Your cargo airline for Microsoft Flight Simulator 2024. Plan loads, dispatch aircraft, get paid." />
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {stats.map((s) => (
          <div key={s.label} className="panel p-6">
            <p className="text-sm text-muted-foreground">{s.label}</p>
            <p className="mt-2 font-display text-4xl font-bold text-gradient">{s.value}</p>
          </div>
        ))}
      </div>
      <div className="mt-8 panel flex flex-wrap items-center justify-between gap-4 p-8">
        <div>
          <h2 className="text-2xl font-semibold">Next best job</h2>
          <p className="text-muted-foreground">{jobs[0].cargo} · {jobs[0].from} → {jobs[0].to} · ${jobs[0].payout.toLocaleString()}</p>
        </div>
        <Link to="/jobs" className="rounded-xl bg-gradient-brand px-6 py-3 font-semibold text-primary-foreground shadow-glow transition-transform hover:scale-105">
          View job board
        </Link>
      </div>
    </>
  );
}
