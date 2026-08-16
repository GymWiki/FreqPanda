import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { stopHetznerServer } from "@/lib/hetzner";
import { withErrorHandling } from "@/lib/api-handler";

export const dynamic = "force-dynamic";

const INACTIVITY_DAYS = 7;

// An external scheduler (e.g. cron-job.org) hits this daily with
// `Authorization: Bearer <CRON_SECRET>`, and a timing-safe compare is used
// since this is hit over plain HTTP by a caller outside Vercel's own signed
// cron mechanism.
function isAuthorized(req: NextRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return false;

  const authHeader = req.headers.get("authorization");
  if (!authHeader) return false;

  const expected = Buffer.from(`Bearer ${cronSecret}`);
  const actual = Buffer.from(authHeader);
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// Sleep Mode: a daily sweep that powers off the VPS (not delete — see
// lib/hetzner.ts stopHetznerServer) for any bot that's still paper-trading
// and whose owner hasn't opened the dashboard in 7+ days, so an abandoned
// trial doesn't quietly keep costing the operator real Hetzner compute.
// Deliberately scoped to TRAINING_PAPER_TRADE only — a LIVE_TRADING bot
// has real open positions and money on the line, so it is never a
// candidate here regardless of how long the owner has been away; only the
// Panic Button ever touches a live bot's trading loop.
export const GET = withErrorHandling(async (req: NextRequest) => {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const cutoff = new Date(Date.now() - INACTIVITY_DAYS * 24 * 60 * 60 * 1000);

  const candidates = await prisma.botConfiguration.findMany({
    where: {
      status: "TRAINING_PAPER_TRADE",
      deploymentStatus: "VPS_ACTIVE",
      hetznerServerId: { not: null },
      user: { lastActiveAt: { lt: cutoff } },
    },
  });

  const results: Array<{ botId: string; ok: boolean }> = [];

  for (const bot of candidates) {
    if (!bot.hetznerServerId) continue;
    try {
      await stopHetznerServer(bot.hetznerServerId);
      await prisma.botConfiguration.update({ where: { id: bot.id }, data: { status: "SLEEPING" } });
      results.push({ botId: bot.id, ok: true });
    } catch (err) {
      console.error(`[bots/sleep-sweep] Failed to sleep bot ${bot.id}:`, err);
      results.push({ botId: bot.id, ok: false });
    }
  }

  return NextResponse.json({ swept: results.length, results });
});
