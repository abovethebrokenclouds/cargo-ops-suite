import { useEffect, useState } from "react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { FboDay } from "@cargo-ops/protocol";
import { formatUsd } from "@/lib/format";

const TOKENS = [
  "--accent",
  "--primary",
  "--success",
  "--muted-foreground",
  "--border",
  "--card",
] as const;
type Token = (typeof TOKENS)[number];

/** Design-token colours read from CSS variables after mount (empty during SSR). */
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
  Math.abs(n) >= 1_000 ? `$${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k` : `$${Math.round(n)}`;

/**
 * Daily FBO income by source (last 30 in-game days): modelled traffic and simulator AI
 * arrivals are cash; own-fleet savings (fuel at cost, waived fees) are shown alongside.
 */
export function FboIncomeChart({ days }: { days: readonly FboDay[] }) {
  const c = useTokenColors();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const data = days.map((d) => ({
    label: `D${d.day + 1}`,
    modelled: d.modelled,
    simAi: d.simAi,
    own: d.own,
  }));
  return (
    <div className="h-60 w-full" data-testid="fbo-income-chart">
      {mounted ? (
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={c["--border"]} vertical={false} />
            <XAxis
              dataKey="label"
              tick={{ fill: c["--muted-foreground"], fontSize: 11 }}
              axisLine={{ stroke: c["--border"] }}
              tickLine={false}
              minTickGap={8}
            />
            <YAxis
              tickFormatter={compactUsd}
              tick={{ fill: c["--muted-foreground"], fontSize: 11 }}
              axisLine={false}
              tickLine={false}
              width={52}
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
              formatter={(value: number, name: string) => [formatUsd(value), name]}
            />
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 11, color: c["--muted-foreground"] }}
            />
            <Bar dataKey="modelled" name="Modelled traffic" stackId="cash" fill={c["--primary"]} />
            <Bar
              dataKey="simAi"
              name="Sim AI bonus"
              stackId="cash"
              fill={c["--accent"]}
              radius={[4, 4, 0, 0]}
            />
            <Bar
              dataKey="own"
              name="Own-fleet savings"
              fill={c["--success"]}
              radius={[4, 4, 0, 0]}
            />
          </BarChart>
        </ResponsiveContainer>
      ) : null}
    </div>
  );
}
