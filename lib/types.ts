import type { FreqAIProfileConfig } from "@/lib/strategy-presets";

export type DeploymentStatus = "LOCAL" | "VPS_ACTIVE" | "INACTIVE";
// FREQAI: the original, only-ever flow (a trained ML model, gated on a
// .joblib upload). RULE_BASED: classic indicator strategies (see
// lib/rule-based-presets.ts) — no model, only local download+backtest.
// Fixed at creation time — see StrategyType in prisma/schema.prisma.
export type StrategyType = "FREQAI" | "RULE_BASED";
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
  strategyType: StrategyType;
  // Only present when strategyType is "FREQAI" — null for a RULE_BASED bot,
  // which has no AI behavior to configure (see StrategyType above).
  freqaiConfig: FreqAIProfileConfig | null;
  autoSelectCoins: boolean;
  // Only meaningful when autoSelectCoins is true — how many top-liquid
  // USDT pairs VolumePairList should hand to FreqAI (see
  // AUTO_PAIRLIST_SIZE_RANGE in lib/hetzner.ts for the enforced range).
  autoSelectPairCount: number;
  pairWhitelist: string | null;
  totalBudget: number | null;
  maxStakePercentage: number | null;
  isPaperTrading: boolean;
  autoCompound: boolean;
  deploymentStatus: DeploymentStatus;
  aiModelPath: string | null;
  // Set whenever aiModelPath changes (see POST /api/upload) — null for a
  // bot that has never had a model uploaded. Drives the "last trained" /
  // retrain-recommended block on the bot detail page (see
  // lib/retrain-advice.ts).
  aiModelUploadedAt: string | Date | null;
  hetznerServerIp: string | null;
  apiServerUsername: string | null;
  status: BotStatus;
  lastError: string | null;
  createdAt: string | Date;
}
