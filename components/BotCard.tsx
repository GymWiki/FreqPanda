"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronRight, Loader2 } from "lucide-react";
import type { BotConfigurationDTO } from "@/lib/types";
import type { HumanizedTrade } from "@/lib/trade-humanizer";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { LifecycleBadge } from "@/components/ui/LifecycleBadge";
import { deriveLifecycleStatus } from "@/lib/bot-lifecycle";
import { apiFetch } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";

interface BotCardProps {
  bot: BotConfigurationDTO;
}

function formatUsd(value: number): string {
  const sign = value >= 0 ? "+" : "";
  return `${sign}$${value.toLocaleString("nl-NL", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// One compact, entirely-clickable tile per bot — the dashboard overview.
// Deliberately shows only what's needed to recognize a bot and judge its
// state at a glance (name, strategy, lifecycle, a quick P/L read); every
// action that used to live directly on this card (training, deploying,
// exchange linking, credentials, delete, ...) now lives on the detail page
// this links to (app/bots/[id]/page.tsx -> BotDetailView), reached by
// clicking anywhere on the tile.
export function BotCard({ bot }: BotCardProps) {
  const dict = useDictionary();
  const [totalProfit, setTotalProfit] = useState<number | null>(null);
  const [isLoadingProfit, setIsLoadingProfit] = useState(false);

  const lifecycleStatus = deriveLifecycleStatus(bot, false);

  // Best-effort only: a quick "how's it doing" read straight from the same
  // /api/bots/[id]/trades endpoint the detail page's trade list and chart
  // use (see BotDetailView) — no separate summary endpoint, just the sum
  // of what's already there. Only worth asking for once a bot is actually
  // live; a bot that's never been deployed has nothing to report, and
  // silently staying blank (rather than showing an error) keeps a slow or
  // unreachable VPS from making the whole dashboard grid look broken.
  useEffect(() => {
    if (bot.deploymentStatus !== "VPS_ACTIVE") return;
    let cancelled = false;
    setIsLoadingProfit(true);
    apiFetch<{ trades: HumanizedTrade[] }>(`/api/bots/${bot.id}/trades`)
      .then((data) => {
        if (cancelled) return;
        const sum = data.trades.filter((t) => !t.isOpen && t.profitAbs !== null).reduce((acc, t) => acc + (t.profitAbs ?? 0), 0);
        setTotalProfit(sum);
      })
      .catch(() => {
        // Silent — see doc comment above.
      })
      .finally(() => {
        if (!cancelled) setIsLoadingProfit(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bot.id, bot.deploymentStatus]);

  return (
    <Link
      href={`/bots/${bot.id}`}
      className="card-surface group flex flex-col gap-3 p-5 transition hover:border-primary/50 hover:bg-surface/80"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="truncate font-semibold">{bot.botName}</h3>
          <p className="truncate text-xs text-slate-400">
            {bot.exchangeName ? <>{bot.exchangeName} &middot; </> : null}
            {bot.strategy}
          </p>
        </div>
        <ChevronRight className="h-4 w-4 shrink-0 text-slate-600 transition group-hover:translate-x-0.5 group-hover:text-primary" />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <LifecycleBadge status={lifecycleStatus} />
        <StatusBadge status={bot.deploymentStatus} />
      </div>

      {bot.deploymentStatus === "VPS_ACTIVE" && (
        <div className="mt-auto flex items-center gap-1.5 text-xs">
          {isLoadingProfit ? (
            <Loader2 className="h-3 w-3 animate-spin text-slate-500" />
          ) : totalProfit !== null ? (
            <span className={`font-semibold ${totalProfit >= 0 ? "text-primary" : "text-red-400"}`}>
              {formatUsd(totalProfit)}
            </span>
          ) : null}
          {totalProfit !== null && bot.isPaperTrading && (
            <span className="text-[11px] text-slate-500">({dict.botCard.practiceMode})</span>
          )}
        </div>
      )}
    </Link>
  );
}
