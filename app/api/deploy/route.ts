import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { assertCanTrade, BotBusyError } from "@/lib/bot-status";
import { deployBotToVps } from "@/lib/deploy-bot";
import { withErrorHandling, parseJsonBody } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const deployBodySchema = z.object({
  botId: z.string().min(1, "botId is required"),
});

export const POST = withErrorHandling(async (req: NextRequest) => {
  const supabase = await createClient();
  const {
    data: { user: authUser },
  } = await supabase.auth.getUser();
  if (!authUser) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseJsonBody(req, deployBodySchema);
  if ("error" in parsed) return parsed.error;
  const { botId } = parsed.data;

  const bot = await prisma.botConfiguration.findUnique({ where: { id: botId } });
  if (!bot || bot.userId !== authUser.id) {
    return NextResponse.json({ error: "Bot not found" }, { status: 404 });
  }
  if (bot.deploymentStatus === "VPS_ACTIVE") {
    return NextResponse.json({ error: "Bot is already deployed" }, { status: 409 });
  }
  // Never let a manual "Deploy" click start trading while a training run
  // (initial or a retrain) is in progress — see lib/bot-status.ts.
  try {
    assertCanTrade(bot.status, "deploy");
  } catch (err) {
    if (err instanceof BotBusyError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    throw err;
  }

  // Deliberately NO billing/quota gate here. Every bot deploys to this
  // route first while still paper trading (isPaperTrading defaults true,
  // no real money involved — see prisma/schema.prisma) — "try before you
  // risk" means paper trading must always be free to start, with no
  // payment method required. The quota check (profile.vpsBotQuota, Stripe
  // Checkout for more) lives in app/api/bots/[id]/golive instead, gating
  // the one moment real money actually enters the picture.
  try {
    const { bot: updatedBot, apiCredentials } = await deployBotToVps({ bot, supabase });
    return NextResponse.json({ bot: updatedBot, apiCredentials });
  } catch (err) {
    console.error(`[deploy] Failed to provision VPS for bot ${bot.id}:`, err);
    const message = err instanceof Error ? err.message : "Failed to provision VPS";
    return NextResponse.json({ error: message }, { status: 502 });
  }
});
