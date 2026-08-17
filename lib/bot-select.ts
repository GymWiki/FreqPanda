import { Prisma } from "@prisma/client";
import type { BotConfigurationDTO } from "@/lib/types";
import type { FreqAIProfileConfig } from "@/lib/strategy-presets";

// Shared Prisma `select` for every route/page that returns a bot to the
// client, so the DTO shape stays consistent across GET/POST /api/bots,
// PATCH /api/bots/[id], and the dashboard server component.
export const botSelect = {
  id: true,
  botName: true,
  exchangeName: true,
  exchangeConnection: {
    select: { id: true, exchangeName: true, verified: true },
  },
  strategy: true,
  strategyCode: true,
  freqaiConfig: true,
  autoSelectCoins: true,
  autoSelectPairCount: true,
  pairWhitelist: true,
  totalBudget: true,
  maxStakePercentage: true,
  isPaperTrading: true,
  autoCompound: true,
  deploymentStatus: true,
  aiModelPath: true,
  hetznerServerIp: true,
  apiServerUsername: true,
  status: true,
  lastError: true,
  createdAt: true,
} satisfies Prisma.BotConfigurationSelect;

type BotRow = Prisma.BotConfigurationGetPayload<{ select: typeof botSelect }>;

// freqaiConfig is stored as Prisma's broad JsonValue — cast to the specific
// shape here, at the one place raw DB rows become the app-wide DTO, rather
// than at every call site.
export function toBotDTO(bot: BotRow): BotConfigurationDTO {
  const { freqaiConfig, ...rest } = bot;
  return {
    ...rest,
    freqaiConfig: freqaiConfig as unknown as FreqAIProfileConfig,
  };
}
