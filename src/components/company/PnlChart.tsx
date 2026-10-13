import { useEffect, useState } from "react";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { PnlMonth } from "@cargo-ops/protocol";
import { formatUsd } from "@/lib/format";

const TOKENS = [
  "--success",
  "--destructive",
  "--accent",
  "--muted-foreground",
  "--border",
  "--card",
] as const;
type Token = (typeof TOKENS)[number];

/** Resolved design-token colours (after mount; empty during SSR so markup matches). */
function useTokenColors(): Partial<Record<Token, string>> {
  const [colors, setColors] = useState<Partial<Record<Token, string>>>({});
  useEffect(() => {
    const style = getComputedStyle(document.documentElement);
    const out: Partial<Record<Token, string>> = {};
    for (const t of TOKENS) {
      const v = style.getPropertyValue(t).trim();
      if (v) out[t] = v;
    }
    setColors(out);
  }, []);
  return colors;
}

const compactUsd = (n: number) =>
  Math.abs(n) >= 1_000_000
    ? `$${(n / 1_000_000).toFixed(1)}M`
    : Math.abs(n) >= 1_000
      ? `$${Math.round(n / 1_000)}k`
      : `$${Math.round(n)}`;

/** Operating revenue vs expense per in-game month, with the net as a line. */
export function PnlChart({ months }: { months: readonly PnlMonth[] }) {
  const c = useTokenColors();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const data = months.map((m) => ({
    label: `M${m.month + 1}`,
    revenue: m.revenue,
    expense: -m.expense,
    net: m.net,
  }));
  return (
    <div className="h-64 w-full" data-testid="pnl-chart">
      {mounted ? (
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, bottom: 0, left: 0 }}
            stackOffset="sign"
          >
            <CartesianGrid stroke={c["--border"]} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: c["--muted-foreground"], fontSize: 11 }}
              axisLine={{ stroke: c["--border"] }}
              tickLine={false}
            />
            <YAxis
              tickFormatter={compactUsd}
              tick={{ fill: c["--muted-foreground"], fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip
              cursor={{ fill: c["--border"] }}
              contentStyle={{
                background: c["--card"],
                border: `1px solid ${c["--border"] ?? "transparent"}`,
                borderRadius: 12,
                fontSize: 12,
              }}
              labelStyle={{ color: c["--muted-foreground"] }}
              formatter={(value: number, name: string) => [formatUsd(Math.abs(value)), name]}
            />
            <Bar
              dataKey="revenue"
              name="Revenue"
              stackId="pnl"
              fill={c["--success"]}
              radius={[6, 6, 0, 0]}
            />
            <Bar
              dataKey="expense"
              name="Expense"
              stackId="pnl"
              fill={c["--destructive"]}
              radius={[0, 0, 6, 6]}
            />
            <Line
              dataKey="net"
              name="Net"
              type="monotone"
              stroke={c["--accent"]}
              strokeWidth={2}
              dot={{ r: 3, fill: c["--accent"] }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      ) : null}
    </div>
  );
}
