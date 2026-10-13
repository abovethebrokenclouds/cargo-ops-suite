import type { Source } from "@cargo-ops/protocol";

import { cn } from "@/lib/utils";

const tagBase =
  "shrink-0 rounded-sm px-1.5 py-0.5 font-mono text-[0.625rem] font-semibold leading-none tracking-[0.16em]";

/** DEMO / REPLAY tag for values that did not come from a live simulator. Live renders nothing. */
export function SourceTag({
  source,
  className,
}: {
  source: Source | null | undefined;
  className?: string;
}) {
  if (source !== "demo" && source !== "replay") return null;
  return (
    <span
      className={cn(
        tagBase,
        source === "demo" ? "bg-warning/15 text-warning" : "bg-tertiary/20 text-foreground",
        className,
      )}
      data-source-tag={source}
    >
      {source === "demo" ? "DEMO" : "REPLAY"}
    </span>
  );
}

/** Marks values whose last frame is older than the stale threshold. */
export function StaleTag({ className }: { className?: string }) {
  return (
    <span
      className={cn(tagBase, "border border-muted-foreground/30 text-muted-foreground", className)}
      title="No new data for more than 5 seconds"
      data-stale-tag=""
    >
      STALE
    </span>
  );
}
