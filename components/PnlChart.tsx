"use client";

import { useEffect, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { Loader2, TrendingUp } from "lucide-react";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";

interface PnlPoint {
  date: string;
  cumulativeProfit: number;
}

const POSITIVE = "#7CC576"; // panda.bamboo — same "profit" green app/platform's PortfolioCard sparkline uses
const NEGATIVE = "#E5484D"; // panda.panic

function formatUsd(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}$${value.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function CustomTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length || !label) return null;
  const value = payload[0].value;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-slate-500">{new Date(label).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" })}</p>
      <p className={`font-semibold ${value >= 0 ? "text-primary" : "text-red-400"}`}>{formatUsd(value)}</p>
    </div>
  );
}

// The consumer-app "wealth" line: a single smooth cumulative-P&L curve,
// deliberately not a price/candlestick chart — see GET /api/bots/pnl,
// which does the merging-across-bots and running-total math server-side so
// this component only ever renders an already-computed series. A single
// series needs no legend; the hero number above the chart carries the
// headline, the crosshair tooltip carries every point's exact value.
export function PnlChart() {
  const dict = useDictionary();
  const [points, setPoints] = useState<PnlPoint[] | null>(null);
  const [totalProfit, setTotalProfit] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    apiFetch<{ points: PnlPoint[]; totalProfit: number; hasData: boolean }>("/api/bots/pnl", {
      signal: controller.signal,
    })
      .then((data) => {
        setPoints(data.points);
        setTotalProfit(data.totalProfit);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(toErrorMessage(err, dict.pnl.loadFailed));
      });
    return () => controller.abort();
  }, []);

  if (error) {
    return (
      <div className="card-surface p-5">
        <p className="text-xs text-red-400">{error}</p>
      </div>
    );
  }

  if (points === null) {
    return (
      <div className="card-surface flex h-[220px] items-center justify-center p-5">
        <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
      </div>
    );
  }

  // Nothing to plot yet (no bots deployed, or none have a closed trade) —
  // stay out of the way rather than show an empty chart shell.
  if (points.length === 0) return null;

  const isPositive = totalProfit >= 0;
  const color = isPositive ? POSITIVE : NEGATIVE;
  const gradientId = "pnl-gradient";

  return (
    <div className="card-surface p-5">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <TrendingUp className="h-3.5 w-3.5" />
          {dict.pnl.heading}
        </div>
        <span className={`text-xl font-semibold ${isPositive ? "text-primary" : "text-red-400"}`}>
          {formatUsd(totalProfit)}
        </span>
      </div>

      <ResponsiveContainer width="100%" height={160}>
        <AreaChart data={points} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.1} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="date"
            tickFormatter={(v: string) => new Date(v).toLocaleDateString("nl-NL", { day: "numeric", month: "short" })}
            tick={{ fill: "#8A93A3", fontSize: 11 }}
            axisLine={{ stroke: "#272E38" }}
            tickLine={false}
            minTickGap={40}
          />
          <Tooltip content={<CustomTooltip />} cursor={{ stroke: "#272E38", strokeWidth: 1 }} />
          <Area
            type="monotone"
            dataKey="cumulativeProfit"
            stroke={color}
            strokeWidth={2}
            fill={`url(#${gradientId})`}
            dot={false}
            activeDot={{ r: 4, fill: color, stroke: "#14171C", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
