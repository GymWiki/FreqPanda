"use client";

import { useEffect, useState } from "react";
import { AlertTriangle, Loader2, Rocket, X } from "lucide-react";
import type { BotConfigurationDTO } from "@/lib/types";
import { BudgetSlider } from "@/components/ui/BudgetSlider";
import { EXCHANGE_PRESETS } from "@/lib/exchange-presets";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";

interface GoLiveModalProps {
  bot: BotConfigurationDTO;
  onClose: () => void;
  onLive: (bot: BotConfigurationDTO) => void;
}

interface BalanceCheck {
  exchangeName: string;
  balance: { asset: string; amount: number };
  minRequired: number;
  canGoLive: boolean;
}

// The gate between paper and real money: fetches the linked platform's
// live balance, blocks the whole form below $minRequired, and — only once
// there's real balance to size against — lets the user set the budget/
// stake inputs that used to live in NewBotDialog before this app's
// "try before you risk" pivot moved them here.
export function GoLiveModal({ bot, onClose, onLive }: GoLiveModalProps) {
  const dict = useDictionary();
  const [check, setCheck] = useState<BalanceCheck | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [totalBudget, setTotalBudget] = useState(500);
  const [maxStakePercentage, setMaxStakePercentage] = useState(20);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const exchangeLabel = EXCHANGE_PRESETS.find((e) => e.id === check?.exchangeName)?.label ?? check?.exchangeName;

  useEffect(() => {
    // A user can close the modal (or it can be unmounted by a parent
    // re-render) before this resolves — the abort signal both cancels the
    // in-flight request and lets the .catch below tell an aborted fetch
    // apart from a real failure, so we never call setState on an unmounted
    // component.
    const controller = new AbortController();

    apiFetch<BalanceCheck>(`/api/bots/${bot.id}/golive`, { signal: controller.signal })
      .then((data) => {
        setCheck(data);
        setTotalBudget(Math.min(data.balance.amount, 500));
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setLoadError(toErrorMessage(err, dict.goLive.loadBalanceFailed));
      });

    return () => controller.abort();
  }, [bot.id]);

  async function handleConfirm() {
    setSubmitError(null);
    setIsSubmitting(true);
    try {
      const data = await apiFetch<{ bot: BotConfigurationDTO }>(`/api/bots/${bot.id}/golive`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ totalBudget, maxStakePercentage }),
      });
      onLive(data.bot);
    } catch (err) {
      setSubmitError(toErrorMessage(err, dict.goLive.goLiveFailed));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card-surface flex max-h-[90vh] w-full max-w-md flex-col p-6">
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <div>
            <h2 className="font-semibold">{dict.goLive.heading}</h2>
            <p className="text-xs text-slate-400">{dict.goLive.subtitle(bot.botName)}</p>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
          {!check && !loadError && (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-slate-500" />
            </div>
          )}

          {loadError && (
            <p className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2.5 text-xs text-red-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {loadError}
            </p>
          )}

          {check && (
            <div className="rounded-lg bg-background px-3 py-2.5">
              <span className="text-[11px] text-slate-500">{dict.goLive.balanceLabel(exchangeLabel ?? "")}</span>
              <p className="text-xl font-semibold text-primary">
                ${check.balance.amount.toLocaleString("nl-NL", { maximumFractionDigits: 2 })}
                <span className="ml-1 text-xs font-normal text-slate-500">{check.balance.asset}</span>
              </p>
            </div>
          )}

          {check && !check.canGoLive && (
            <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2.5 text-xs text-amber-300">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              {dict.goLive.balanceTooLow(exchangeLabel ?? "", check.minRequired)}
            </p>
          )}

          {check?.canGoLive && (
            <>
              <div>
                <span className="mb-1 block text-xs font-medium text-slate-400">{dict.goLive.totalBudgetLabel}</span>
                <BudgetSlider
                  totalBudget={totalBudget}
                  maxStakePercentage={maxStakePercentage}
                  onBudgetChange={setTotalBudget}
                  onPercentageChange={setMaxStakePercentage}
                />
                {totalBudget > check.balance.amount && (
                  <p className="mt-1.5 text-[11px] text-amber-400">
                    {dict.goLive.budgetTooHigh(check.balance.amount.toFixed(2))}
                  </p>
                )}
              </div>

              {submitError && (
                <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                  {submitError}
                </p>
              )}
            </>
          )}
        </div>

        <button
          type="button"
          onClick={handleConfirm}
          disabled={!check?.canGoLive || isSubmitting || totalBudget > (check?.balance.amount ?? 0) || !(totalBudget > 0)}
          className="mt-4 flex w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-sm font-semibold text-background transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
          {dict.goLive.submit}
        </button>
      </div>
    </div>
  );
}
