"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { BotConfigurationDTO } from "@/lib/types";
import { isTauri } from "@/lib/tauri";
import { apiFetch } from "@/lib/api-client";
import { toFriendlyProgressLine } from "@/lib/training-error-messages";

const POLL_INTERVAL_MS = 5000;

type SyncedBot = Pick<
  BotConfigurationDTO,
  "id" | "strategy" | "strategyCode" | "exchangeName" | "autoSelectCoins" | "autoSelectPairCount" | "pairWhitelist" | "aiModelPath"
>;

interface UseLocalTrainingSyncResult {
  isTrainingLocally: boolean;
  trainingStatusLine: string | null;
  startLocalTraining: (forceRetrain?: boolean) => Promise<void>;
}

// Single source of truth for "is this bot's local FreqAI training actually
// running or done right now" — shared by the compact dashboard card
// (BotCard.tsx) and the bot detail page (BotDetailView.tsx) so the two can
// never disagree with each other or with reality.
//
// This closes a real status-sync bug: both components used to run their
// OWN copy of a check-once-on-mount effect against local_training_status.
// That missed two cases entirely — a training/backtest container that
// finishes while the component that started it isn't mounted anymore (the
// user navigated back to the dashboard, or closed and reopened the app),
// and one that finishes while the SAME component stays mounted but its
// one-shot check already ran. Either way the UI froze on whatever it last
// knew: "Wordt getraind..." for a run that had actually already finished,
// or "Nog nooit getraind" for a model that was sitting on disk, exited
// successfully, and simply never got collected and uploaded.
//
// Docker is the only real source of truth for local training progress —
// bot.status/bot.aiModelPath only change once a model actually finishes
// uploading (see POST /api/upload) — so this polls the read-only
// local_training_status command on an interval, not just once, and reacts
// to EVERY non-idle state the same way: reattach (train_local_model
// reattaches to a running container rather than restarting it, and
// short-circuits straight to collecting + uploading an already-produced
// .joblib for one that already exited successfully — see
// run_freqtrade_step_resumable and local_training_status's own doc
// comments in src-tauri/src/main.rs). Whichever component happens to be
// mounted when the poll notices ends up finishing the job.
export function useLocalTrainingSync(bot: SyncedBot, onModelUploaded: (result: { aiModelPath: string; aiModelUploadedAt: string }) => void): UseLocalTrainingSyncResult {
  const [isTrainingLocally, setIsTrainingLocally] = useState(false);
  const [trainingStatusLine, setTrainingStatusLine] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const botRef = useRef(bot);
  botRef.current = bot;

  const startLocalTraining = useCallback(async (forceRetrain = false) => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    setTrainingStatusLine(null);
    setIsTrainingLocally(true);

    const currentBot = botRef.current;
    const { invoke } = await import("@tauri-apps/api/core");
    const { readFile } = await import("@tauri-apps/plugin-fs");
    const { listen } = await import("@tauri-apps/api/event");

    const unlisten = await listen<{ botId: string; line: string }>("training-progress", (event) => {
      if (event.payload.botId !== currentBot.id) return;
      // Never forward a raw freqtrade/Docker log line verbatim — see
      // toFriendlyProgressLine's own doc comment. A filtered-out line
      // (returns null) just leaves the last visible line on screen a
      // little longer rather than blanking the status text.
      const friendly = toFriendlyProgressLine(event.payload.line);
      if (friendly !== null) setTrainingStatusLine(friendly);
    });

    try {
      const modelPath = await invoke<string>("train_local_model", {
        botId: currentBot.id,
        strategy: currentBot.strategy,
        strategyCode: currentBot.strategyCode,
        exchangeName: currentBot.exchangeName ?? "",
        autoSelectCoins: currentBot.autoSelectCoins,
        autoSelectPairCount: currentBot.autoSelectPairCount,
        pairWhitelist: currentBot.pairWhitelist ?? "",
        forceRetrain,
      });

      const bytes = await readFile(modelPath);
      const filename = modelPath.split(/[\\/]/).pop() ?? `${currentBot.id}-model.joblib`;
      const file = new File([new Uint8Array(bytes)], filename, { type: "application/octet-stream" });

      const formData = new FormData();
      formData.append("botId", currentBot.id);
      formData.append("file", file);
      const data = await apiFetch<{ aiModelPath: string }>("/api/upload", { method: "POST", body: formData });
      onModelUploaded({ aiModelPath: data.aiModelPath, aiModelUploadedAt: new Date().toISOString() });
    } finally {
      unlisten();
      inFlightRef.current = false;
      setIsTrainingLocally(false);
      setTrainingStatusLine(null);
    }
    // onModelUploaded is expected to be stable (useCallback/useState setter)
    // at each call site — not included so a caller re-render never tears
    // down and restarts an in-flight training attach.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Periodic reconnect check — the fix itself. Not "on mount", on an
  // interval, for as long as this bot has no uploaded model yet, so a
  // container that finishes at any point gets noticed and collected
  // within POLL_INTERVAL_MS regardless of navigation.
  useEffect(() => {
    if (!isTauri() || bot.aiModelPath) return;
    let cancelled = false;

    async function poll() {
      if (cancelled || inFlightRef.current) return;
      const { invoke } = await import("@tauri-apps/api/core");
      try {
        const status = await invoke<{ state: string }>("local_training_status", { botId: bot.id });
        if (!cancelled && status.state !== "not_started" && !inFlightRef.current) {
          startLocalTraining().catch(() => {
            // A poll-triggered reconnect failing isn't worth surfacing on
            // its own — the same failure will resurface the next time the
            // user explicitly clicks "Train" (or the next poll tick, for a
            // transient Docker hiccup), same as a failed status read above.
          });
        }
      } catch {
        // Best-effort — same as the one-shot check this replaces: a failed
        // status read just leaves things as they are until the next tick.
      }
    }

    void poll();
    const interval = setInterval(poll, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [bot.id, bot.aiModelPath, startLocalTraining]);

  return { isTrainingLocally, trainingStatusLine, startLocalTraining };
}
