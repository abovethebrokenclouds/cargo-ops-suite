import type { LucideIcon } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";

import { cn } from "@/lib/utils";

export type EmptyStateProps = Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  eyebrow?: string;
  action?: ReactNode;
  className?: string;
};

/** Placeholder for a panel with no data yet. Never stands in for fabricated values. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  eyebrow,
  action,
  className,
  ...rest
}: EmptyStateProps) {
  return (
    <div
      {...rest}
      className={cn(
        "panel-inset flex flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        className,
      )}
    >
      {Icon ? (
        <span className="grid size-12 place-items-center rounded-full border border-primary/30 bg-primary/10 text-accent shadow-glow">
          <Icon className="size-5" aria-hidden="true" />
        </span>
      ) : null}
      {eyebrow ? <p className="label-eyebrow">{eyebrow}</p> : null}
      <h3 className="font-display text-lg font-semibold text-foreground">{title}</h3>
      {description ? (
        <div className="max-w-md text-sm text-muted-foreground">{description}</div>
      ) : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}
