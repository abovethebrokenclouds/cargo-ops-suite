import { LoaderCircle, PlugZap } from "lucide-react";

import { EmptyState } from "@/components/EmptyState";
import { connectionEmpty } from "@/lib/connection-empty";
import type { ClientSimState } from "@/lib/sim-state";
import { cn } from "@/lib/utils";

/**
 * Page-level notice while there is no session (connecting, connector offline or erroring).
 * Renders nothing once live, replay or demo data flows, so panels below can show their own
 * "nothing yet" states without guessing why they are empty.
 */
export function ConnectionNotice({
  state,
  className,
}: {
  state: ClientSimState;
  className?: string;
}) {
  const copy = connectionEmpty(state);
  if (!copy) return null;
  const detail = copy.kind === "offline" && state.error ? ` (${state.error})` : "";
  return (
    <EmptyState
      className={cn("col-span-12 py-6", className)}
      icon={copy.kind === "connecting" ? LoaderCircle : PlugZap}
      eyebrow="Connection"
      title={copy.title}
      description={`${copy.description}${detail}`}
      data-testid="connection-notice"
      data-kind={copy.kind}
    />
  );
}
