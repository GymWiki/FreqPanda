"use client";

import { useEffect, useState } from "react";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";
import type { Dictionary } from "@/lib/i18n/dictionary";

interface TrainingProgressBarProps {
  jobId: string;
}

type TrainingStage = "QUEUED" | "BOOTED" | "PULLING_IMAGE" | "DOWNLOADING_DATA" | "TRAINING" | "UPLOADING" | "DONE";

interface TrainingStatusResponse {
  jobId: string;
  status: "QUEUED" | "TRAINING" | "COMPLETED" | "FAILED" | "CANCELLED";
  stage: TrainingStage;
  percentComplete: number;
  elapsedSeconds: number;
  estimatedRemainingSeconds: number | null;
  errorMessage: string | null;
}

function stageLabels(dict: Dictionary): Record<TrainingStage, string> {
  return {
    QUEUED: dict.trainingProgress.stageQueued,
    BOOTED: dict.trainingProgress.stageBooted,
    PULLING_IMAGE: dict.trainingProgress.stagePullingImage,
    DOWNLOADING_DATA: dict.trainingProgress.stageDownloadingData,
    TRAINING: dict.trainingProgress.stageTraining,
    UPLOADING: dict.trainingProgress.stageUploading,
    DONE: dict.trainingProgress.stageDone,
  };
}

const POLL_INTERVAL_MS = 4000;

function formatDuration(dict: Dictionary, seconds: number): string {
  if (seconds < 60) return dict.trainingProgress.durationSeconds(Math.max(0, Math.round(seconds)));
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return dict.trainingProgress.durationMinutes(minutes);
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return dict.trainingProgress.durationHoursMinutes(hours, restMinutes);
}

// Polls GET /api/train/cloud/status (see that route for how percent/ETA are
// derived — real stage checkpoints blended with a time-based estimate,
// freqtrade's own training command has no finer-grained progress to poll)
// every few seconds while a job is in flight. Deliberately its own,
// faster-than-the-fleet-list poll loop: BotFleetGrid already refetches
// /api/bots every 10s to eventually flip jobActive false, but this bar
// gets to "voltooid"/"mislukt" sooner by checking the one job it actually
// cares about directly, then just stops polling — the parent's own poll
// unmounts this component shortly after anyway once bot.latestTrainingJob
// catches up.
export function TrainingProgressBar({ jobId }: TrainingProgressBarProps) {
  const dict = useDictionary();
  const [data, setData] = useState<TrainingStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let intervalId: ReturnType<typeof setInterval> | null = null;

    async function poll() {
      try {
        const result = await apiFetch<TrainingStatusResponse>(
          `/api/train/cloud/status?jobId=${encodeURIComponent(jobId)}`,
          { signal: controller.signal },
        );
        setData(result);
        setError(null);
        // CANCELLED here covers the (rare) case of another tab/device
        // stopping this same job — the tab that actually clicked "Stop
        // training" already stops polling immediately via its own onUpdate,
        // see BotCard's handleStopTraining.
        if ((result.status === "COMPLETED" || result.status === "FAILED" || result.status === "CANCELLED") && intervalId) {
          clearInterval(intervalId);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(toErrorMessage(err, dict.trainingProgress.loadFailed));
      }
    }

    poll();
    intervalId = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      controller.abort();
      if (intervalId) clearInterval(intervalId);
    };
  }, [jobId]);

  if (!data) {
    // First poll still in flight, or it failed before ever landing — a
    // one-line error is enough here, the button above already carries the
    // spinner/disabled state.
    return error ? <p className="text-[11px] text-slate-500">{error}</p> : null;
  }

  const isDone = data.status === "COMPLETED";
  const isFailed = data.status === "FAILED";
  const isCancelled = data.status === "CANCELLED";
  const isTerminalWithIssue = isFailed || isCancelled;

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-[11px]">
        <span className={isFailed ? "text-red-400" : isCancelled ? "text-slate-400" : isDone ? "text-primary" : "text-slate-400"}>
          {isFailed ? dict.trainingProgress.failed : isCancelled ? dict.trainingProgress.cancelled : stageLabels(dict)[data.stage]}
        </span>
        <span className="tabular-nums text-slate-500">{isDone ? 100 : data.percentComplete}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-background" role="progressbar" aria-valuenow={isDone ? 100 : data.percentComplete} aria-valuemin={0} aria-valuemax={100}>
        <div
          className={`h-full rounded-full transition-all duration-500 ${isFailed ? "bg-red-500" : isCancelled ? "bg-slate-500" : "bg-primary"}`}
          style={{ width: `${isDone ? 100 : data.percentComplete}%` }}
        />
      </div>
      {!isDone && !isTerminalWithIssue && data.estimatedRemainingSeconds !== null && (
        <p className="text-[11px] text-slate-500">
          {dict.trainingProgress.remaining(formatDuration(dict, data.estimatedRemainingSeconds))}
        </p>
      )}
      {/* Downloading market data for a bot with automatic coin selection can
          realistically take up to ~2 hours (every active USDT pair on the
          exchange, not only the pairs eventually traded) — without this
          note a percentage that barely moves for a while quickly reads as
          stuck. */}
      {!isDone && !isTerminalWithIssue && data.stage === "DOWNLOADING_DATA" && (
        <p className="text-[11px] text-slate-500">{dict.trainingProgress.longRunningHint}</p>
      )}
      {/* Full message, wrapped — never truncated. A reap/callback reason
          like "Reaped: no progress past QUEUED for over 20 minutes — ..."
          is exactly the part that explains what happened. */}
      {isTerminalWithIssue && data.errorMessage && (
        <p className={`whitespace-pre-wrap break-words text-[11px] ${isFailed ? "text-red-400" : "text-slate-500"}`}>
          {data.errorMessage}
        </p>
      )}
    </div>
  );
}
