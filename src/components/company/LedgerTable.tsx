import type { LedgerEntryState } from "@cargo-ops/protocol";
import { formatGameTime } from "@cargo-ops/economy";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { LEDGER_LABELS } from "@/lib/economy/company";
import { formatUsdCents as formatUsd2 } from "@/lib/format";
import { cn } from "@/lib/utils";

/** Ledger rows, newest first: company-clock time, category, memo, signed amount, balance. */
export function LedgerTable({ entries }: { entries: readonly LedgerEntryState[] }) {
  return (
    <Table data-testid="ledger-table">
      <TableHeader>
        <TableRow className="border-border hover:bg-transparent">
          <TableHead className="label-eyebrow h-9">In-game time</TableHead>
          <TableHead className="label-eyebrow h-9">Category</TableHead>
          <TableHead className="label-eyebrow hidden h-9 md:table-cell">Memo</TableHead>
          <TableHead className="label-eyebrow h-9 text-right">Amount</TableHead>
          <TableHead className="label-eyebrow h-9 text-right">Balance</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {entries.map((e, i) => (
          <TableRow
            key={`${e.at}-${i}`}
            className="border-border hover:bg-secondary/40"
            data-category={e.category}
          >
            <TableCell className="whitespace-nowrap font-mono text-xs text-muted-foreground">
              {formatGameTime(e.gameMs)}
            </TableCell>
            <TableCell className="whitespace-nowrap text-sm text-foreground">
              {LEDGER_LABELS[e.category] ?? e.category}
            </TableCell>
            <TableCell className="hidden max-w-80 truncate text-xs text-muted-foreground md:table-cell">
              {e.memo ?? ""}
            </TableCell>
            <TableCell
              className={cn(
                "whitespace-nowrap text-right font-mono text-sm font-tabular",
                e.amount >= 0 ? "text-success" : "text-destructive",
              )}
            >
              {e.amount >= 0 ? "+" : ""}
              {formatUsd2(e.amount)}
            </TableCell>
            <TableCell className="whitespace-nowrap text-right font-mono text-sm text-foreground font-tabular">
              {formatUsd2(e.balance)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
