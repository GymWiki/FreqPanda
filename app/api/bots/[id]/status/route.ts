import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/encryption";
import { extractBearerToken, hashCallbackToken, timingSafeEqualHex } from "@/lib/training-token";
import { startBot, stopBot } from "@/lib/freqtrade-client";
import { startCloudTrainingJob, TrainingBusyError } from "@/lib/train-cloud";
import { withErrorHandling, parseJsonBody } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const MAX_MESSAGE_LENGTH = 2000;

const statusBodySchema = z.object({
  event: z.enum(["training_complete", "retrain_needed", "error"]),
  // Not length-bounded for the same reason as train/cloud/callback: this
  // is a fire-and-forget report from the bot itself, and rejecting it
  // outright would leave the bot stuck mid-transition with no way to retry.
  message: z.string().nullish(),
  cancelOpenOrders: z.boolean().optional(),
});

// Called by a *deployed* bot's own strategy/FreqAI model code (via
// user_data/webhook.json, written at deploy time — see lib/hetzner.ts) to
// report its own lifecycle events. No user session is possible here, so
// auth is a bearer token hashed and compared against
// BotConfiguration.statusWebhookTokenHash, scoped to this one bot id.
//
// This is the live counterpart to POST /api/train/cloud/callback: that
// route hears from our own ephemeral training VMs; this one hears from the
// long-running bot itself.
export const POST = withErrorHandling(async (req: NextRequest, { params }: { params: { id: string } }) => {
  const token = extractBearerToken(req.headers.get("authorization"));
  if (!token) {
    return NextResponse.json({ error: "Missing bearer token" }, { status: 401 });
  }

  const bot = await prisma.botConfiguration.findUnique({ where: { id: params.id } });
  if (!bot || !bot.statusWebhookTokenHash) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (!timingSafeEqualHex(hashCallbackToken(token), bot.statusWebhookTokenHash)) {
    return NextResponse.json({ error: "Invalid token" }, { status: 401 });
  }

  const parsed = await parseJsonBody(req, statusBodySchema);
  if ("error" in parsed) return parsed.error;
  const { event, cancelOpenOrders = false } = parsed.data;
  const message = parsed.data.message?.slice(0, MAX_MESSAGE_LENGTH) ?? null;

  const creds =
    bot.hetznerServerIp && bot.apiServerUsername && bot.apiServerPassword
      ? { serverIp: bot.hetznerServerIp, username: bot.apiServerUsername, password: decrypt(bot.apiServerPassword) }
      : null;

  switch (event) {
    // FreqAI finished retraining itself internally (no separate training VM
    // involved — see POST /api/train/cloud/callback for that pipeline).
    // Only meaningful once we've actually paused for it.
    case "training_complete": {
      if (bot.status !== "UPDATING_MODEL") {
        return NextResponse.json(
          { error: `Bot is ${bot.status}, not UPDATING_MODEL — nothing to resume` },
          { status: 409 },
        );
      }
      if (!creds) {
        return NextResponse.json({ error: "Bot has no reachable API credentials" }, { status: 409 });
      }
      try {
        await startBot(creds);
      } catch (err) {
        console.error(`[bots/status] Failed to resume trading for bot ${bot.id}:`, err);
        const errMessage = err instanceof Error ? err.message : "Failed to resume trading";
        await prisma.botConfiguration.update({
          where: { id: bot.id },
          data: { status: "ERROR", lastError: errMessage },
        });
        return NextResponse.json({ error: errMessage }, { status: 502 });
      }
      // Resumes to whichever phase this bot was actually in before the
      // pause — isPaperTrading is the single source of truth for that,
      // never touched by a retrain.
      const resumedStatus = bot.isPaperTrading ? "TRAINING_PAPER_TRADE" : "LIVE_TRADING";
      await prisma.botConfiguration.update({
        where: { id: bot.id },
        data: { status: resumedStatus, lastError: null },
      });
      return NextResponse.json({ ok: true, status: resumedStatus });
    }

    // The deployed bot (or its custom FreqAI model class) has decided its
    // model is stale. Priority rule: training/updating always wins over
    // trading (paper or live) — startCloudTrainingJob genuinely pauses the
    // bot via its own freqtrade API before touching any training bookkeeping.
    case "retrain_needed": {
      if (bot.status === "UPDATING_MODEL") {
        return NextResponse.json({ ok: true, status: "UPDATING_MODEL", note: "already updating" });
      }
      if (bot.status !== "TRAINING_PAPER_TRADE" && bot.status !== "LIVE_TRADING") {
        return NextResponse.json(
          { error: `Bot is ${bot.status}, not deployed — nothing to pause for a retrain` },
          { status: 409 },
        );
      }
      try {
        const job = await startCloudTrainingJob({ bot, cancelOpenOrders });
        return NextResponse.json({ ok: true, status: "UPDATING_MODEL", job }, { status: 202 });
      } catch (err) {
        if (err instanceof TrainingBusyError) {
          return NextResponse.json({ error: err.message }, { status: 409 });
        }
        console.error(`[bots/status] Failed to start retrain for bot ${bot.id}:`, err);
        const errMessage = err instanceof Error ? err.message : "Failed to start retrain";
        return NextResponse.json({ error: errMessage }, { status: 502 });
      }
    }

    // Something went wrong inside the bot itself. Best-effort pause as a
    // safety measure — we don't know the nature of the failure, so
    // continuing to trade unattended is the wrong default.
    case "error": {
      if (creds) {
        try {
          await stopBot(creds);
        } catch (err) {
          // best effort — ERROR status still applies below regardless
          console.error(`[bots/status] Best-effort stopBot failed for bot ${bot.id}:`, err);
        }
      }
      await prisma.botConfiguration.update({
        where: { id: bot.id },
        data: { status: "ERROR", lastError: message ?? "Reported an error with no message" },
      });
      return NextResponse.json({ ok: true, status: "ERROR" });
    }
  }
});
