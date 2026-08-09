import { Prisma } from "@prisma/client";
import type { BotConfigurationDTO } from "@/lib/types";
import type { FreqAIProfileConfig } from "@/lib/strategy-presets";

// Shared Prisma `select` for every route/page that returns a bot to the
// client, so the DTO shape (including the latest training job) stays
// consistent across GET/POST /api/bots, PATCH /api/bots/[id], and the
// dashboard server component.
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
  trainingMode: true,
  createdAt: true,
  trainingJobs: {
    orderBy: { createdAt: "desc" },
    take: 1,
    select: {
      id: true,
      status: true,
      mode: true,
      errorMessage: true,
      createdAt: true,
      trainedPairs: true,
      candidatePairs: true,
    },
  },
} satisfies Prisma.BotConfigurationSelect;

type BotWithTrainingJobs = Prisma.BotConfigurationGetPayload<{ select: typeof botSelect }>;

// Same comma-separated-string convention as BotConfiguration.pairWhitelist
// — see TrainingJob.trainedPairs/candidatePairs in prisma/schema.prisma.
function splitPairs(value: string | null): string[] | null {
  if (!value) return null;
  return value
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
}

// Flattens the `trainingJobs: [latest]` array (from `take: 1`) into a
// single `latestTrainingJob` field for the client-facing DTO. freqaiConfig
// is stored as Prisma's broad JsonValue — cast to the specific shape here,
// at the one place raw DB rows become the app-wide DTO, rather than at
// every call site.
export function toBotDTO(bot: BotWithTrainingJobs): BotConfigurationDTO {
  const { trainingJobs, freqaiConfig, ...rest } = bot;
  const latest = trainingJobs[0];
  return {
    ...rest,
    freqaiConfig: freqaiConfig as unknown as FreqAIProfileConfig,
    latestTrainingJob: latest
      ? { ...latest, trainedPairs: splitPairs(latest.trainedPairs), candidatePairs: splitPairs(latest.candidatePairs) }
      : null,
  };
}
