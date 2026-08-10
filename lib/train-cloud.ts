import { prisma } from "@/lib/prisma";
import type { Prisma } from "@prisma/client";
import { decrypt } from "@/lib/encryption";
import {
  buildFreqAITrainingArtifacts,
  buildTrainingBootstrapCloudInit,
  createHetznerServer,
  requireHetznerToken,
  getDataServerConfig,
} from "@/lib/hetzner";
import { DEFAULT_PAPER_TOTAL_BUDGET, DEFAULT_PAPER_MAX_STAKE_PERCENTAGE } from "@/lib/paper-trading-defaults";
import { generateCallbackToken, hashCallbackToken } from "@/lib/training-token";
import { stopBot, forceExitAll } from "@/lib/freqtrade-client";
import { uploadTrainingBootstrap } from "@/lib/training-bootstrap";
import type { FreqAIProfileConfig } from "@/lib/strategy-presets";

type BotRow = Prisma.BotConfigurationGetPayload<object>;

const TRAINING_SERVER_TYPE = process.env.HETZNER_TRAINING_SERVER_TYPE || "cpx31";

export class TrainingBusyError extends Error {}

interface StartCloudTrainingParams {
  bot: BotRow;
  /** Force-close open positions before pausing, instead of just halting new entries. Only meaningful if the bot is currently deployed (paper or live). */
  cancelOpenOrders?: boolean;
}

// The single place a cloud training job gets created — called directly by
// POST /api/train/cloud (user clicked "Start Cloud Training") and by
// POST /api/bots/[id]/status handling a "retrain_needed" event from a
// deployed bot. Both paths get the same priority guarantee for free: if
// the bot is currently deployed — paper or live, both actually run the
// freqtrade loop — it is genuinely paused (via its own freqtrade REST API,
// not just a database flag) before any training bookkeeping happens.
export async function startCloudTrainingJob({ bot, cancelOpenOrders = false }: StartCloudTrainingParams) {
  const activeJob = await prisma.trainingJob.findFirst({
    where: { botId: bot.id, status: { in: ["QUEUED", "TRAINING"] } },
  });
  if (activeJob) {
    throw new TrainingBusyError("A training job is already running for this bot");
  }
  if (bot.status === "TRAINING" || bot.status === "UPDATING_MODEL") {
    throw new TrainingBusyError(`Bot is already ${bot.status}`);
  }

  const appUrl = process.env.NEXT_PUBLIC_APP_URL;
  if (!appUrl) throw new Error("NEXT_PUBLIC_APP_URL is not configured");
  // Was a second, separately-maintained copy of this exact check — now the
  // one in lib/hetzner.ts (which also logs which HETZNER_* env vars are
  // actually present, server-side only, when this throws) so there's a
  // single place to keep the error message and diagnostics in sync.
  const hetznerApiToken = requireHetznerToken();

  const freqaiConfig = bot.freqaiConfig as unknown as FreqAIProfileConfig;

  // Only meaningful for auto-select bots — a manual/static pairWhitelist can
  // be any pair at all, not necessarily one the permanent data server
  // happens to have downloaded, so those always use the classic on-VM
  // download-data loop inside buildFreqAITrainingArtifacts regardless of
  // whether this is configured. Returns null (no throw) when either env var
  // is unset, so a training run for an auto-select bot still works — just
  // via the classic loop — before DATA_SERVER_HOST/DATA_SERVER_SSH_PRIVATE_KEY
  // are ever set. See getDataServerConfig's own doc comment in lib/hetzner.ts.
  const dataServer = getDataServerConfig();

  // Priority rule: training/updating always wins over active trading
  // (paper or live), and the pause must be real, not just a status label —
  // hence the freqtrade API call, using this bot's own per-deployment
  // credentials. deployBotToVps derives the resume status from
  // isPaperTrading, so whichever phase this was in is exactly what it
  // resumes to.
  //
  // deploymentStatus, not status: TRAINING_PAPER_TRADE is this bot's
  // status from the moment it's *created*, not just while it's actually
  // running on a VPS — a bot that has never been deployed is also
  // TRAINING_PAPER_TRADE, but has no server to pause and no freqtrade
  // REST API credentials to pause it with. Checking bot.status here
  // treated every brand-new bot as "already deployed", so its very first
  // Start Cloud Training click always hit the credentials check below and
  // failed — nothing to do with the bot's own exchange account (see
  // lib/deploy-bot.ts for that, separate, gate). VPS_ACTIVE is the actual
  // "is there a running deployment to pause" signal.
  const wasDeployed = bot.deploymentStatus === "VPS_ACTIVE";
  if (wasDeployed) {
    if (!bot.hetznerServerIp || !bot.apiServerUsername || !bot.apiServerPassword) {
      throw new Error(`Bot is ${bot.status} but has no reachable API credentials — refusing to start a retrain blind`);
    }
    const creds = {
      serverIp: bot.hetznerServerIp,
      username: bot.apiServerUsername,
      password: decrypt(bot.apiServerPassword),
    };
    await stopBot(creds);
    if (cancelOpenOrders) {
      await forceExitAll(creds);
    }
  }

  await prisma.botConfiguration.update({
    where: { id: bot.id },
    data: { status: wasDeployed ? "UPDATING_MODEL" : "TRAINING", trainingMode: "CLOUD" },
  });

  const callbackToken = generateCallbackToken();
  const job = await prisma.trainingJob.create({
    data: {
      botId: bot.id,
      userId: bot.userId,
      mode: "CLOUD",
      status: "QUEUED",
      callbackTokenHash: hashCallbackToken(callbackToken),
    },
  });

  try {
    // Split in two: buildFreqAITrainingArtifacts is pure (config.json, the
    // strategy source, train.sh), then uploadTrainingBootstrap ships those
    // three to the private "training-bootstrap" Storage bucket so the
    // actual user_data handed to Hetzner (buildTrainingBootstrapCloudInit)
    // only has to carry three short signed URLs — comfortably under
    // Hetzner's 32768-byte user_data limit regardless of how big train.sh
    // itself gets. See lib/training-bootstrap.ts's own doc comment for the
    // full reasoning.
    const artifacts = buildFreqAITrainingArtifacts({
      botName: bot.botName,
      exchangeName: bot.exchangeName,
      strategy: bot.strategy,
      strategyCode: bot.strategyCode,
      freqaiConfig,
      autoSelectCoins: bot.autoSelectCoins,
      pairWhitelist: bot.pairWhitelist ? bot.pairWhitelist.split(",").map((p) => p.trim()).filter(Boolean) : [],
      totalBudget: bot.totalBudget ?? DEFAULT_PAPER_TOTAL_BUDGET,
      maxStakePercentage: bot.maxStakePercentage ?? DEFAULT_PAPER_MAX_STAKE_PERCENTAGE,
      autoCompound: bot.autoCompound,
      uploadUrlEndpoint: `${appUrl}/api/train/cloud/upload-url`,
      callbackUrl: `${appUrl}/api/train/cloud/callback`,
      progressUrl: `${appUrl}/api/train/cloud/progress`,
      callbackToken,
      hetznerApiToken,
      // Only ever set for an auto-select bot with a configured data server
      // (see dataServer's own comment above) — buildFreqAITrainingArtifacts
      // falls back to the classic on-VM download-data loop for everything
      // else (manual pairWhitelist bots, or before these two env vars are
      // set at all).
      dataServerHost: bot.autoSelectCoins ? dataServer?.host : undefined,
      dataServerSshPrivateKey: bot.autoSelectCoins ? dataServer?.sshPrivateKey : undefined,
    });

    const bootstrapUrls = await uploadTrainingBootstrap(job.id, artifacts);
    const cloudInit = buildTrainingBootstrapCloudInit({
      strategy: bot.strategy,
      progressUrl: `${appUrl}/api/train/cloud/progress`,
      callbackToken,
      maxRuntimeHours: artifacts.maxRuntimeHours,
      configUrl: bootstrapUrls.configUrl,
      strategyUrl: bootstrapUrls.strategyUrl,
      trainScriptUrl: bootstrapUrls.trainScriptUrl,
    });

    // Explicit markers either side of the one call that actually leaves
    // the DB — if a job is ever found stuck at QUEUED with no
    // hetznerServerId, these two lines (present or not, in Vercel's
    // function logs for this invocation) are what tells you whether
    // createHetznerServer was ever reached at all, versus started and
    // never returned (the platform killing the function mid-call being
    // the one failure mode that skips the catch block below entirely).
    console.log(`[train-cloud] job ${job.id}: requesting Hetzner server (type=${TRAINING_SERVER_TYPE})`);
    const { server } = await createHetznerServer({
      name: `train-${job.id}`,
      cloudInit,
      serverType: TRAINING_SERVER_TYPE,
      firewallProfile: "training",
    });
    console.log(`[train-cloud] job ${job.id}: Hetzner server ${server.id} created, flipping QUEUED -> TRAINING`);

    return await prisma.trainingJob.update({
      where: { id: job.id },
      data: { status: "TRAINING", hetznerServerId: String(server.id) },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to start cloud training";
    console.error(`[train-cloud] job ${job.id}: provisioning failed, marking FAILED — ${message}`);
    await prisma.trainingJob.update({
      where: { id: job.id },
      data: { status: "FAILED", errorMessage: message },
    });
    // Deliberately left paused rather than auto-resumed: if the bot was
    // TRADING and we already stopped it above, an unexplained provisioning
    // failure is exactly the moment NOT to silently resume live trading.
    // ERROR keeps assertCanTrade blocking further action until a human
    // looks at it.
    await prisma.botConfiguration.update({
      where: { id: bot.id },
      data: { status: "ERROR", lastError: message },
    });
    throw err;
  }
}
