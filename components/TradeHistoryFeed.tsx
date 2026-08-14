"use client";

import { useEffect, useState } from "react";
import { ArrowDownRight, ArrowUpRight, History, Loader2, MinusCircle } from "lucide-react";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";

interface HumanizedTrade {
  id: number;
  pair: string;
  isOpen: boolean;
  closedAt: string | null;
  profitAbs: number | null;
  profitRatio: number | null;
  isWin: boolean | null;
  headline: string;
  amountLabel: string | null;
}

interface TradeHistoryFeedProps {
  botId: string;
}

const RELATIVE_UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ["year", 31536000],
  ["month", 2592000],
  ["day", 86400],
  ["hour", 3600],
  ["minute", 60],
];
const relativeFormatter = new Intl.RelativeTimeFormat("nl", { numeric: "auto" });

function formatRelative(isoDate: string): string {
  const diffSeconds = (new Date(isoDate).getTime() - Date.now()) / 1000;
  for (const [unit, secondsInUnit] of RELATIVE_UNITS) {
    if (Math.abs(diffSeconds) >= secondsInUnit) {
      return relativeFormatter.format(Math.round(diffSeconds / secondsInUnit), unit);
    }
  }
  return relativeFormatter.format(Math.round(diffSeconds / 60), "minute");
}

// A plain-language timeline of what a bot's positions actually did — the
// "Jip-en-Janneke" translation of freqtrade's exit_reason vocabulary
// happens server-side (GET /api/bots/[id]/trades -> lib/trade-humanizer.ts),
// so this component only ever renders already-humanized copy. Lazy-loaded:
// nothing fetches until the user actually opens the section, since most
// bots on the dashboard are never expanded in a given visit.
export function TradeHistoryFeed({ botId }: TradeHistoryFeedProps) {
  const dict = useDictionary();
  const [isOpen, setIsOpen] = useState(false);
  const [trades, setTrades] = useState<HumanizedTrade[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!isOpen || trades !== null || isLoading) return;

    const controller = new AbortController();
    setIsLoading(true);
    setError(null);
    apiFetch<{ trades: HumanizedTrade[] }>(`/api/bots/${botId}/trades`, { signal: controller.signal })
      .then((data) => setTrades(data.trades))
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(toErrorMessage(err, dict.tradeHistory.loadFailed));
      })
      .finally(() => {
        if (!controller.signal.aborted) setIsLoading(false);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, botId]);

  return (
    <div className="rounded-lg border border-border">
      <button
        type="button"
        onClick={() => setIsOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-2 px-3 py-2 text-xs font-medium text-slate-300 transition hover:text-primary"
      >
        <span className="flex items-center gap-1.5">
          <History className="h-3.5 w-3.5" />
          {dict.tradeHistory.heading}
        </span>
        <span className="text-slate-500">{isOpen ? dict.tradeHistory.hide : dict.tradeHistory.show}</span>
      </button>

      {isOpen && (
        <div className="border-t border-border px-3 py-2">
          {isLoading && (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-slate-500" />
            </div>
          )}

          {error && <p className="py-2 text-xs text-red-400">{error}</p>}

          {trades && trades.length === 0 && (
            <p className="py-2 text-xs text-slate-500">{dict.tradeHistory.empty}</p>
          )}

          {trades && trades.length > 0 && (
            <ul className="max-h-64 space-y-2 overflow-y-auto py-1">
              {trades.map((trade) => (
                <li key={trade.id} className="flex items-start gap-2.5">
                  {trade.isOpen ? (
                    <MinusCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-500" />
                  ) : trade.isWin ? (
                    <ArrowUpRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-400" />
                  ) : (
                    <ArrowDownRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-red-400" />
                  )}
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-slate-200">{trade.headline}</p>
                    <div className="mt-0.5 flex items-center gap-2 text-[11px] text-slate-500">
                      {trade.amountLabel && (
                        <span className={trade.isWin ? "text-emerald-400" : "text-red-400"}>
                          {trade.amountLabel}
                        </span>
                      )}
                      {trade.closedAt && <span>{formatRelative(trade.closedAt)}</span>}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
