import { Link } from "@tanstack/react-router";

const links = [
  { to: "/", label: "Dashboard" },
  { to: "/jobs", label: "Cargo Jobs" },
  { to: "/fleet", label: "Fleet" },
] as const;

export function AppNav() {
  return (
    <header className="sticky top-0 z-20 border-b border-border/60 backdrop-blur-xl">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
        <Link to="/" className="font-display text-xl font-bold text-gradient">Cargo Ops</Link>
        <nav className="flex gap-1">
          {links.map((l) => (
            <Link
              key={l.to}
              to={l.to}
              activeOptions={{ exact: true }}
              className="rounded-lg px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground"
              activeProps={{ className: "bg-secondary text-foreground" }}
            >
              {l.label}
            </Link>
          ))}
        </nav>
        <span className="flex items-center gap-2 text-xs text-muted-foreground">
          <span className="h-2 w-2 rounded-full bg-destructive" /> MSFS 2024 offline
        </span>
      </div>
    </header>
  );
}

export function PageHero({ eyebrow, title, sub }: { eyebrow: string; title: string; sub: string }) {
  return (
    <section className="pb-10 pt-14">
      <p className="text-xs font-semibold uppercase tracking-[0.3em] text-accent">{eyebrow}</p>
      <h1 className="mt-3 text-6xl font-bold leading-[0.95] text-gradient md:text-8xl">{title}</h1>
      <p className="mt-5 max-w-xl text-lg text-muted-foreground">{sub}</p>
    </section>
  );
}
