"use client";

import { useState } from "react";
import { Bot } from "lucide-react";
import type { BotConfigurationDTO } from "@/lib/types";
import { BotCard } from "@/components/BotCard";
import { NewBotDialog } from "@/components/NewBotDialog";
import { PanicButton } from "@/components/PanicButton";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { apiFetch } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";

interface BotFleetGridProps {
  initialBots: BotConfigurationDTO[];
  vpsBotQuota: number;
}

export function BotFleetGrid({ initialBots }: BotFleetGridProps) {
  const dict = useDictionary();
  const [bots, setBots] = useState<BotConfigurationDTO[]>(initialBots);

  const hasStoppableBots = bots.some(
    (b) => b.deploymentStatus === "VPS_ACTIVE" && b.status !== "PAUSED_EMERGENCY" && b.status !== "SLEEPING",
  );

  // The panic route itself only returns per-bot ok/error flags, not full
  // DTOs (see app/api/bots/panic) — refetching is simpler than hand-rolling
  // a partial-update merge for a call that touches every bot at once.
  async function refetchBots() {
    try {
      const data = await apiFetch<{ bots: BotConfigurationDTO[] }>("/api/bots");
      setBots(data.bots);
    } catch (err) {
      console.error("[BotFleetGrid] Refetch after panic failed:", err);
    }
  }

  function handleUpdate(updated: BotConfigurationDTO) {
    setBots((prev) => prev.map((b) => (b.id === updated.id ? { ...b, ...updated } : b)));
  }

  function handleCreated(bot: BotConfigurationDTO) {
    setBots((prev) => [bot, ...prev]);
  }

  function handleDelete(id: string) {
    setBots((prev) => prev.filter((b) => b.id !== id));
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end gap-3">
        <PanicButton disabled={!hasStoppableBots} onPanicked={refetchBots} />
        <NewBotDialog onCreated={handleCreated} />
      </div>

      {bots.length === 0 ? (
        <div className="card-surface flex flex-col items-center gap-3 px-6 py-16 text-center">
          <Bot className="h-10 w-10 text-slate-600" />
          <p className="text-sm text-slate-400">{dict.botFleet.empty}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {bots.map((bot) => (
            // Scoped per card: a crash rendering one bot (unexpected data
            // shape, a null field a component assumed was always set)
            // shouldn't take every other bot in the fleet down with it.
            <ErrorBoundary key={bot.id}>
              <BotCard bot={bot} onUpdate={handleUpdate} onDelete={handleDelete} />
            </ErrorBoundary>
          ))}
        </div>
      )}
    </div>
  );
}
