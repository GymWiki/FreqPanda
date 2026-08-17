"use client";

import { useEffect, useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import { ArrowDownRight, ArrowUpRight, History, Loader2, MinusCircle, TrendingUp } from "lucide-react";
import type { HumanizedTrade } from "@/lib/trade-humanizer";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";

interface BotTradesPanelProps {
  botId: string;
  isPaperTrading: boolean;
  isDeployed: boolean;
}

const POSITIVE = "#7CC576"; // panda.bamboo — same green PnlChart uses
const NEGATIVE = "#E5484D"; // panda.panic

function formatUsd(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}$${value.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatPrice(value: number): string {
  // Crypto prices span wildly different magnitudes (BTC ~$60k, a small-cap
  // alt sub-$1) — a fixed 2-decimal format would round the latter to 0.00.
  return value.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: value < 1 ? 6 : 2 });
}

function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString("nl-NL", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function ChartTooltip({ active, payload, label }: { active?: boolean; payload?: Array<{ value: number }>; label?: string }) {
  if (!active || !payload?.length || !label) return null;
  const value = payload[0].value;
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <p className="text-slate-500">{new Date(label).toLocaleDateString("nl-NL", { day: "numeric", month: "short", year: "numeric" })}</p>
      <p className={`font-semibold ${value >= 0 ? "text-primary" : "text-red-400"}`}>{formatUsd(value)}</p>
    </div>
  );
}

// This bot's own trade history and cumulative P/L, both derived from a
// single GET /api/bots/[id]/trades call — the same humanized trades the
// old collapsed feed on the bot card used, just presented directly (a
// table + chart, always loaded) rather than behind a "show" toggle, since
// a detail page's whole job is to show this. No new backend endpoint: the
// chart math (running total over closed trades, sorted by close date)
// mirrors GET /api/bots/pnl's server-side version, just computed here from
// the one bot this page is already scoped to.
export function BotTradesPanel({ botId, isPaperTrading, isDeployed }: BotTradesPanelProps) {
  const dict = useDictionary();
  const [trades, setTrades] = useState<HumanizedTrade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isDeployed) return;
    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    apiFetch<{ trades: HumanizedTrade[] }>(`/api/bots/${botId}/trades`, { signal: controller.signal })
      .then((data) => setTrades(data.trades))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(toErrorMessage(err, dict.botDetail.tradesLoadFailed));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, isDeployed]);

  const closedTrades = useMemo(
    () =>
      (trades ?? [])
        .filter((t): t is HumanizedTrade & { closedAt: string; profitAbs: number } => !t.isOpen && t.closedAt !== null && t.profitAbs !== null)
        .sort((a, b) => new Date(a.closedAt).getTime() - new Date(b.closedAt).getTime()),
    [trades],
  );

  const chartPoints = useMemo(() => {
    let cumulative = 0;
    return closedTrades.map((t) => {
      cumulative += t.profitAbs;
      return { date: t.closedAt, cumulativeProfit: Math.round(cumulative * 100) / 100 };
    });
  }, [closedTrades]);

  const totalProfit = chartPoints.length > 0 ? chartPoints[chartPoints.length - 1].cumulativeProfit : 0;
  const isPositive = totalProfit >= 0;
  const color = isPositive ? POSITIVE : NEGATIVE;

  // Most-recent-first for the table — the chart above needs ascending
  // order for a left-to-right running total, the table reads better with
  // the newest trade on top.
  const tableTrades = trades ? [...trades].reverse() : [];

  return (
    <div className="card-surface flex flex-col gap-4 p-5">
      <div className="flex items-baseline justify-between">
        <div className="flex items-center gap-1.5 text-xs text-slate-500">
          <TrendingUp className="h-3.5 w-3.5" />
          {dict.botDetail.chartHeading}
        </div>
        {chartPoints.length > 0 && (
          <span className={`text-lg font-semibold ${isPositive ? "text-primary" : "text-red-400"}`}>
            {isPaperTrading ? dict.botDetail.totalPlPaperNote(formatUsd(totalProfit)) : formatUsd(totalProfit)}
          </span>
        )}
      </div>

      {isLoading && (
        <div className="flex h-[140px] items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
        </div>
      )}

      {!isLoading && error && <p className="text-xs text-red-400">{error}</p>}

      {!isLoading && !error && !isDeployed && (
        <p className="text-xs text-slate-500">{dict.botDetail.tradesEmptyNotDeployed}</p>
      )}

      {!isLoading && !error && isDeployed && trades && chartPoints.length > 0 && (
        <ResponsiveContainer width="100%" height={140}>
          <AreaChart data={chartPoints} margin={{ top: 4, right: 4, left: 4, bottom: 0 }}>
            <defs>
              <linearGradient id="bot-pnl-gradient" x1="0" y1="0" x2="0" y2="1">
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
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: "#272E38", strokeWidth: 1 }} />
            <Area
              type="monotone"
              dataKey="cumulativeProfit"
              stroke={color}
              strokeWidth={2}
              fill="url(#bot-pnl-gradient)"
              dot={false}
              activeDot={{ r: 4, fill: color, stroke: "#14171C", strokeWidth: 2 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      )}

      {!isLoading && !error && isDeployed && trades && (
        <div>
          <div className="mb-2 flex items-center gap-1.5 text-xs text-slate-500">
            <History className="h-3.5 w-3.5" />
            {dict.botDetail.tradesHeading}
          </div>

          {tableTrades.length === 0 ? (
            <p className="text-xs text-slate-500">{dict.botDetail.tradesEmpty}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="text-slate-500">
                    <th className="pb-2 pr-3 font-medium">{dict.botDetail.tableDate}</th>
                    <th className="pb-2 pr-3 font-medium">{dict.botDetail.tablePair}</th>
                    <th className="pb-2 pr-3 font-medium">{dict.botDetail.tableEntry}</th>
                    <th className="pb-2 pr-3 font-medium">{dict.botDetail.tableExit}</th>
                    <th className="pb-2 font-medium">{dict.botDetail.tableResult}</th>
                  </tr>
                </thead>
                <tbody>
                  {tableTrades.map((trade) => (
                    <tr key={trade.id} className="border-t border-border">
                      <td className="py-2 pr-3 text-slate-400">{formatDateTime(trade.closedAt ?? trade.openedAt)}</td>
                      <td className="py-2 pr-3 font-medium text-slate-200">{trade.pair}</td>
                      <td className="py-2 pr-3 text-slate-300">{formatPrice(trade.entryPrice)}</td>
                      <td className="py-2 pr-3 text-slate-300">
                        {trade.exitPrice !== null ? formatPrice(trade.exitPrice) : "—"}
                      </td>
                      <td className="py-2">
                        {trade.isOpen ? (
                          <span className="flex items-center gap-1 text-slate-500">
                            <MinusCircle className="h-3 w-3" />
                            {dict.botDetail.tableOpenPosition}
                          </span>
                        ) : (
                          <span className={`flex items-center gap-1 ${trade.isWin ? "text-emerald-400" : "text-red-400"}`}>
                            {trade.isWin ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}
                            {trade.amountLabel}
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
