import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

export type PanelProps = {
  title: string;
  eyebrow?: string;
  icon?: LucideIcon;
  action?: ReactNode;
  className?: string;
  bodyClassName?: string;
  children?: ReactNode;
};

/** Elevated glass panel with a consistent header row. */
export function Panel({
  title,
  eyebrow,
  icon: Icon,
  action,
  className,
  bodyClassName,
  children,
}: PanelProps) {
  return (
    <section
      className={cn(
        "panel-elevated flex min-w-0 flex-col",
        "animate-in fade-in slide-in-from-bottom-1 duration-300 motion-reduce:animate-none",
        className,
      )}
    >
      <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4 md:px-6">
        <div className="flex min-w-0 items-center gap-3">
          {Icon ? (
            <span className="grid size-8 shrink-0 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-accent">
              <Icon className="size-4" aria-hidden="true" />
            </span>
          ) : null}
          <div className="min-w-0">
            {eyebrow ? <p className="label-eyebrow">{eyebrow}</p> : null}
            <h2 className="truncate text-base font-semibold text-foreground md:text-lg">{title}</h2>
          </div>
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div className={cn("flex-1 p-5 md:p-6", bodyClassName)}>{children}</div>
    </section>
  );
}

/** Small mono tag marking values that come from demo seed data. */
export function DemoTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "rounded-sm bg-warning/15 px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold tracking-[0.16em] text-warning",
        className,
      )}
    >
      DEMO
    </span>
  );
}
