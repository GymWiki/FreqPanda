import { createClient as createServiceRoleClient } from "@supabase/supabase-js";
import { prisma } from "@/lib/prisma";
import { fetchOhlcvPage, fetchTopVolumeStakePairs } from "@/lib/market-data-client";
import { DATA_SOURCE_EXCHANGE, AUTO_PAIRLIST_SIZE } from "@/lib/hetzner";
import { timeframeToMinutes, computeTrainingTimerangeDays, DEFAULT_CORR_PAIRLIST } from "@/lib/training-timerange";
import { pairToFreqtradeFilename } from "@/lib/freqtrade-format";
import { STRATEGY_PRESETS } from "@/lib/strategy-presets";

// Server-maintained, daily-refreshed historical-candle cache — replaces
// both the old VM-side download-data step and the client-side (then
// Background Fetch) browser download, both of which turned out unreliable
// (Vercel/browser limits, exchange rate limits mid-download, huge auto-select
// pairlists). POST /api/data/refresh (cron-job.org, once daily) calls
// planRefreshTasks() + refreshMarketDataCacheChunk() below — split into two
// so the route can respond immediately after planning (fast) and defer the
// actual per-task work (potentially much slower than any HTTP request
// should block on) to a waitUntil-deferred continuation, time-boxed to fit
// this invocation's own function timeout — see that route's own doc
// comment for the full reasoning. lib/train-cloud.ts calls
// resolveCachedTrainingData() at job-start to hand a training VM
// already-cached data via signed Storage URLs (see preloadedData in
// lib/hetzner.ts) instead of downloading anything itself. A stale/missing
// cache is never fatal — resolveCachedTrainingData just returns null, and
// the caller falls back to the classic on-VM download-data loop exactly as
// it worked before any of this existed.
//
// Storage is partitioned one file per (exchange, pair, timeframe, UTC day)
// rather than one ever-growing file per (exchange, pair, timeframe) — the
// single-file design's daily refresh had to download the ENTIRE existing
// history just to append one day's worth of new candles (~221MB/day once
// fully backfilled, ~6.6GB/month — over Supabase's free 5GB/month egress
// tier). Per-day partitions mean a daily refresh only ever needs to
// download the ONE partition it might be appending to (today's, if this
// run isn't the first of the day) — everything else is a pure upload, no
// read at all. The cost this defers to training time: a VM now has to curl
// every partition file for its window and concatenate them locally (see
// preloadedDataScript in lib/hetzner.ts) instead of one file per
// pair/timeframe — more requests, but only when a user actually starts a
// training run, not once a day regardless of usage.
const MARKET_DATA_BUCKET = "market-data";
const KLINES_PAGE_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// The cache is shared across every bot regardless of which strategy preset
// it uses, so it has to cover the union of every preset's own
// includeTimeframes — not just one. Recomputed from the real presets
// (rather than a hand-maintained list) so a new preset with a new
// timeframe automatically gets picked up here too.
const CACHED_TIMEFRAMES = Array.from(
  new Set(STRATEGY_PRESETS.flatMap((preset) => preset.freqaiConfig.features.includeTimeframes)),
);

// Full backfill window for a pair/timeframe with nothing cached yet —
// generous enough for whichever preset needs the most history, computed
// the same way lib/hetzner.ts already computes a single bot's own
// timerange, just maxed across every preset instead of one.
const BACKFILL_DAYS = Math.max(...STRATEGY_PRESETS.map((preset) => computeTrainingTimerangeDays(preset.freqaiConfig)));

// A refresh that hasn't run (or has failed) for longer than this makes a
// pair/timeframe's cached data too stale to trust for a fresh training run
// — comfortably more than the daily refresh interval, so ONE missed or
// failed run (see point 8 of the original ask) never blocks training; two
// or more in a row does, which is the intended behavior, not a bug.
const CACHE_MAX_STALENESS_HOURS = 48;

// createSignedUrls' request-body/response-size limits aren't documented,
// so chunk any batch call rather than risk one giant request for a bot
// whose cached window spans the full BACKFILL_DAYS across several
// timeframes — worst case a few thousand paths.
const SIGN_URL_BATCH_SIZE = 500;

function serviceRoleClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key);
}

function dateStrUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10); // YYYY-MM-DD
}

// One file per (exchange, pair, timeframe, UTC day) — see this module's own
// doc comment for why. Deliberately flat (no subdirectories) so a single
// createSignedUrls batch call can address any mix of pairs/timeframes/dates
// by path alone.
function partitionStoragePath(exchange: string, pair: string, timeframe: string, dateStr: string): string {
  return `${exchange}/${pairToFreqtradeFilename(pair)}-${timeframe}-${dateStr}.json`;
}

async function downloadExistingCandles(
  supabase: ReturnType<typeof serviceRoleClient>,
  path: string,
): Promise<number[][]> {
  const { data, error } = await supabase.storage.from(MARKET_DATA_BUCKET).download(path);
  if (error || !data) return []; // treated as "nothing there yet" (a 404 for a partition that was never written, or genuinely doesn't exist yet)
  try {
    const parsed = JSON.parse(await data.text());
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function mergeAndSort(a: number[][], b: number[][]): number[][] {
  const byTimestamp = new Map<number, number[]>();
  for (const candle of a) byTimestamp.set(candle[0], candle);
  for (const candle of b) byTimestamp.set(candle[0], candle);
  return Array.from(byTimestamp.values()).sort((x, y) => x[0] - y[0]);
}

interface RefreshOneResult {
  pair: string;
  timeframe: string;
  status: "updated" | "skipped" | "error";
  newCandleCount?: number;
  error?: string;
}

// Safety bound on how many fetchOhlcvPage calls a single refreshOne
// invocation will make — NOT a normal operating limit (see the pagination
// loop's own comment below for why a genuinely stale pair/timeframe should
// always fully catch up well before this), just a backstop against a
// genuine infinite loop (e.g. an exchange bug that keeps echoing the same
// cursor back). At KLINES_PAGE_LIMIT candles/page this is 2,000,000
// candles — even at the finest cached granularity (5m) that's ~19 years,
// vastly more than this cache will ever realistically need to catch up in
// one run.
const MAX_PAGES_PER_CALL = 2000;

// One pair/timeframe: incremental if already cached (only fetches candles
// since the last cached one), full backfill otherwise. Every failure is
// caught and reported per-item rather than thrown — see
// refreshMarketDataCacheChunk's own doc comment for why one bad pair (a
// temporary exchange rate-limit, a delisted pair, ...) must never sink the
// whole refresh run.
//
// Writes (and upserts MarketDataCache for) one partition file per UTC day
// the newly-fetched candles land on, flushing each day as soon as its
// candles are known-complete (i.e. the next candle received belongs to a
// later day) rather than accumulating the entire catch-up span in memory
// and writing once at the end. This matters for two real reasons found
// investigating a ~10-month-stale cache:
//
// 1. Pagination correctness: the previous version stopped as soon as a
//    page came back shorter than KLINES_PAGE_LIMIT, on the assumption that
//    a short page means "caught up to now". That's wrong for at least OKX
//    (confirmed via the cache's own data: every pair's history froze at
//    exactly one page's worth of candles past its backfill start,
//    identically across pairs — e.g. 900 candles for 4h, no matter how
//    many months have passed since). An exchange can hand back fewer
//    candles than requested for reasons that have nothing to do with
//    having reached the present (an internal per-call cap on its
//    "history" endpoint, a rate-limit window, ...). The only reliable
//    "caught up" signal is the last candle's own timestamp actually
//    reaching nowMs — see the loop below, which now keeps paging
//    (advancing cursor) through as many short pages as it takes, only
//    stopping on a genuinely empty page, on reaching nowMs, or if the
//    cursor stops advancing at all (a real dead end, not just a short
//    page).
// 2. Durability: fixing (1) means a single call can now legitimately need
//    many more pages to fully catch a stale pair up — comfortably longer
//    than refreshMarketDataCacheChunk's own deadline check, which only
//    runs BETWEEN tasks, not mid-task (see that function's own doc
//    comment). If this whole invocation gets hard-killed by Vercel's
//    platform-level timeout mid-catch-up, flushing per completed day
//    means every day already written stays written — MarketDataCache's
//    lastCandleAt genuinely reflects how far this call got — so the next
//    invocation resumes from there instead of the entire call's progress
//    being lost, which is what accumulate-then-write-once-at-the-end
//    would have done.
async function refreshOne(
  supabase: ReturnType<typeof serviceRoleClient>,
  pair: string,
  timeframe: string,
): Promise<RefreshOneResult> {
  try {
    const existing = await prisma.marketDataCache.findUnique({
      where: { exchange_pair_timeframe: { exchange: DATA_SOURCE_EXCHANGE, pair, timeframe } },
    });

    const nowMs = Date.now();
    const sinceMs = existing
      ? existing.lastCandleAt.getTime() + timeframeToMinutes(timeframe) * 60 * 1000
      : nowMs - BACKFILL_DAYS * DAY_MS;
    if (sinceMs >= nowMs) {
      return { pair, timeframe, status: "skipped" };
    }

    let totalNewCandles = 0;
    // Only the very first day this call ever flushes can possibly collide
    // with something already written (an earlier run today, or a boundary
    // landing mid-day from yesterday's run) — see this function's own doc
    // comment. Every later day, for the rest of this call, is guaranteed
    // brand new since dates only move forward as candles page in.
    let isFirstFlush = true;
    let pendingDate: string | null = null;
    let pendingCandles: number[][] = [];

    async function flushDay(date: string, dayCandles: number[][]): Promise<void> {
      const path = partitionStoragePath(DATA_SOURCE_EXCHANGE, pair, timeframe, date);
      const finalCandles =
        isFirstFlush && existing ? mergeAndSort(await downloadExistingCandles(supabase, path), dayCandles) : dayCandles;
      isFirstFlush = false;

      const { error: uploadError } = await supabase.storage
        .from(MARKET_DATA_BUCKET)
        .upload(path, new Blob([JSON.stringify(finalCandles)], { type: "application/json" }), { upsert: true });
      if (uploadError) throw new Error(`Storage upload failed for ${path}: ${uploadError.message}`);

      const lastCandleMs = dayCandles[dayCandles.length - 1][0];
      await prisma.marketDataCache.upsert({
        where: { exchange_pair_timeframe: { exchange: DATA_SOURCE_EXCHANGE, pair, timeframe } },
        create: {
          exchange: DATA_SOURCE_EXCHANGE,
          pair,
          timeframe,
          candleCount: dayCandles.length,
          firstCandleAt: new Date(dayCandles[0][0]),
          lastCandleAt: new Date(lastCandleMs),
        },
        update: {
          candleCount: { increment: dayCandles.length },
          lastCandleAt: new Date(lastCandleMs),
        },
      });
      totalNewCandles += dayCandles.length;
    }

    let cursor = sinceMs;
    for (let page = 0; page < MAX_PAGES_PER_CALL; page++) {
      const { data } = await fetchOhlcvPage(pair, timeframe, cursor, KLINES_PAGE_LIMIT);
      const candles = data.candles;
      if (!candles || candles.length === 0) break; // genuinely no more data — a real end, not just a short page

      for (const candle of candles) {
        if (candle[0] > nowMs) continue;
        const date = dateStrUTC(candle[0]);
        if (pendingDate !== null && date !== pendingDate) {
          await flushDay(pendingDate, pendingCandles);
          pendingCandles = [];
        }
        pendingDate = date;
        pendingCandles.push(candle);
      }

      const lastTs = candles[candles.length - 1][0];
      if (lastTs >= nowMs) break; // genuinely caught up
      if (lastTs + 1 <= cursor) break; // cursor isn't advancing — a real dead end, avoid spinning forever
      cursor = lastTs + 1;
    }

    // Whatever's left is the last (possibly still-forming) day this call
    // reached — flush it too so this call's progress is never left
    // dangling in memory only.
    if (pendingDate !== null && pendingCandles.length > 0) {
      await flushDay(pendingDate, pendingCandles);
    }

    if (totalNewCandles === 0) {
      return { pair, timeframe, status: "skipped" };
    }
    return { pair, timeframe, status: "updated", newCandleCount: totalNewCandles };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[market-data-cache] refresh failed for ${pair} ${timeframe}:`, err);
    return { pair, timeframe, status: "error", error: message };
  }
}

export interface RefreshTask {
  pair: string;
  timeframe: string;
}

export interface RefreshPlan {
  exchange: string;
  pairs: string[];
  timeframes: string[];
  tasks: RefreshTask[];
}

// Resolves the current top-N-by-volume pairlist (the same set an
// auto-select bot's VolumePairList would use — see AUTO_PAIRLIST_SIZE's
// own doc comment in lib/hetzner.ts) plus DEFAULT_CORR_PAIRLIST's
// correlation-only pair, across every cached timeframe, into the flat task
// queue refreshMarketDataCacheChunk works through. Deliberately fast (one
// ccxt loadMarkets+fetchTickers call, no per-task work) — this is the part
// POST /api/data/refresh does synchronously, before responding, so the
// response can report an accurate tasksQueued count.
export async function planRefreshTasks(): Promise<RefreshPlan> {
  const { data: topPairs } = await fetchTopVolumeStakePairs(AUTO_PAIRLIST_SIZE);
  const pairs = Array.from(new Set([...topPairs, ...DEFAULT_CORR_PAIRLIST]));

  const tasks: RefreshTask[] = [];
  for (const pair of pairs) {
    for (const timeframe of CACHED_TIMEFRAMES) {
      tasks.push({ pair, timeframe });
    }
  }

  return { exchange: DATA_SOURCE_EXCHANGE, pairs, timeframes: CACHED_TIMEFRAMES, tasks };
}

export interface RefreshChunkSummary {
  tasksTotal: number;
  tasksProcessed: number;
  tasksRemaining: number;
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ pair: string; timeframe: string; error: string }>;
  /** True if this chunk stopped because deadlineMs was reached, not because the queue ran out. */
  timedOut: boolean;
}

// Works through `tasks` with bounded concurrency (same reasoning the old
// client-side downloader used: don't open dozens of simultaneous exchange
// calls at once) until either the queue is empty or deadlineMs is reached
// — whichever comes first. Called via waitUntil from
// POST /api/data/refresh, i.e. AFTER that route has already responded, so
// there's no HTTP caller left waiting on this; deadlineMs only exists to
// keep this invocation itself from running past Vercel's own function
// timeout. Never throws for a single pair/timeframe failure — see
// refreshOne — and a task queue that's too big to finish before the
// deadline just leaves the untouched tasks' MarketDataCache rows exactly
// as they were (still null, for a fresh backfill), which the NEXT
// invocation of this same route picks up as its own tasks — see that
// route's own doc comment for why this makes the whole thing safely
// resumable across multiple daily/manual triggers rather than needing to
// finish in one shot.
export async function refreshMarketDataCacheChunk(tasks: RefreshTask[], deadlineMs: number): Promise<RefreshChunkSummary> {
  const supabase = serviceRoleClient();
  const results: RefreshOneResult[] = [];
  const CONCURRENCY = 4;
  let nextIndex = 0;
  let timedOut = false;

  async function worker() {
    for (;;) {
      if (Date.now() >= deadlineMs) {
        timedOut = nextIndex < tasks.length;
        return;
      }
      const index = nextIndex++;
      if (index >= tasks.length) return;
      results.push(await refreshOne(supabase, tasks[index].pair, tasks[index].timeframe));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

  return {
    tasksTotal: tasks.length,
    tasksProcessed: results.length,
    tasksRemaining: tasks.length - results.length,
    updated: results.filter((r) => r.status === "updated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "error").length,
    errors: results
      .filter((r): r is RefreshOneResult & { error: string } => r.status === "error" && !!r.error)
      .map((r) => ({ pair: r.pair, timeframe: r.timeframe, error: r.error })),
    timedOut,
  };
}

export interface CachedTrainingData {
  /** Every pair with complete, fresh cached data for all requested timeframes — includes DEFAULT_CORR_PAIRLIST's correlation-only pair if present. */
  pairs: string[];
  /** One entry per (pair, timeframe); downloadUrls is every partition file covering that pair/timeframe's cached range, oldest first — see preloadedDataScript in lib/hetzner.ts for how the VM concatenates them back into the single file freqtrade expects. */
  files: Array<{ pair: string; timeframe: string; downloadUrls: string[] }>;
}

async function createSignedUrlsBatched(
  supabase: ReturnType<typeof serviceRoleClient>,
  paths: string[],
): Promise<Array<{ path: string | null; signedUrl: string | null; error: string | null }>> {
  const results: Array<{ path: string | null; signedUrl: string | null; error: string | null }> = [];
  for (let i = 0; i < paths.length; i += SIGN_URL_BATCH_SIZE) {
    const chunk = paths.slice(i, i + SIGN_URL_BATCH_SIZE);
    const { data, error } = await supabase.storage.from(MARKET_DATA_BUCKET).createSignedUrls(chunk, 3600);
    if (error || !data) {
      // Treat a whole-batch failure as "none of these signed" rather than
      // aborting resolveCachedTrainingData outright — the caller already
      // drops any (pair, timeframe) that ends up short a partition.
      for (const path of chunk) results.push({ path, signedUrl: null, error: error?.message ?? "sign failed" });
      continue;
    }
    results.push(...data);
  }
  return results;
}

// Called at training job-start (lib/train-cloud.ts) for an auto-select bot
// — resolves whatever the shared cache currently has for the requested
// timeframes into signed download URLs, or returns null if the cache isn't
// usable (empty, too stale, or missing the correlation-only pair FreqAI's
// include_corr_pairlist needs). null is always a safe, non-fatal signal:
// the caller just falls back to the classic on-VM download-data loop.
//
// Only a pair with ALL requested timeframes present and fresh is included
// — a partial pair (missing one timeframe) would leave FreqAI's
// feature_engineering_expand_*() with nothing to read for that timeframe,
// so it's excluded entirely rather than passed through incomplete.
export async function resolveCachedTrainingData(timeframes: string[]): Promise<CachedTrainingData | null> {
  const staleCutoff = new Date(Date.now() - CACHE_MAX_STALENESS_HOURS * 60 * 60 * 1000);
  const rows = await prisma.marketDataCache.findMany({
    where: { exchange: DATA_SOURCE_EXCHANGE, timeframe: { in: timeframes }, updatedAt: { gte: staleCutoff } },
  });
  if (rows.length === 0) return null;

  const rowsByPair = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = rowsByPair.get(row.pair) ?? [];
    group.push(row);
    rowsByPair.set(row.pair, group);
  }
  const usableRows = Array.from(rowsByPair.values())
    .filter((group) => group.length === timeframes.length)
    .flat();
  if (usableRows.length === 0) return null;

  // Every calendar day between each row's own firstCandleAt/lastCandleAt is
  // a *candidate* partition path — not every one is guaranteed to exist
  // (an exchange gap, a newly-listed pair's actual first day, ...), so a
  // missing one just drops out silently in the createSignedUrls pass below
  // rather than failing the whole (pair, timeframe).
  interface PlannedPath {
    pair: string;
    timeframe: string;
    date: string;
    path: string;
  }
  const planned: PlannedPath[] = [];
  for (const row of usableRows) {
    const startDay = Math.floor(row.firstCandleAt.getTime() / DAY_MS) * DAY_MS;
    const endDay = Math.floor(row.lastCandleAt.getTime() / DAY_MS) * DAY_MS;
    for (let day = startDay; day <= endDay; day += DAY_MS) {
      const date = dateStrUTC(day);
      planned.push({
        pair: row.pair,
        timeframe: row.timeframe,
        date,
        path: partitionStoragePath(DATA_SOURCE_EXCHANGE, row.pair, row.timeframe, date),
      });
    }
  }
  if (planned.length === 0) return null;

  const supabase = serviceRoleClient();
  const signed = await createSignedUrlsBatched(
    supabase,
    planned.map((p) => p.path),
  );

  const byPairTimeframe = new Map<string, Array<{ date: string; downloadUrl: string }>>();
  planned.forEach((p, i) => {
    const entry = signed[i];
    if (!entry || entry.error || !entry.signedUrl) return; // partition genuinely doesn't exist (or a batch failed) — skip it, not fatal
    const key = `${p.pair}|${p.timeframe}`;
    const group = byPairTimeframe.get(key) ?? [];
    group.push({ date: p.date, downloadUrl: entry.signedUrl });
    byPairTimeframe.set(key, group);
  });

  const filesByPair = new Map<string, Array<{ pair: string; timeframe: string; downloadUrls: string[] }>>();
  for (const [key, group] of byPairTimeframe) {
    if (group.length === 0) continue;
    const [pair, timeframe] = key.split("|");
    const downloadUrls = group.sort((a, b) => a.date.localeCompare(b.date)).map((g) => g.downloadUrl);
    const list = filesByPair.get(pair) ?? [];
    list.push({ pair, timeframe, downloadUrls });
    filesByPair.set(pair, list);
  }

  // Same "all-or-nothing per pair" discipline as before: a pair only
  // counts if every requested timeframe actually got at least one signed
  // partition URL.
  const files = Array.from(filesByPair.values())
    .filter((group) => group.length === timeframes.length)
    .flat();
  if (files.length === 0) return null;

  const pairs = Array.from(new Set(files.map((f) => f.pair)));
  if (!DEFAULT_CORR_PAIRLIST.every((p) => pairs.includes(p))) return null;

  return { pairs, files };
}
