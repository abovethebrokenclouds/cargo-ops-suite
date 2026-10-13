import { statusLabel } from "@/lib/sim-state";
import { useSimConnection } from "@/lib/transport/useSimConnection";

import { chipStatusFor } from "./sim-status";
import { SimStatusChip } from "./SimStatusChip";

export function ConnectedStatusChip({ className }: { className?: string }) {
  const { state } = useSimConnection();
  const status = chipStatusFor(state);
  return (
    <SimStatusChip
      status={status}
      {...(state.connection === "idle" ? {} : { label: statusLabel(state) })}
      {...(state.error ? { detail: state.error } : {})}
      {...(className ? { className } : {})}
    />
  );
}
