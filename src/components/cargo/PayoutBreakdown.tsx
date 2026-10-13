import type { PayoutBreakdown as Breakdown } from "@cargo-ops/protocol";
import { multiplier } from "@/lib/economy/format";
import { formatUsd } from "@/lib/format";
import { cn } from "@/lib/utils";

function value(f: Breakdown["factors"][number]): string {
  if (f.kind === "base") return formatUsd(f.value);
  if (f.kind === "deduction") return f.value > 0 ? `−${formatUsd(f.value)}` : formatUsd(0);
  return `× ${multiplier(f.value)}`;
}

/** Every factor of a payout, in order, with its value and note. */
export function PayoutBreakdown({
  breakdown,
  className,
}: {
  breakdown: Breakdown;
  className?: string;
}) {
  return (
    <div className={cn("panel-inset overflow-hidden", className)} data-testid="payout-breakdown">
      <table className="w-full text-left text-sm">
        <tbody>
          {breakdown.factors.map((f) => (
            <tr key={f.key} className="border-b border-border/60 last:border-0" data-factor={f.key}>
              <th scope="row" className="px-4 py-2 font-medium text-foreground">
                {f.label}
                {f.note ? (
                  <span className="block text-xs font-normal text-muted-foreground">{f.note}</span>
                ) : null}
              </th>
              <td
                className={cn(
                  "whitespace-nowrap px-4 py-2 text-right font-mono font-tabular",
                  f.kind === "deduction" && f.value > 0 ? "text-destructive" : "text-foreground",
                )}
              >
                {value(f)}
              </td>
            </tr>
          ))}
          <tr className="border-t border-border bg-secondary/40">
            <th scope="row" className="px-4 py-2 font-semibold text-foreground">
              {breakdown.estimate ? "Estimated payout" : "Payout"}
              {breakdown.noBonus ? (
                <span className="block text-xs font-normal text-warning">
                  No bonuses: the sim rate went above 1×
                </span>
              ) : null}
            </th>
            <td className="px-4 py-2 text-right font-mono text-base font-semibold font-tabular text-foreground">
              {formatUsd(breakdown.total)}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}
