import { NextRequest, NextResponse } from "next/server";
import crypto from "crypto";
import { waitUntil, getDeadline } from "@vercel/functions";
import { planRefreshTasks, refreshMarketDataCacheChunk } from "@/lib/market-data-cache";
import { withErrorHandling } from "@/lib/api-handler";

export const dynamic = "force-dynamic";
// Ceiling for the deferred (waitUntil) chunk below, not for this route's
// own response time — the response itself now goes out as soon as
// planRefreshTasks() resolves (well under a second). maxDuration still
// bounds the WHOLE invocation, including whatever waitUntil keeps running
// after the response — see REFRESH_TIME_BUDGET_MS's own doc comment for
// why the chunk targets comfortably less than this.
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

// Safety margin subtracted off the real deadline (or off "now + maxDuration"
// when there is no real deadline — e.g. local dev, where getDeadline()
// returns undefined) so the chunk always stops itself with enough headroom
// left for in-flight tasks to finish and for the platform's own teardown,
// rather than racing an external timeout that would kill the whole
// invocation (including whatever Storage upload / Postgres write was
// mid-flight) uncleanly.
const REFRESH_TIME_BUDGET_MS = 300_000;
const REFRESH_SAFETY_MARGIN_MS = 30_000;

// Refreshes the shared, persistent market-data cache in Supabase Storage —
// see lib/market-data-cache.ts's own doc comment for the full design.
//
// Used to await the ENTIRE refresh (every pair/timeframe) before
// responding — cron-job.org's own request would then sit there until every
// task finished, which for a cold cache (nothing backfilled yet: ~30 pairs
// × 4 timeframes × up to ~296 days of history) is thousands of paginated
// exchange calls, comfortably capable of outrunning any HTTP client's own
// timeout regardless of this route's maxDuration. Now: planRefreshTasks()
// (fast, one ccxt call) runs synchronously so the response can report an
// accurate tasksQueued count, then the actual per-task fetch+write work is
// handed to waitUntil — which keeps this invocation alive in the
// background, without cron-job.org's own request waiting on it — and
// time-boxed to REFRESH_TIME_BUDGET_MS (or the real remaining time on this
// invocation, via @vercel/functions' getDeadline(), whichever is tighter).
// Always responds 202 immediately, and always fast, regardless of how much
// work the deferred chunk still has ahead of it.
//
// A chunk that runs out of time before the queue is empty is not a
// failure: every untouched task's MarketDataCache row is simply left as it
// was (still null for a fresh backfill, or still slightly stale for an
// incremental run) — see refreshOne in lib/market-data-cache.ts, which
// treats "no row yet" as "needs a full backfill" unconditionally. The next
// invocation of this same route (the next scheduled cron-job.org fire, or
// a manual re-trigger) picks up exactly where this one left off, since
// nothing here depends on in-memory state surviving between invocations.
// A rate-limited or otherwise-failing individual pair/timeframe is also
// never fatal to the run — see refreshOne — the existing cached data for
// it just stays in place and is still usable (see
// CACHE_MAX_STALENESS_HOURS in lib/market-data-cache.ts).
//
// Exported as both GET and POST since this is a pure trigger with no body
// to read, matching /api/train/cloud/reap's own reasoning.
const handleRefresh = withErrorHandling(async (req: NextRequest) => {
  if (!isAuthorized(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const plan = await planRefreshTasks();

  // getDeadline() only returns a real value when actually running on
  // Vercel's platform; falls back to a fixed budget off "now" for local
  // dev or any other environment without that runtime context — either
  // way, deadlineMs always ends up comfortably before this invocation
  // could actually be killed.
  const rawDeadlineMs = getDeadline()?.getTime() ?? Date.now() + REFRESH_TIME_BUDGET_MS;
  const deadlineMs = rawDeadlineMs - REFRESH_SAFETY_MARGIN_MS;

  console.log(
    `[data/refresh] accepted at ${new Date().toISOString()} — exchange=${plan.exchange} ` +
      `pairs=${plan.pairs.length} timeframes=${plan.timeframes.join(",")} tasksQueued=${plan.tasks.length}`,
  );

  waitUntil(
    refreshMarketDataCacheChunk(plan.tasks, deadlineMs)
      .then((chunk) => {
        console.log(
          `[data/refresh] chunk finished — processed=${chunk.tasksProcessed}/${chunk.tasksTotal} ` +
            `updated=${chunk.updated} skipped=${chunk.skipped} failed=${chunk.failed} ` +
            `timedOut=${chunk.timedOut}${chunk.timedOut ? " (remaining tasks pick up on the next trigger)" : ""}`,
        );
        if (chunk.errors.length > 0) {
          console.error(`[data/refresh] per-item failures (existing cache for these stays in place):`, chunk.errors);
        }
      })
      .catch((err) => {
        console.error(`[data/refresh] background chunk crashed:`, err);
      }),
  );

  return NextResponse.json(
    {
      status: "accepted",
      exchange: plan.exchange,
      pairs: plan.pairs,
      timeframes: plan.timeframes,
      tasksQueued: plan.tasks.length,
    },
    { status: 202 },
  );
});

export const GET = handleRefresh;
export const POST = handleRefresh;
