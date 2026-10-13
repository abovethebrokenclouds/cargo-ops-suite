import { Link } from "@tanstack/react-router";
import {
  Activity,
  BookOpen,
  Building2,
  Gauge,
  LayoutDashboard,
  Map as MapIcon,
  Package,
  Plane,
  Settings,
  Warehouse,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useHydrated } from "@/hooks/use-hydrated";

import { SimStatusChip } from "./status/SimStatusChip";

type NavItem = {
  to:
    | "/"
    | "/flight"
    | "/map"
    | "/jobs"
    | "/fleet"
    | "/fbo"
    | "/company"
    | "/logbook"
    | "/settings"
    | "/diagnostics";
  label: string;
  icon: LucideIcon;
};

const navItems: readonly NavItem[] = [
  { to: "/", label: "Ops", icon: LayoutDashboard },
  { to: "/flight", label: "Live Flight", icon: Gauge },
  { to: "/map", label: "Map", icon: MapIcon },
  { to: "/jobs", label: "Jobs", icon: Package },
  { to: "/fleet", label: "Fleet", icon: Plane },
  { to: "/fbo", label: "FBOs", icon: Warehouse },
  { to: "/company", label: "Company", icon: Building2 },
  { to: "/logbook", label: "Logbook", icon: BookOpen },
  { to: "/settings", label: "Settings", icon: Settings },
  { to: "/diagnostics", label: "Diagnostics", icon: Activity },
];

function Wordmark() {
  return (
    <Link to="/" className="group flex shrink-0 items-center gap-3" aria-label="Cargo Ops home">
      <span className="relative grid size-9 place-items-center rounded-xl bg-gradient-brand text-primary-foreground shadow-glow">
        <Plane className="size-4 -rotate-45" strokeWidth={2.5} aria-hidden="true" />
      </span>
      <span className="flex flex-col leading-none">
        <span className="font-display text-lg font-bold tracking-tight text-foreground">
          Cargo<span className="text-gradient">Ops</span>
        </span>
        <span className="mt-1 hidden font-mono text-[0.5625rem] uppercase tracking-[0.32em] text-muted-foreground sm:block">
          Operations Centre
        </span>
      </span>
    </Link>
  );
}

function NavLinks({ className }: { className?: string }) {
  // The local SPA build hydrates every route from the prerendered "/" shell, and React keeps
  // the shell's active-link attributes. Remounting the list once after hydration renders it
  // fresh from the real location (a no-op in the SSR build, where both renders match).
  const hydrated = useHydrated();
  return (
    <nav aria-label="Primary" className={className}>
      <ul key={hydrated ? "client" : "server"} className="flex items-center gap-1">
        {navItems.map(({ to, label, icon: Icon }) => (
          <li key={to} className="shrink-0">
            <Link
              to={to}
              activeOptions={{ exact: to === "/" }}
              className="group relative flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground data-[status=active]:bg-secondary/80 data-[status=active]:text-foreground"
            >
              <Icon
                className="size-4 opacity-70 transition-opacity group-hover:opacity-100 group-data-[status=active]:text-accent group-data-[status=active]:opacity-100 xl:hidden 2xl:block"
                aria-hidden="true"
              />
              {label}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-3 -bottom-px h-px scale-x-0 bg-gradient-brand transition-transform group-data-[status=active]:scale-x-100"
              />
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  );
}

export function AppNav({ statusSlot }: { statusSlot?: ReactNode }) {
  const status = statusSlot ?? <SimStatusChip status="demo" />;
  return (
    <header className="sticky top-0 z-30 border-b border-border bg-background/70 backdrop-blur-xl">
      <div className="mx-auto flex max-w-7xl items-center gap-4 px-4 py-3 md:px-6">
        <Wordmark />
        <NavLinks className="hidden min-w-0 flex-1 justify-center xl:flex" />
        <div className="ml-auto flex min-w-0 items-center xl:ml-0">{status}</div>
      </div>
      <div className="border-t border-border/60 xl:hidden">
        <NavLinks className="scrollbar-none mx-auto max-w-7xl overflow-x-auto px-2 py-1.5 md:px-4" />
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-gradient-brand opacity-40"
      />
    </header>
  );
}

export function PageHero({
  eyebrow,
  title,
  sub,
  children,
}: {
  eyebrow: string;
  title: string;
  sub: string;
  children?: ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6 pb-8 pt-10 md:flex-row md:items-end md:justify-between md:pb-10 md:pt-14">
      <div className="min-w-0">
        <p className="label-eyebrow flex items-center gap-2">
          <span className="status-dot size-1.5 text-accent" aria-hidden="true" />
          {eyebrow}
        </p>
        <h1 className="mt-4 text-5xl font-bold leading-[0.95] tracking-tight text-gradient sm:text-6xl md:text-7xl lg:text-8xl">
          {title}
        </h1>
        <p className="mt-5 max-w-xl text-base text-muted-foreground md:text-lg">{sub}</p>
      </div>
      {children ? <div className="flex shrink-0 flex-wrap gap-3">{children}</div> : null}
    </section>
  );
}
