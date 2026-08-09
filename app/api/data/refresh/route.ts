import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { refreshMarketDataCache } from "@/lib/market-data-cache";
import { withErrorHandling } from "@/lib/api-handler";

export const dynamic = "force-dynamic";
// A cold ccxt loadMarkets()+fetchTickers() call plus dozens of paginated
// OHLCV fetches (bounded concurrency, see lib/market-data-cache.ts) across
// every cached pair/timeframe can run well past Vercel's default 10s —
// comfortably under the 300s ceiling Vercel allows on paid plans, which
// this route needs room to approach on a full backfill run (every
// pair/timeframe cold, nothing cached yet) even though a normal daily
// incremental run finishes in a small fraction of that.
export const maxDuration = 300;

// Same bearer-token pattern as /api/train/cloud/reap and
// /api/bots/sleep-sweep — an external scheduler (cron-job.org) hits this
// once daily with `Authorization: Bearer <CRON_SECRET>`, timing-safe
// compared since this is hit over plain HTTP outside Vercel's own signed
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

// Refreshes the shared, persistent market-data cache in Supabase Storage —
// see lib/market-data-cache.ts's own doc comment for the full design.
// Incremental for anything already cached, a full backfill for anything
// that isn't yet (first run, or a newly-promoted top-volume pair) —
// refreshMarketDataCache itself decides which per pair/timeframe. Always
// returns 200 with a per-item summary, even when some pairs failed (a
// rate-limited exchange call, ...) — a partial failure here is
// specifically NOT supposed to look like a failed cron run to the
// scheduler, since the existing cached data for whatever didn't update
// just stays in place and is still usable (see CACHE_MAX_STALENESS_HOURS).
// Exported as both GET and POST since this is a pure trigger with no body
// to read, matching /api/train/cloud/reap's own reasoning.
const handleRefresh = withErrorHandling(async (req: NextRequest) => {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log(`[data/refresh] run started at ${new Date().toISOString()}`);
  const summary = await refreshMarketDataCache();
  console.log(
    `[data/refresh] run finished — exchange=${summary.exchange} pairs=${summary.pairs.length} ` +
      `timeframes=${summary.timeframes.join(",")} updated=${summary.updated} skipped=${summary.skipped} failed=${summary.failed}`,
  );
  if (summary.errors.length > 0) {
    console.error(`[data/refresh] per-item failures (existing cache for these stays in place):`, summary.errors);
  }

  return NextResponse.json(summary);
});

export const GET = handleRefresh;
export const POST = handleRefresh;
