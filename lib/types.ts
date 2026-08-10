import type { FreqAIProfileConfig } from "@/lib/strategy-presets";

export type DeploymentStatus = "LOCAL" | "VPS_ACTIVE" | "INACTIVE";
export type TrainingMode = "LOCAL" | "CLOUD";
export type TrainingStatus = "QUEUED" | "TRAINING" | "COMPLETED" | "FAILED" | "CANCELLED";
// "Try before you risk": every bot is born (and stays) in
// TRAINING_PAPER_TRADE until it clears the Go Live flow — see the enum
// doc comment in prisma/schema.prisma for the full state machine.
export type BotStatus =
  | "TRAINING_PAPER_TRADE"
  | "TRAINING"
  | "LIVE_TRADING"
  | "UPDATING_MODEL"
  | "ERROR"
  | "PAUSED_EMERGENCY"
  | "SLEEPING"
  | "PAUSED_MANUAL";

export interface TrainingJobDTO {
  id: string;
  status: TrainingStatus;
  mode: TrainingMode;
  errorMessage: string | null;
  createdAt: string | Date;
}

export interface ExchangeConnectionDTO {
  id: string;
  botId: string;
  exchangeName: string;
  isActive: boolean;
  verified: boolean;
  createdAt: string | Date;
}

export interface BotConfigurationDTO {
  id: string;
  botName: string;
  // Null until the user connects a real exchange account (see
  // exchangeConnection below) — no exchange is chosen at bot-creation time
  // anymore. Set (and immutable) once exchangeConnection first exists.
  exchangeName: string | null;
  // This bot's own linked account (see prisma/schema.prisma
  // ExchangeConnection) — null until the user connects one. Never required
  // for training or paper trading, only for going live (see
  // app/api/bots/[id]/golive), and only once `verified` is true.
  exchangeConnection: { id: string; exchangeName: string; verified: boolean } | null;
  strategy: string;
  strategyCode: string;
  freqaiConfig: FreqAIProfileConfig;
  autoSelectCoins: boolean;
  pairWhitelist: string | null;
  totalBudget: number | null;
  maxStakePercentage: number | null;
  isPaperTrading: boolean;
  autoCompound: boolean;
  deploymentStatus: DeploymentStatus;
  aiModelPath: string | null;
  hetznerServerIp: string | null;
  apiServerUsername: string | null;
  status: BotStatus;
  lastError: string | null;
  trainingMode: TrainingMode;
  latestTrainingJob: TrainingJobDTO | null;
  createdAt: string | Date;
}
