import crypto from "crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { decrypt, encrypt } from "@/lib/encryption";
import { buildFreqtradeCloudInit, createHetznerServer, deleteHetznerServer } from "@/lib/hetzner";
import { botSelect, toBotDTO } from "@/lib/bot-select";
import { generateCallbackToken, hashCallbackToken } from "@/lib/training-token";
import type { FreqAIProfileConfig } from "@/lib/strategy-presets";
import { DEFAULT_PAPER_TOTAL_BUDGET, DEFAULT_PAPER_MAX_STAKE_PERCENTAGE } from "@/lib/paper-trading-defaults";
import { fetchFreeBalance } from "@/lib/ccxt-client";

// Auto-Compounding's tradable_balance_ratio must never exceed 1 (freqtrade
// itself rejects that) and is floored well above 0 so a stale/incorrect
// balance reading can't leave freqtrade with an unusably tiny allowance.
const MIN_TRADABLE_BALANCE_RATIO = 0.01;
const MAX_TRADABLE_BALANCE_RATIO = 1;

type BotRow = Prisma.BotConfigurationGetPayload<object>;

interface DeployBotParams {
  bot: BotRow;
  supabase: SupabaseClient;
}

// The single provisioning primitive behind three call sites with different
// policy: POST /api/deploy (first-ever deploy — checked for quota, billing,
// and BotStatus there before calling this), the training callback's
// resume-after-retrain path (deliberately calls this WHILE status is
// UPDATING_MODEL, since resolving that status is the whole point), and
// the Go Live flow (app/api/bots/[id]/golive, called right after flipping
// isPaperTrading to false). This function itself only asserts the one
// precondition every caller shares — a trained model must exist — never
// BotStatus, so it must not be called directly from anywhere that hasn't
// already applied the right guard. The resulting status is always derived
// from bot.isPaperTrading rather than hardcoded, so a redeploy naturally
// resumes to whichever phase (paper or live) the bot was actually in.
export async function deployBotToVps({ bot, supabase }: DeployBotParams) {
  if (!bot.aiModelPath) {
    throw new Error("Upload a trained .joblib model before deploying");
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL is not configured");

  // Training and paper trading only ever need public market data — this
  // bot's own ExchangeConnection (see prisma/schema.prisma) is genuinely
  // optional here. Only a live deploy requires one, and requires it to be
  // verified, not just present: an unverified row could hold a typo'd or
  // since-revoked key that would otherwise only surface as a cryptic
  // failure deep in a cloud-init run.
  const connection = await prisma.exchangeConnection.findUnique({ where: { botId: bot.id } });
  if (!bot.isPaperTrading && (!connection || !connection.verified)) {
    throw new Error("Koppel eerst een geldig exchange-account voordat je live gaat.");
  }
  // Narrowed, not just checked above: TypeScript can't see through the
  // early-return-less guard, and every live-only use below needs a
  // definitely-verified connection in hand.
  const liveConnection = !bot.isPaperTrading ? connection! : null;

  // Best-effort, never blocking: a bot must still deploy fine whether or
  // not the operator configured a central Telegram bot, or this user ever
  // linked a chat (see app/settings, /api/account/telegram).
  const profile = await prisma.profile.findUnique({
    where: { id: bot.userId },
    select: { telegramChatId: true },
  });

  // The "models" bucket is private, so the Hetzner VPS (which has no
  // Supabase session) needs a short-lived signed URL to fetch the file
  // during cloud-init — long enough for boot + Docker pull + download.
  const { data: signedUrlData, error: signedUrlError } = await supabase.storage
    .from("models")
    .createSignedUrl(bot.aiModelPath, 3600);
  if (signedUrlError || !signedUrlData) {
    throw new Error(`Failed to create a download URL for the model: ${signedUrlError?.message}`);
  }

  // Randomized per (re)deploy so the freqtrade REST API never ships with
  // guessable credentials, and rotated on every redeploy for good hygiene.
  const apiServerUsername = `freqtrader-${crypto.randomBytes(4).toString("hex")}`;
  const apiServerPassword = crypto.randomBytes(24).toString("base64url");
  const apiServerJwtSecret = crypto.randomBytes(32).toString("hex");
  const statusWebhookToken = generateCallbackToken();

  // Snowball mode, live only: compute how much of the *whole* exchange
  // wallet this specific bot is allowed to touch, so a real, growing
  // account balance can still never be traded beyond what the user
  // actually allocated here (see lib/hetzner.ts tradableBalanceRatio doc).
  // Paper trading skips this entirely — dry_run_wallet is already fully
  // virtual, so there's no other real balance to protect. Best-effort: a
  // failed balance read must never block a deploy, it just falls back to
  // freqtrade's own tradable_balance_ratio default.
  let tradableBalanceRatio: number | undefined;
  if (bot.autoCompound && liveConnection) {
    const budget = bot.totalBudget ?? DEFAULT_PAPER_TOTAL_BUDGET;
    try {
      const balance = await fetchFreeBalance(liveConnection.exchangeName, decrypt(liveConnection.apiKey), decrypt(liveConnection.apiSecret));
      if (balance.amount > 0) {
        tradableBalanceRatio = Math.min(
          MAX_TRADABLE_BALANCE_RATIO,
          Math.max(MIN_TRADABLE_BALANCE_RATIO, budget / balance.amount),
        );
      }
    } catch (err) {
      console.error(`[deploy-bot] Could not fetch live balance for auto-compound ratio on bot ${bot.id}:`, err);
    }
  }

  const cloudInit = buildFreqtradeCloudInit({
    botName: bot.botName.toLowerCase().replace(/[^a-z0-9-]/g, "-"),
    exchangeName: bot.exchangeName,
    // Blank for paper trading — dry-run only ever needs public market
    // data, so there's nothing to decrypt when liveConnection is null.
    exchangeApiKey: liveConnection ? decrypt(liveConnection.apiKey) : "",
    exchangeApiSecret: liveConnection ? decrypt(liveConnection.apiSecret) : "",
    strategy: bot.strategy,
    strategyCode: bot.strategyCode,
    freqaiConfig: bot.freqaiConfig as unknown as FreqAIProfileConfig,
    autoSelectCoins: bot.autoSelectCoins,
    autoSelectPairCount: bot.autoSelectPairCount,
    pairWhitelist: bot.pairWhitelist ? bot.pairWhitelist.split(",").map((p) => p.trim()).filter(Boolean) : [],
    totalBudget: bot.totalBudget ?? DEFAULT_PAPER_TOTAL_BUDGET,
    maxStakePercentage: bot.maxStakePercentage ?? DEFAULT_PAPER_MAX_STAKE_PERCENTAGE,
    isPaperTrading: bot.isPaperTrading,
    autoCompound: bot.autoCompound,
    tradableBalanceRatio,
    aiModelDownloadUrl: signedUrlData.signedUrl,
    apiServerUsername,
    apiServerPassword,
    apiServerJwtSecret,
    statusWebhookUrl: `${appUrl}/api/bots/${bot.id}/status`,
    statusWebhookToken,
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: profile?.telegramChatId ?? undefined,
  });

  // Redeploy (e.g. resuming from a pause): tear down the old VM first so
  // we never end up paying for two servers for one bot. Best effort — if
  // this fails, the old box is an orphan nothing currently cleans up,
  // which is an acceptable gap for the rare case of a mid-redeploy
  // Hetzner failure.
  if (bot.hetznerServerId) {
    try {
      await deleteHetznerServer(bot.hetznerServerId);
    } catch {
      // continue anyway — provisioning the replacement matters more than a stalled cleanup
    }
  }

  const { server } = await createHetznerServer({
    name: `bot-${bot.id}-${Date.now()}`,
    cloudInit,
    firewallProfile: "live-trading",
  });

  const updated = await prisma.botConfiguration.update({
    where: { id: bot.id },
    data: {
      deploymentStatus: "VPS_ACTIVE",
      status: bot.isPaperTrading ? "TRAINING_PAPER_TRADE" : "LIVE_TRADING",
      hetznerServerId: String(server.id),
      hetznerServerIp: server.public_net?.ipv4?.ip ?? null,
      apiServerUsername,
      apiServerPassword: encrypt(apiServerPassword),
      apiServerJwtSecret: encrypt(apiServerJwtSecret),
      statusWebhookTokenHash: hashCallbackToken(statusWebhookToken),
      lastError: null,
    },
    select: botSelect,
  });

  return {
    bot: toBotDTO(updated),
    // Only ever available here and via GET /api/bots/[id]/credentials afterwards.
    apiCredentials: { username: apiServerUsername, password: apiServerPassword },
  };
}
