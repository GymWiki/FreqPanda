import type { BotConfigurationDTO } from "@/lib/types";

// The "am I ready to use, or is something happening?" answer the user
// actually wants at a glance — distinct from BotStatus (prisma/schema.prisma),
// which encodes finer-grained trading-loop state (see lib/bot-status.ts)
// that on its own doesn't say whether a model has ever been trained, or
// whether "TRAINING_PAPER_TRADE" means "currently paper trading" vs. "was
// created but never deployed". Derived, never stored — always computed
// fresh from the same BotConfigurationDTO fields the rest of the UI
// already has, so there's no second source of truth to drift out of sync.
export type BotLifecycleStatus =
  | "NOT_TRAINED"
  | "TRAINING"
  | "READY"
  | "ACTIVE_PAPER"
  | "ACTIVE_LIVE"
  | "PAUSED_MANUAL"
  | "PAUSED_EMERGENCY"
  | "SLEEPING"
  | "ERROR";

// isTrainingLocally is passed in rather than read from bot.status because
// local training (src-tauri's train_local_model) is a purely client-side,
// in-progress desktop-app action — it has no server-side BotStatus of its
// own until the resulting model gets uploaded. bot.status TRAINING/
// UPDATING_MODEL is the *other* kind of "training" this same badge must
// also catch: a deployed bot retraining itself on its own VPS, reported
// back via POST /api/bots/[id]/status.
export function deriveLifecycleStatus(
  bot: Pick<BotConfigurationDTO, "aiModelPath" | "deploymentStatus" | "status" | "isPaperTrading">,
  isTrainingLocally: boolean,
): BotLifecycleStatus {
  if (isTrainingLocally || bot.status === "TRAINING" || bot.status === "UPDATING_MODEL") return "TRAINING";
  if (bot.status === "ERROR") return "ERROR";
  if (bot.status === "PAUSED_EMERGENCY") return "PAUSED_EMERGENCY";
  if (bot.status === "SLEEPING") return "SLEEPING";
  if (bot.status === "PAUSED_MANUAL") return "PAUSED_MANUAL";
  if (bot.deploymentStatus === "VPS_ACTIVE") return bot.isPaperTrading ? "ACTIVE_PAPER" : "ACTIVE_LIVE";
  return bot.aiModelPath ? "READY" : "NOT_TRAINED";
}
