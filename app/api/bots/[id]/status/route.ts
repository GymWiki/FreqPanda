import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { decrypt } from "@/lib/encryption";
import { extractBearerToken, hashCallbackToken, timingSafeEqualHex } from "@/lib/training-token";
import { startBot, stopBot } from "@/lib/freqtrade-client";
import { withErrorHandling, parseJsonBody } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const MAX_MESSAGE_LENGTH = 2000;

const statusBodySchema = z.object({
  event: z.enum(["training_complete", "retrain_needed", "error"]),
  // Not length-bounded: this is a fire-and-forget report from the bot
  // itself, and rejecting it outright would leave the bot stuck
  // mid-transition with no way to retry.
  message: z.string().nullish(),
});

// Called by a *deployed* bot's own strategy/FreqAI model code (via
// user_data/webhook.json, written at deploy time — see lib/hetzner.ts) to
// report its own lifecycle events. No user session is possible here, so
// auth is a bearer token hashed and compared against
// BotConfiguration.statusWebhookTokenHash, scoped to this one bot id.
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
  const { event } = parsed.data;
  const message = parsed.data.message?.slice(0, MAX_MESSAGE_LENGTH) ?? null;

  const creds =
    bot.hetznerServerIp && bot.apiServerUsername && bot.apiServerPassword
      ? { serverIp: bot.hetznerServerIp, username: bot.apiServerUsername, password: decrypt(bot.apiServerPassword) }
      : null;

  switch (event) {
    // FreqAI finished retraining itself internally (freqtrade's own
    // live_retrain_hours — see lib/hetzner.ts — handles that in-process, no
    // separate training VM involved). Only meaningful once we've actually
    // paused for it, which nothing currently does (see "retrain_needed"
    // below) — kept so a future pause mechanism has a resume path ready.
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
    // model is stale. There is no cloud training VM to hand this off to
    // anymore — bots only ever run on a VPS, never train there (retraining
    // happens locally via the desktop app, or in-process via freqtrade's
    // own live_retrain_hours). Nothing in this codebase currently sends
    // this event; acknowledged as a no-op (rather than a 404/500) purely so
    // a custom strategy that still POSTs it doesn't see a hard failure.
    // Deliberately doesn't pause the bot: there is no automated way to
    // resume it afterward, so pausing here would just strand it.
    case "retrain_needed": {
      return NextResponse.json({
        ok: true,
        note: "Cloud retraining is not available. Retrain locally via the desktop app and redeploy, or rely on live_retrain_hours.",
      });
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
