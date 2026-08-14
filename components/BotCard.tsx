"use client";

import { useEffect, useRef, useState } from "react";
import {
  Download,
  Rocket,
  Upload,
  Loader2,
  CheckCircle2,
  Trash2,
  Cloud,
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
  XCircle,
} from "lucide-react";
import type { BotConfigurationDTO, ExchangeConnectionDTO, TrainingStatus } from "@/lib/types";
import { StatusBadge, TrainingStatusBadge } from "@/components/ui/StatusBadge";
import { TrainingModeToggle } from "@/components/ui/Toggle";
import { GoLiveModal } from "@/components/GoLiveModal";
import { ConnectExchangeDialog } from "@/components/ConnectExchangeDialog";
import { TradeHistoryFeed } from "@/components/TradeHistoryFeed";
import { TrainingProgressBar } from "@/components/TrainingProgressBar";
import { Switch } from "@/components/ui/Switch";
import { EXCHANGE_PRESETS } from "@/lib/exchange-presets";
import { DEFAULT_PAPER_TOTAL_BUDGET, DEFAULT_PAPER_MAX_STAKE_PERCENTAGE } from "@/lib/paper-trading-defaults";
import { isTauri } from "@/lib/tauri";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";
import { InfoTooltip } from "@/components/ui/Tooltip";

interface BotCardProps {
  bot: BotConfigurationDTO;
  onUpdate: (bot: BotConfigurationDTO) => void;
  onDelete: (id: string) => void;
}

export function BotCard({ bot, onUpdate, onDelete }: BotCardProps) {
  const dict = useDictionary();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [isDeploying, setIsDeploying] = useState(false);
  const [isTrainingLocally, setIsTrainingLocally] = useState(false);
  const [isStartingCloudTraining, setIsStartingCloudTraining] = useState(false);
  const [isStoppingTraining, setIsStoppingTraining] = useState(false);
  const [isRevealingCredentials, setIsRevealingCredentials] = useState(false);
  const [apiCredentials, setApiCredentials] = useState<{ username: string; password: string } | null>(null);
  const [copiedField, setCopiedField] = useState<"username" | "password" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isGoLiveOpen, setIsGoLiveOpen] = useState(false);
  const [isTogglingTrainingMode, setIsTogglingTrainingMode] = useState(false);
  const [isTogglingAutoCompound, setIsTogglingAutoCompound] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isResuming, setIsResuming] = useState(false);
  const [isStopping, setIsStopping] = useState(false);
  const [isConnectExchangeOpen, setIsConnectExchangeOpen] = useState(false);
  const [isDisconnectingExchange, setIsDisconnectingExchange] = useState(false);
  // Only set once the start-cloud-training call actually succeeds (not on
  // the click itself) — see handleStartCloudTraining. Auto-dismisses after
  // a few seconds; the persistent, ongoing signal is TrainingProgressBar
  // below, this is just the one-shot "yep, it started" confirmation.
  const [justStartedCloudTraining, setJustStartedCloudTraining] = useState(false);
  const justStartedCloudTrainingTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Optimistic overrides for the two network-backed toggles below: bot.X
  // only changes once the parent re-renders with a fresh prop after
  // onUpdate, which used to leave the switch visually frozen in its old
  // position for the whole PATCH round-trip. Set on click, cleared once
  // that PATCH settles (success or failure) — cleared, not left set, so a
  // failed request correctly snaps back to the real bot.X value rather
  // than getting stuck showing a change that was never actually saved.
  const [optimisticTrainingMode, setOptimisticTrainingMode] = useState<"LOCAL" | "CLOUD" | null>(null);
  const [optimisticAutoCompound, setOptimisticAutoCompound] = useState<boolean | null>(null);
  // React's `disabled` prop on the toggle only takes effect on the render
  // *after* the state update that sets isToggling*, so a fast double-click
  // (or a click event firing twice for any other reason) can still reach
  // this handler a second time before that re-render commits. A ref is
  // read/written synchronously, immune to that timing gap, so it's the
  // actual guard against a double-fire — isToggling* alone (disabling the
  // button) is a courtesy for slow networks, not a correctness guarantee.
  const trainingModeInFlight = useRef(false);
  const autoCompoundInFlight = useRef(false);

  const jobActive = bot.latestTrainingJob?.status === "QUEUED" || bot.latestTrainingJob?.status === "TRAINING";
  const canGoLive = bot.status === "TRAINING_PAPER_TRADE" && bot.deploymentStatus === "VPS_ACTIVE";
  const isPaused = bot.status === "PAUSED_EMERGENCY" || bot.status === "SLEEPING" || bot.status === "PAUSED_MANUAL";
  // Only this bot's own, currently-running trading loop can be stopped —
  // matches exactly what POST /api/bots/[id]/stop itself requires.
  const canStop =
    bot.deploymentStatus === "VPS_ACTIVE" && (bot.status === "TRAINING_PAPER_TRADE" || bot.status === "LIVE_TRADING");

  useEffect(() => {
    return () => {
      if (justStartedCloudTrainingTimeout.current) clearTimeout(justStartedCloudTrainingTimeout.current);
    };
  }, []);

  // Clears PAUSED_EMERGENCY (Panic Button), SLEEPING (Sleep Mode), or
  // PAUSED_MANUAL (Stop bot, below) — the only place any of the three is
  // ever cleared, see app/api/bots/[id]/resume.
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

  // Stops just this bot — no new positions open, existing ones keep
  // running untouched (see app/api/bots/[id]/stop for the exact
  // guarantee). Deliberately a plain confirm(), matching the weight
  // handleDisconnectExchange already uses for a reversible single-bot
  // action, unlike the heavier custom modal the global Panic Button (a
  // real-money, force-close action across every bot) warrants.
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

  async function handleTrainingModeChange(trainingMode: "LOCAL" | "CLOUD") {
    if (trainingModeInFlight.current) return;
    trainingModeInFlight.current = true;
    setError(null);
    setIsTogglingTrainingMode(true);
    setOptimisticTrainingMode(trainingMode);
    try {
      const data = await apiFetch<{ bot: BotConfigurationDTO }>(`/api/bots/${bot.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trainingMode }),
      });
      onUpdate(data.bot);
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.trainingModeUpdateFailed));
    } finally {
      setOptimisticTrainingMode(null);
      setIsTogglingTrainingMode(false);
      trainingModeInFlight.current = false;
    }
  }

  // Only flips the DB flag — the next (re)deploy is what actually reads it
  // into config.json (see lib/deploy-bot.ts, lib/hetzner.ts), same as a
  // totalBudget change via Go Live.
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
      onUpdate({ ...bot, aiModelPath: data.aiModelPath });
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.uploadFailed));
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  }

  // Mode A (local): Rust spawns the FreqAI child process and hands back the
  // path of the one resulting .joblib file. Everything after that reuses
  // the exact same upload flow as a manual file pick — no separate
  // auth/upload path in Rust, since this JS runs inside the same
  // authenticated dashboard session whether it's a browser tab or the
  // Tauri webview.
  async function handleStartLocalTraining() {
    setError(null);
    setIsTrainingLocally(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const { readFile } = await import("@tauri-apps/plugin-fs");

      const modelPath = await invoke<string>("train_local_model", {
        botId: bot.id,
        strategy: bot.strategy,
        strategyCode: bot.strategyCode,
        // Rust's own train_local_model ignores this anyway — see
        // DATA_SOURCE_EXCHANGE in src-tauri/src/main.rs — but the Tauri
        // command's String param can't take null, and a bot may not have
        // an exchange yet (see prisma/schema.prisma).
        exchangeName: bot.exchangeName ?? "",
        autoSelectCoins: bot.autoSelectCoins,
        pairWhitelist: bot.pairWhitelist ?? "",
      });

      const bytes = await readFile(modelPath);
      const filename = modelPath.split(/[\\/]/).pop() ?? `${bot.botName}-model.joblib`;
      const file = new File([new Uint8Array(bytes)], filename, { type: "application/octet-stream" });
      await handleFileSelected(file);
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.localTrainingFailed));
    } finally {
      setIsTrainingLocally(false);
    }
  }

  // Mode B (cloud): fire-and-forget — the VM reports back on its own via
  // /api/train/cloud/callback. BotFleetGrid polls while a job is active and
  // will push the updated status into this card's props. Historical market
  // data is no longer fetched client-side at all — for an auto-select bot,
  // the VM rsyncs it directly from the permanent data server over SSH (see
  // rsyncDataScript / buildDataServerCloudInit in lib/hetzner.ts) — so this
  // click is simple again: just start the job.
  async function handleStartCloudTraining() {
    setError(null);
    setIsStartingCloudTraining(true);
    try {
      const data = await apiFetch<{ job: { id: string; status: TrainingStatus; createdAt: string } }>(
        "/api/train/cloud",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ botId: bot.id }),
        },
      );
      onUpdate({
        ...bot,
        trainingMode: "CLOUD",
        latestTrainingJob: {
          id: data.job.id,
          status: data.job.status,
          mode: "CLOUD",
          errorMessage: null,
          createdAt: data.job.createdAt,
        },
      });
      // Only reachable once the call above actually succeeded — a click
      // that fails (network error, busy bot, etc.) hits the catch below
      // and never shows this.
      setJustStartedCloudTraining(true);
      if (justStartedCloudTrainingTimeout.current) clearTimeout(justStartedCloudTrainingTimeout.current);
      justStartedCloudTrainingTimeout.current = setTimeout(() => setJustStartedCloudTraining(false), 6000);
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.cloudTrainingFailed));
    } finally {
      setIsStartingCloudTraining(false);
    }
  }

  // Cancels the in-flight Cloud Training job and deletes its Hetzner server
  // (see POST /api/train/cloud/stop, which reuses the same
  // deleteHetznerServer() the reap cron uses). Returns the fresh bot DTO —
  // its latestTrainingJob.status flips to CANCELLED, which is enough on its
  // own to flip jobActive false below and unmount TrainingProgressBar, so
  // there's nothing extra to do here to "stop polling".
  async function handleStopTraining() {
    if (!bot.latestTrainingJob) return;
    if (!confirm(dict.botCard.confirmStopTraining)) {
      return;
    }
    setError(null);
    setIsStoppingTraining(true);
    try {
      const data = await apiFetch<{ bot: BotConfigurationDTO }>("/api/train/cloud/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId: bot.latestTrainingJob.id }),
      });
      onUpdate(data.bot);
    } catch (err) {
      setError(toErrorMessage(err, dict.botCard.stopTrainingFailed));
    } finally {
      setIsStoppingTraining(false);
    }
  }

  function handleDownloadConfig() {
    const config = {
      bot_name: bot.botName,
      exchange: bot.exchangeName,
      strategy: bot.strategy,
      auto_select_coins: bot.autoSelectCoins,
      pair_whitelist: bot.autoSelectCoins
        ? null
        : bot.pairWhitelist?.split(",").map((p) => p.trim()) ?? null,
      pairlist_method: bot.autoSelectCoins ? "VolumePairList (top 30 USDT by volume)" : "StaticPairList",
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
    setIsDeploying(true);
    try {
      const data = await apiFetch<{
        requiresCheckout: boolean;
        checkoutUrl?: string;
        bot?: BotConfigurationDTO;
        apiCredentials?: { username: string; password: string };
      }>("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ botId: bot.id }),
      });

      if (data.requiresCheckout) {
        if (data.checkoutUrl) window.location.href = data.checkoutUrl;
        return;
      }
      if (data.bot) onUpdate(data.bot);
      if (data.apiCredentials) setApiCredentials(data.apiCredentials);
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
      onDelete(bot.id);
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
    <div className="card-surface flex flex-col gap-4 p-5">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="font-semibold">{bot.botName}</h3>
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

      <div className="flex items-center justify-between gap-3 rounded-lg bg-background px-3 py-2">
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
        {/* isPaperTrading (not bot.status) drives this label — status now
            also covers pause states (PAUSED_EMERGENCY/SLEEPING) that don't
            imply a mode switch, so it can't double as "which mode" there.
            PAUSED_MANUAL is the one exception: the user explicitly asked
            this pill itself to read "Gestopt" instead of "Paper Trading"/
            "Live Trading" while a bot is individually stopped. */}
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

      {justStartedCloudTraining && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2.5 text-xs font-medium text-primary">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          {dict.botCard.cloudTrainingStarted(bot.botName)}
        </div>
      )}

      <div className="space-y-2 rounded-lg border border-border p-3">
        <TrainingModeToggle
          mode={optimisticTrainingMode ?? bot.trainingMode}
          onChange={handleTrainingModeChange}
          disabled={jobActive || isTogglingTrainingMode}
        />

        {bot.latestTrainingJob && (
          <div className="flex flex-col gap-1.5">
            <TrainingStatusBadge status={bot.latestTrainingJob.status} />
            {/* Full message, wrapped — never truncated. These reap/callback
                reasons ("Reaped: no progress past QUEUED for over 20
                minutes — ...") are exactly the part that explains what
                happened, so cutting them off with an ellipsis defeated the
                point of showing them at all. */}
            {bot.latestTrainingJob.status === "FAILED" && bot.latestTrainingJob.errorMessage && (
              <p className="whitespace-pre-wrap break-words text-[11px] text-red-400">
                {bot.latestTrainingJob.errorMessage}
              </p>
            )}
          </div>
        )}

        {bot.trainingMode === "CLOUD" ? (
          <>
            <button
              type="button"
              onClick={handleStartCloudTraining}
              disabled={isStartingCloudTraining || jobActive}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 px-3 py-2 text-xs font-medium text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isStartingCloudTraining || jobActive ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Cloud className="h-3.5 w-3.5" />
              )}
              {jobActive ? dict.botCard.trainingInCloud : dict.botCard.startCloudTraining}
            </button>
            {/* Own polling loop, distinct from BotFleetGrid's slower
                fleet-wide refresh — see that component's doc comment. */}
            {jobActive && bot.latestTrainingJob && (
              <>
                <TrainingProgressBar jobId={bot.latestTrainingJob.id} />
                <button
                  type="button"
                  onClick={handleStopTraining}
                  disabled={isStoppingTraining}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-red-500/40 px-3 py-2 text-xs font-medium text-red-400 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {isStoppingTraining ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <XCircle className="h-3.5 w-3.5" />}
                  {isStoppingTraining ? dict.botCard.stoppingTraining : dict.botCard.stopTraining}
                </button>
              </>
            )}
          </>
        ) : isTauri() ? (
          <button
            type="button"
            onClick={handleStartLocalTraining}
            disabled={isTrainingLocally}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-primary/40 px-3 py-2 text-xs font-medium text-primary transition hover:bg-primary/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isTrainingLocally ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Laptop className="h-3.5 w-3.5" />}
            {isTrainingLocally ? dict.botCard.trainingLocally : dict.botCard.startLocalTraining}
          </button>
        ) : (
          <p className="rounded-lg bg-background px-3 py-2 text-[11px] text-slate-500">
            {dict.botCard.localTrainingNeedsApp}
          </p>
        )}
      </div>

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

      {error && <p className="text-xs text-red-400">{error}</p>}

      {bot.deploymentStatus === "VPS_ACTIVE" && <TradeHistoryFeed botId={bot.id} />}

      <div className="mt-auto grid grid-cols-2 gap-2 pt-1">
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
          disabled={isDeploying || bot.deploymentStatus === "VPS_ACTIVE"}
          className="flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-background transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isDeploying ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Rocket className="h-3.5 w-3.5" />
          )}
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
          {isRevealingCredentials ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <KeyRound className="h-3 w-3" />
          )}
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

      <button
        type="button"
        onClick={handleDelete}
        disabled={isDeleting}
        className="flex items-center justify-center gap-1.5 text-[11px] text-slate-500 transition hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
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
