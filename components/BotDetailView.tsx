"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  ArrowLeft,
  Download,
  Rocket,
  Upload,
  Loader2,
  CheckCircle2,
  Trash2,
  Laptop,
  KeyRound,
  Copy,
  Check,
  Zap,
  AlertOctagon,
  Moon,
  PlayCircle,
  PauseCircle,
  Link2,
  ShieldCheck,
  ShieldAlert,
  Unlink,
  Clock,
  AlertTriangle,
  BarChart3,
} from "lucide-react";
import type { BotConfigurationDTO } from "@/lib/types";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { LifecycleBadge } from "@/components/ui/LifecycleBadge";
import { deriveLifecycleStatus } from "@/lib/bot-lifecycle";
import { getTrainingFreshness } from "@/lib/retrain-advice";
import { GoLiveModal } from "@/components/GoLiveModal";
import { ConnectExchangeDialog } from "@/components/ConnectExchangeDialog";
import { BotTradesPanel } from "@/components/BotTradesPanel";
import { Switch } from "@/components/ui/Switch";
import { EXCHANGE_PRESETS } from "@/lib/exchange-presets";
import { DEFAULT_PAPER_TOTAL_BUDGET, DEFAULT_PAPER_MAX_STAKE_PERCENTAGE } from "@/lib/paper-trading-defaults";
import { isTauri } from "@/lib/tauri";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";
import { InfoTooltip } from "@/components/ui/Tooltip";

interface BotDetailViewProps {
  bot: BotConfigurationDTO;
}

// Mirrors src-tauri/src/main.rs's BacktestSummary — the result of
// run_local_backtest, the rule-based (non-FreqAI) counterpart to
// train_local_model. Kept as a local interface, same convention this file
// already uses for local_training_status's inline `{ state: string }`
// result type, rather than a shared DTO — this never crosses the server
// API, only the Tauri invoke boundary.
// totalTrades is always present (run_local_backtest/read_backtest_stats
// treats it as required and errors out otherwise) — it exists specifically
// so this component can tell "a real backtest that closed zero trades"
// apart from "the parser couldn't find this stat", which would otherwise
// both render as an identical, misleading 0%/0W-0L-0D tile (see
// read_backtest_stats' own doc comment for the regression this closes).
// Every OTHER field is nullable: a single missing/renamed field degrades to
// null rather than failing the whole backtest — freqtrade's own stats JSON
// shape has already shifted out from under an earlier, unverified
// assumption here once — so the UI still shows "not available" for one
// stat without losing the rest of the card.
interface BacktestSummary {
  totalTrades: number;
  totalProfitPct: number | null;
  wins: number | null;
  losses: number | null;
  draws: number | null;
  winRate: number | null;
  maxDrawdownPct: number | null;
}

// Everything that used to live directly on the compact dashboard card
// (components/BotCard.tsx before the dashboard->detail-page split) lives
// here now — exchange linking, auto-compound, pause/resume/stop, local
// training, manual upload, deploy, credentials, delete — plus what's new
// to the detail page: training status/retrain advice and the trades+P&L
// panel (see BotTradesPanel). This component owns the bot's live state
// (starts from the server-fetched `bot` prop, updates locally on every
// mutation) since — unlike the old card — there's no parent list to push
// updates back into; a delete navigates back to the dashboard instead of
// calling an onDelete prop.
export function BotDetailView({ bot: initialBot }: BotDetailViewProps) {
  const dict = useDictionary();
  const router = useRouter();
  const [bot, setBot] = useState(initialBot);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isTrainingLocally, setIsTrainingLocally] = useState(false);
  const [trainingStatus, setTrainingStatus] = useState<string | null>(null);
  const [isBacktesting, setIsBacktesting] = useState(false);
  const [backtestStatus, setBacktestStatus] = useState<string | null>(null);
  const [backtestResult, setBacktestResult] = useState<BacktestSummary | null>(null);
  const [isRevealingCredentials, setIsRevealingCredentials] = useState(false);
  const [apiCredentials, setApiCredentials] = useState<{ username: string; password: string } | null>(null);
  const [copiedField, setCopiedField] = useState<"username" | "password" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isGoLiveOpen, setIsGoLiveOpen] = useState(false);
  const [isTogglingAutoCompound, setIsTogglingAutoCompound] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isConnectExchangeOpen, setIsConnectExchangeOpen] = useState(false);
  const [isDisconnectingExchange, setIsDisconnectingExchange] = useState(false);

  const [optimisticAutoCompound, setOptimisticAutoCompound] = useState<boolean | null>(null);
  const autoCompoundInFlight = useRef(false);

  function onUpdate(updated: BotConfigurationDTO) {
    setBot((prev) => ({ ...prev, ...updated }));
  }

  // Reconnects to a local training run that's still going (or finished
  // without ever getting uploaded) after this page remounts — see
  // handleStartLocalTraining's own doc comment for why calling it again is
  // always safe.
  useEffect(() => {
    if (!isTauri() || bot.aiModelPath) return;
    let cancelled = false;
    (async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        const status = await invoke<{ state: string }>("local_training_status", { botId: bot.id });
        if (!cancelled && status.state !== "not_started") {
          handleStartLocalTraining();
        }
      } catch {
        // Best-effort — a failed status check just leaves the normal idle
        // "start training" button visible, same as before this existed.
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bot.id]);

  const lifecycleStatus = deriveLifecycleStatus(bot, isTrainingLocally);
  const trainingFreshness = getTrainingFreshness(bot.aiModelUploadedAt);
  const canGoLive = bot.status === "TRAINING_PAPER_TRADE" && bot.deploymentStatus === "VPS_ACTIVE";
  const isPaused = bot.status === "PAUSED_EMERGENCY" || bot.status === "SLEEPING" || bot.status === "PAUSED_MANUAL";
  const canStop =
    bot.deploymentStatus === "VPS_ACTIVE" && (bot.status === "TRAINING_PAPER_TRADE" || bot.status === "LIVE_TRADING");

  async function handleResume() {
    setError(null);
    setIsResuming(true);
    try {
      const data = await apiFetch<{ bot: BotConfigurationDTO }>(`/api/bots/${bot.id}/resume`, { method: "POST" });
      onUpdate(data.bot);
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.resumeFailed));
    } finally {
      setIsResuming(false);
    }
  }

  async function handleStop() {
    if (!confirm(dict.botCard.confirmStop(bot.botName))) {
      return;
    }
    setError(null);
    setIsStopping(true);
    try {
      const data = await apiFetch<{ bot: BotConfigurationDTO }>(`/api/bots/${bot.id}/stop`, { method: "POST" });
      onUpdate(data.bot);
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.stopFailed));
    } finally {
      setIsStopping(false);
    }
  }

  async function handleAutoCompoundChange(autoCompound: boolean) {
    if (autoCompoundInFlight.current) return;
    autoCompoundInFlight.current = true;
    setError(null);
    setIsTogglingAutoCompound(true);
    setOptimisticAutoCompound(autoCompound);
    try {
      const data = await apiFetch<{ bot: BotConfigurationDTO }>(`/api/bots/${bot.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ autoCompound }),
      });
      onUpdate(data.bot);
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.autoCompoundUpdateFailed));
    } finally {
      setOptimisticAutoCompound(null);
      setIsTogglingAutoCompound(false);
      autoCompoundInFlight.current = false;
    }
  }

  async function handleFileSelected(file: File) {
    setError(null);
    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("botId", bot.id);
      formData.append("file", file);
      const data = await apiFetch<{ aiModelPath: string }>("/api/upload", { method: "POST", body: formData });
      onUpdate({ ...bot, aiModelPath: data.aiModelPath, aiModelUploadedAt: new Date().toISOString() });
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.uploadFailed));
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  async function handleStartLocalTraining(forceRetrain = false) {
    setError(null);
    setTrainingStatus(null);
    setIsTrainingLocally(true);

    const { invoke } = await import("@tauri-apps/api/core");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const { listen } = await import("@tauri-apps/api/event");

    const unlisten = await listen<{ botId: string; line: string }>("training-progress", (event) => {
      if (event.payload.botId === bot.id) {
        setTrainingStatus(event.payload.line);
      }
    });

    try {
      const modelPath = await invoke<string>("train_local_model", {
        botId: bot.id,
        strategy: bot.strategy,
        strategyCode: bot.strategyCode,
        exchangeName: bot.exchangeName ?? "",
        autoSelectCoins: bot.autoSelectCoins,
        autoSelectPairCount: bot.autoSelectPairCount,
        pairWhitelist: bot.pairWhitelist ?? "",
        forceRetrain,
      });

      const bytes = await readFile(modelPath);
      const filename = modelPath.split(/[\\/]/).pop() ?? `${bot.botName}-model.joblib`;
      const file = new File([new Uint8Array(bytes)], filename, { type: "application/octet-stream" });
      await handleFileSelected(file);
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.localTrainingFailed));
    } finally {
      unlisten();
      setIsTrainingLocally(false);
      setTrainingStatus(null);
    }
  }

  // The rule-based (non-FreqAI) counterpart to handleStartLocalTraining
  // above — downloads data and runs a plain backtest via run_local_backtest
  // (src-tauri/src/main.rs), no model to upload afterward. Deliberately
  // simpler: no reconnect-on-mount effect (unlike training, a backtest is
  // short enough that losing progress on a page refresh isn't worth the
  // extra machinery — the user just clicks the button again).
  async function handleRunLocalBacktest() {
    setError(null);
    setBacktestStatus(null);
    setIsBacktesting(true);

    const { invoke } = await import("@tauri-apps/api/core");
    const { listen } = await import("@tauri-apps/api/event");

    const unlisten = await listen<{ botId: string; line: string }>("training-progress", (event) => {
      if (event.payload.botId === bot.id) {
        setBacktestStatus(event.payload.line);
      }
    });

    try {
      // Which timeframe(s) to download is no longer decided here — Rust's
      // run_local_backtest derives it directly from strategyCode's own
      // `timeframe`/`informative_timeframe` attributes (the exact same
      // source freqtrade itself reads), so it can never drift from what
      // backtesting actually uses. See extract_download_timeframes'
      // doc comment in src-tauri/src/main.rs.
      const summary = await invoke<BacktestSummary>("run_local_backtest", {
        botId: bot.id,
        strategy: bot.strategy,
        strategyCode: bot.strategyCode,
        autoSelectCoins: bot.autoSelectCoins,
        autoSelectPairCount: bot.autoSelectPairCount,
        pairWhitelist: bot.pairWhitelist ?? "",
      });
      setBacktestResult(summary);
    } catch (err) {
      setError(toErrorMessage(err, dict.backtestResults.failed));
    } finally {
      unlisten();
      setIsBacktesting(false);
      setBacktestStatus(null);
    }
  }

  function handleDownloadConfig() {
    const config = {
      bot_name: bot.botName,
      exchange: bot.exchangeName,
      strategy: bot.strategy,
      auto_select_coins: bot.autoSelectCoins,
      pair_whitelist: bot.autoSelectCoins ? null : bot.pairWhitelist?.split(",").map((p) => p.trim()) ?? null,
      pairlist_method: bot.autoSelectCoins
        ? `VolumePairList (top ${bot.autoSelectPairCount} USDT by volume)`
        : "StaticPairList",
      stake_amount: "unlimited",
      custom_user_settings: {
        total_budget: bot.totalBudget ?? DEFAULT_PAPER_TOTAL_BUDGET,
        max_stake_pct: bot.maxStakePercentage ?? DEFAULT_PAPER_MAX_STAKE_PERCENTAGE,
      },
      dry_run: bot.isPaperTrading,
      ai_model_path: bot.aiModelPath ?? null,
      note: dict.botCard.localConfigNote,
    };
    const blob = new Blob([JSON.stringify(config, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${bot.botName.replace(/\s+/g, "-").toLowerCase()}-config.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function handleDeploy() {
    setError(null);
    if (!bot.aiModelPath) {
      setError(dict.botCard.deployNeedsModel);
      return;
    }
    setIsDeploying(true);
    try {
      const data = await apiFetch<{
        bot: BotConfigurationDTO;
        apiCredentials: { username: string; password: string };
      }>("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botId: bot.id }),
      });

      onUpdate(data.bot);
      setApiCredentials(data.apiCredentials);
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.deployFailed));
    } finally {
      setIsDeploying(false);
    }
  }

  async function handleRevealCredentials() {
    setError(null);
    setIsRevealingCredentials(true);
    try {
      const data = await apiFetch<{ username: string; password: string }>(`/api/bots/${bot.id}/credentials`);
      setApiCredentials(data);
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.loadCredentialsFailed));
    } finally {
      setIsRevealingCredentials(false);
    }
  }

  async function handleCopy(field: "username" | "password", value: string) {
    await navigator.clipboard.writeText(value);
    setCopiedField(field);
    setTimeout(() => setCopiedField((current) => (current === field ? null : current)), 1500);
  }

  async function handleDelete() {
    if (!confirm(dict.botCard.confirmRemove(bot.botName))) return;
    setError(null);
    setIsDeleting(true);
    try {
      await apiFetch(`/api/bots/${bot.id}`, { method: "DELETE" });
      router.push("/dashboard");
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.removeFailed));
      setIsDeleting(false);
    }
  }

  async function handleDisconnectExchange() {
    if (!confirm(dict.botCard.confirmDisconnectExchange)) return;
    setError(null);
    setIsDisconnectingExchange(true);
    try {
      await apiFetch(`/api/bots/${bot.id}/exchange-connection`, { method: "DELETE" });
      onUpdate({ ...bot, exchangeConnection: null });
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.disconnectFailed));
    } finally {
      setIsDisconnectingExchange(false);
    }
  }

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-4 pb-24 pt-6 sm:px-6 sm:py-10 md:pb-10">
      <Link href="/dashboard" className="flex w-fit items-center gap-1.5 text-sm text-slate-400 transition hover:text-primary">
        <ArrowLeft className="h-4 w-4" />
        {dict.botDetail.back}
      </Link>

      <div className="card-surface flex flex-col gap-4 p-5">
        <div className="flex items-start justify-between gap-2">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-bold">{bot.botName}</h1>
              <LifecycleBadge status={lifecycleStatus} />
            </div>
            <p className="text-xs text-slate-400">
              {bot.exchangeName ? <>{bot.exchangeName} &middot; </> : null}
              {bot.strategy}
            </p>
            {bot.totalBudget !== null && bot.maxStakePercentage !== null ? (
              <p className="mt-0.5 text-[11px] text-slate-500">
                {dict.botCard.budgetLine(
                  bot.totalBudget,
                  Number(((bot.totalBudget * bot.maxStakePercentage) / 100).toFixed(2)),
                  bot.maxStakePercentage,
                )}
              </p>
            ) : (
              <p className="mt-0.5 text-[11px] text-slate-500">{dict.botCard.noBudgetYet}</p>
            )}
          </div>
          <div className="flex shrink-0 flex-col items-end gap-1.5">
            <StatusBadge status={bot.deploymentStatus} />
            {canStop && (
              <button
                type="button"
                onClick={handleStop}
                disabled={isStopping}
                className="flex items-center gap-1 rounded-md border border-amber-500/40 px-2 py-1 text-[11px] font-medium text-amber-400 transition hover:bg-amber-500/10 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isStopping ? <Loader2 className="h-3 w-3 animate-spin" /> : <PauseCircle className="h-3 w-3" />}
                {dict.botCard.stopBot}
              </button>
            )}
          </div>
        </div>

        {isPaused && (
          <div className="flex flex-col gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs">
            <div className="flex items-center gap-1.5 font-medium text-amber-300">
              {bot.status === "PAUSED_EMERGENCY" ? (
                <AlertOctagon className="h-3.5 w-3.5 shrink-0" />
              ) : bot.status === "SLEEPING" ? (
                <Moon className="h-3.5 w-3.5 shrink-0" />
              ) : (
                <PauseCircle className="h-3.5 w-3.5 shrink-0" />
              )}
              {bot.status === "PAUSED_EMERGENCY"
                ? dict.botCard.emergencyStopped
                : bot.status === "SLEEPING"
                  ? dict.botCard.sleeping
                  : dict.botCard.manuallyStopped}
            </div>
            {bot.lastError && <p className="text-amber-200/80">{bot.lastError}</p>}
            <button
              type="button"
              onClick={handleResume}
              disabled={isResuming}
              className="flex items-center justify-center gap-1.5 self-start rounded-md bg-amber-500 px-2.5 py-1 text-[11px] font-semibold text-background transition hover:bg-amber-400 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isResuming ? <Loader2 className="h-3 w-3 animate-spin" /> : <PlayCircle className="h-3 w-3" />}
              {dict.botCard.resume}
            </button>
          </div>
        )}

        <div
          className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-xs font-medium ${
            bot.status === "PAUSED_MANUAL"
              ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
              : bot.isPaperTrading
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-300"
                : "border-red-500/40 bg-red-500/10 text-red-300"
          }`}
        >
          <span className="flex items-center gap-1.5">
            {bot.status === "PAUSED_MANUAL" ? dict.botCard.stoppedLabel : bot.isPaperTrading ? dict.botCard.practiceMode : dict.botCard.realMoney}
            <InfoTooltip text={dict.botCard.modeTooltip} />
          </span>
          {canGoLive && (
            <button
              type="button"
              onClick={() => setIsGoLiveOpen(true)}
              className="flex items-center gap-1.5 rounded-md bg-emerald-500 px-2.5 py-1 text-[11px] font-semibold text-background transition hover:bg-emerald-400"
            >
              <Zap className="h-3 w-3" />
              {dict.botCard.goLive}
            </button>
          )}
        </div>

        {isGoLiveOpen && (
          <GoLiveModal
            bot={bot}
            onClose={() => setIsGoLiveOpen(false)}
            onLive={(updated) => {
              onUpdate(updated);
              setIsGoLiveOpen(false);
            }}
          />
        )}

        {error && <p className="text-xs text-red-400">{error}</p>}
      </div>

      {/* Trainingsstatus (FreqAI) of Backtest-resultaten (regel-gebaseerd) —
          requirement: a "past results aren't a guarantee" disclaimer next
          to backtest results, for both bot types, not just the new
          rule-based one. */}
      {bot.strategyType === "FREQAI" ? (
        <div className="card-surface flex flex-col gap-3 p-5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
            <Clock className="h-3.5 w-3.5" />
            {dict.botDetail.trainingStatusHeading}
          </div>
          {trainingFreshness.everTrained ? (
            <>
              <p className="text-xs text-slate-400">
                {trainingFreshness.daysSinceTraining === 0
                  ? dict.botDetail.trainedToday
                  : dict.botDetail.trainedDaysAgo(trainingFreshness.daysSinceTraining ?? 0)}
              </p>
              <div
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs ${
                  trainingFreshness.retrainRecommended
                    ? "border-amber-500/40 bg-amber-500/10 text-amber-300"
                    : "border-primary/30 bg-primary/5 text-primary"
                }`}
              >
                {trainingFreshness.retrainRecommended ? (
                  <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                )}
                {trainingFreshness.retrainRecommended ? dict.botDetail.retrainRecommended : dict.botDetail.retrainNotNeeded}
              </div>
              <p className="text-[11px] text-slate-500">{dict.backtestResults.disclaimer}</p>
            </>
          ) : (
            <p className="text-xs text-slate-500">{dict.botDetail.neverTrained}</p>
          )}
        </div>
      ) : (
        <div className="card-surface flex flex-col gap-3 p-5">
          <div className="flex items-center gap-1.5 text-xs font-medium text-slate-300">
            <BarChart3 className="h-3.5 w-3.5" />
            {dict.backtestResults.heading}
          </div>
          {backtestResult ? (
            backtestResult.totalTrades === 0 ? (
              // A real, structurally valid backtest that happened to close
              // zero trades reads identically to a broken parse if all we
              // show is 0%/0W-0L-0D tiles — say so plainly instead, using
              // totalTrades (always present, never silently defaulted; see
              // this file's own BacktestSummary doc comment) as the one
              // field that actually distinguishes the two.
              <p className="text-xs text-slate-500">{dict.backtestResults.zeroTrades}</p>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded-lg bg-background px-3 py-2">
                    <p className="text-[11px] text-slate-500">{dict.backtestResults.totalProfit}</p>
                    {backtestResult.totalProfitPct !== null ? (
                      <p className={`text-sm font-semibold ${backtestResult.totalProfitPct >= 0 ? "text-primary" : "text-red-400"}`}>
                        {backtestResult.totalProfitPct >= 0 ? "+" : ""}
                        {backtestResult.totalProfitPct.toFixed(2)}%
                      </p>
                    ) : (
                      <p className="text-sm font-semibold text-slate-500">{dict.backtestResults.notAvailable}</p>
                    )}
                  </div>
                  <div className="rounded-lg bg-background px-3 py-2">
                    <p className="text-[11px] text-slate-500">{dict.backtestResults.winRate}</p>
                    <p className="text-sm font-semibold text-slate-100">
                      {backtestResult.winRate !== null ? `${(backtestResult.winRate * 100).toFixed(0)}%` : dict.backtestResults.notAvailable}
                    </p>
                  </div>
                  <div className="rounded-lg bg-background px-3 py-2">
                    <p className="text-[11px] text-slate-500">{dict.backtestResults.trades}</p>
                    <p className="text-sm font-semibold text-slate-100">
                      {backtestResult.wins !== null && backtestResult.losses !== null && backtestResult.draws !== null
                        ? dict.backtestResults.winLossDraw(backtestResult.wins, backtestResult.losses, backtestResult.draws)
                        : dict.backtestResults.notAvailable}
                    </p>
                  </div>
                  <div className="rounded-lg bg-background px-3 py-2">
                    <p className="text-[11px] text-slate-500">{dict.backtestResults.maxDrawdown}</p>
                    <p className="text-sm font-semibold text-amber-300">
                      {backtestResult.maxDrawdownPct !== null ? `-${backtestResult.maxDrawdownPct.toFixed(2)}%` : dict.backtestResults.notAvailable}
                    </p>
                  </div>
                </div>
                <p className="text-[11px] text-slate-500">{dict.backtestResults.disclaimer}</p>
              </>
            )
          ) : (
            <p className="text-xs text-slate-500">{dict.backtestResults.noneYet}</p>
          )}
        </div>
      )}

      {/* Exchange-koppeling */}
      <div className="card-surface flex flex-col gap-3 p-5">
        <div className="flex items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-medium text-slate-200">
              {dict.botCard.exchangeAccount}
              <InfoTooltip text={dict.botCard.exchangeAccountTooltip} />
            </p>
            {bot.exchangeConnection ? (
              <p className="mt-0.5 flex items-center gap-1 text-[11px]">
                {bot.exchangeConnection.verified ? (
                  <>
                    <ShieldCheck className="h-3 w-3 shrink-0 text-primary" />
                    <span className="text-primary">{dict.botCard.verified}</span>
                  </>
                ) : (
                  <>
                    <ShieldAlert className="h-3 w-3 shrink-0 text-amber-400" />
                    <span className="text-amber-400">{dict.botCard.notVerified}</span>
                  </>
                )}
                <span className="text-slate-500">
                  &middot; {EXCHANGE_PRESETS.find((e) => e.id === bot.exchangeConnection?.exchangeName)?.label ?? bot.exchangeConnection.exchangeName}
                </span>
              </p>
            ) : (
              <p className="mt-0.5 text-[11px] text-slate-500">{dict.botCard.noExchangeLinked}</p>
            )}
          </div>
          {bot.exchangeConnection ? (
            <div className="flex shrink-0 items-center gap-1.5">
              <button
                type="button"
                onClick={() => setIsConnectExchangeOpen(true)}
                className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-primary hover:text-primary"
              >
                {dict.botCard.replaceAccount}
              </button>
              <button
                type="button"
                onClick={handleDisconnectExchange}
                disabled={isDisconnectingExchange}
                className="flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-slate-300 transition hover:border-red-500/50 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {isDisconnectingExchange ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}
                {dict.botCard.disconnectAccount}
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setIsConnectExchangeOpen(true)}
              className="flex shrink-0 items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[11px] font-semibold text-background transition hover:bg-primary-hover"
            >
              <Link2 className="h-3 w-3" />
              {dict.botCard.connectAccount}
            </button>
          )}
        </div>

        {isConnectExchangeOpen && (
          <ConnectExchangeDialog
            botId={bot.id}
            botName={bot.botName}
            exchangeName={bot.exchangeName}
            onConnected={(connection) => onUpdate({ ...bot, exchangeConnection: connection })}
            onClose={() => setIsConnectExchangeOpen(false)}
          />
        )}
      </div>

      {/* Instellingen: auto-compound, training, upload, download, deploy */}
      <div className="card-surface flex flex-col gap-4 p-5">
        <div className="flex items-center justify-between gap-3 rounded-lg bg-background px-3 py-2">
          <div className="min-w-0">
            <p className="text-xs font-medium text-slate-200">{dict.botCard.autoCompound}</p>
            <p className="text-[11px] text-slate-500">{dict.botCard.autoCompoundHint}</p>
          </div>
          <Switch
            checked={optimisticAutoCompound ?? bot.autoCompound}
            onChange={handleAutoCompoundChange}
            disabled={isTogglingAutoCompound}
            aria-label={dict.botCard.autoCompound}
          />
        </div>

        <div className="space-y-2 rounded-lg border border-border p-3">
          {isTauri() ? (
            bot.strategyType === "FREQAI" ? (
              <>
                <button
                  type="button"
                  onClick={() => handleStartLocalTraining()}
                  disabled={isTrainingLocally}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 px-3 py-2 text-xs font-medium text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isTrainingLocally ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Laptop className="h-3.5 w-3.5" />}
                  {isTrainingLocally ? dict.botCard.trainingLocally : dict.botCard.startLocalTraining}
                </button>
                {isTrainingLocally && trainingStatus && (
                  <p className="truncate text-center text-[11px] text-slate-500" title={trainingStatus}>
                    {trainingStatus.replace(/^=== | ===$/g, "")}
                  </p>
                )}
                {!isTrainingLocally && (
                  <button
                    type="button"
                    onClick={() => handleStartLocalTraining(true)}
                    className="w-full text-center text-[11px] text-slate-500 transition hover:text-primary"
                  >
                    {dict.botCard.retrainLocally}
                  </button>
                )}
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleRunLocalBacktest}
                  disabled={isBacktesting}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 px-3 py-2 text-xs font-medium text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isBacktesting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <BarChart3 className="h-3.5 w-3.5" />}
                  {isBacktesting
                    ? dict.backtestResults.running
                    : backtestResult
                      ? dict.backtestResults.rerunBacktest
                      : dict.backtestResults.runBacktest}
                </button>
                {isBacktesting && backtestStatus && (
                  <p className="truncate text-center text-[11px] text-slate-500" title={backtestStatus}>
                    {backtestStatus.replace(/^=== | ===$/g, "")}
                  </p>
                )}
              </>
            )
          ) : (
            <p className="rounded-lg bg-background px-3 py-2 text-[11px] text-slate-500">
              {bot.strategyType === "FREQAI" ? dict.botCard.localTrainingNeedsApp : dict.backtestResults.needsApp}
            </p>
          )}
        </div>

        {/* No model to upload for a rule-based bot — it has no .joblib,
            ever (see StrategyType in prisma/schema.prisma). */}
        {bot.strategyType === "FREQAI" && (
          <div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".joblib"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) handleFileSelected(file);
              }}
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={isUploading}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border px-3 py-2 text-xs font-medium text-slate-300 transition hover:border-primary hover:text-primary disabled:opacity-50"
            >
              {isUploading ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : bot.aiModelPath ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-primary" />
              ) : (
                <Upload className="h-3.5 w-3.5" />
              )}
              {bot.aiModelPath ? dict.botCard.modelUploaded : dict.botCard.orUploadManually}
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={handleDownloadConfig}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-border px-3 py-2 text-xs font-medium text-slate-200 transition hover:border-primary hover:text-primary"
          >
            <Download className="h-3.5 w-3.5" />
            {dict.botCard.localConfig}
          </button>
          <button
            type="button"
            onClick={handleDeploy}
            disabled={isDeploying || bot.deploymentStatus === "VPS_ACTIVE" || !bot.aiModelPath}
            title={!bot.aiModelPath && bot.deploymentStatus !== "VPS_ACTIVE" ? dict.botCard.deployNeedsModel : undefined}
            className="flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-background transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isDeploying ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Rocket className="h-3.5 w-3.5" />}
            {bot.deploymentStatus === "VPS_ACTIVE" ? dict.botCard.deployed : dict.botCard.deployToCloud}
          </button>
        </div>

        {bot.deploymentStatus === "VPS_ACTIVE" && !apiCredentials && (
          <button
            type="button"
            onClick={handleRevealCredentials}
            disabled={isRevealingCredentials}
            className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500 transition hover:text-primary disabled:opacity-50"
          >
            {isRevealingCredentials ? <Loader2 className="h-3 w-3 animate-spin" /> : <KeyRound className="h-3 w-3" />}
            {dict.botCard.showCredentials}
          </button>
        )}

        {apiCredentials && (
          <div className="space-y-2 rounded-lg border border-primary/30 bg-primary/5 p-3 text-[11px]">
            <p className="text-slate-300">{dict.botCard.apiCredentialsHint(bot.hetznerServerIp ?? "?")}</p>
            <CredentialRow
              label={dict.botCard.username}
              value={apiCredentials.username}
              field="username"
              onCopy={handleCopy}
              copied={copiedField === "username"}
              copyLabel={dict.botCard.copyLabel(dict.botCard.username)}
            />
            <CredentialRow
              label={dict.botCard.password}
              value={apiCredentials.password}
              field="password"
              onCopy={handleCopy}
              copied={copiedField === "password"}
              copyLabel={dict.botCard.copyLabel(dict.botCard.password)}
            />
          </div>
        )}
      </div>

      <BotTradesPanel botId={bot.id} isPaperTrading={bot.isPaperTrading} isDeployed={bot.deploymentStatus === "VPS_ACTIVE"} />

      <button
        type="button"
        onClick={handleDelete}
        disabled={isDeleting}
        className="flex items-center justify-center gap-1.5 self-start text-[11px] text-slate-500 transition hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
      >
        {isDeleting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
        {dict.botCard.removeBot}
      </button>
    </div>
  );
}

interface CredentialRowProps {
  label: string;
  value: string;
  field: "username" | "password";
  copied: boolean;
  onCopy: (field: "username" | "password", value: string) => void;
  copyLabel: string;
}

function CredentialRow({ label, value, field, copied, onCopy, copyLabel }: CredentialRowProps) {
  return (
    <div className="flex items-center justify-between gap-2 rounded-md bg-background px-2 py-1.5">
      <div className="min-w-0">
        <div className="text-slate-500">{label}</div>
        <div className="truncate font-mono text-slate-200">{value}</div>
      </div>
      <button
        type="button"
        onClick={() => onCopy(field, value)}
        className="shrink-0 rounded-md border border-border p-1.5 text-slate-400 transition hover:border-primary hover:text-primary"
        title={copyLabel}
      >
        {copied ? <Check className="h-3 w-3 text-primary" /> : <Copy className="h-3 w-3" />}
      </button>
    </div>
  );
}
