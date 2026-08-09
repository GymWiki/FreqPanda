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
// refreshMarketDataCache() below; lib/train-cloud.ts calls
// resolveCachedTrainingData() at job-start to hand a training VM
// already-cached data via signed Storage URLs (see preloadedData in
// lib/hetzner.ts) instead of downloading anything itself. A stale/missing
// cache is never fatal — resolveCachedTrainingData just returns null, and
// the caller falls back to the classic on-VM download-data loop exactly as
// it worked before any of this existed.
const MARKET_DATA_BUCKET = "market-data";
const KLINES_PAGE_LIMIT = 1000;

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

function serviceRoleClient() {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured");
  return createServiceRoleClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, key);
}

// Matches exactly what buildFreqAITrainingCloudInit's preloadedData branch
// (lib/hetzner.ts) expects to curl into user_data/data/<exchange>/ on the
// VM — same filename convention as the rest of this app's freqtrade file
// handling (see lib/freqtrade-format.ts).
function storagePathFor(exchange: string, pair: string, timeframe: string): string {
  return `${exchange}/${pairToFreqtradeFilename(pair)}-${timeframe}.json`;
}

async function downloadExistingCandles(
  supabase: ReturnType<typeof serviceRoleClient>,
  path: string,
): Promise<number[][]> {
  const { data, error } = await supabase.storage.from(MARKET_DATA_BUCKET).download(path);
  if (error || !data) return []; // treated as "nothing there yet" — a fresh backfill will just refetch everything from BACKFILL_DAYS ago
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
  candleCount?: number;
  error?: string;
}

// One pair/timeframe: incremental if already cached (only fetches candles
// since the last cached one), full backfill otherwise. Every failure is
// caught and reported per-item rather than thrown — see
// refreshMarketDataCache's own doc comment for why one bad pair (a
// temporary exchange rate-limit, a delisted pair, ...) must never sink the
// whole daily refresh.
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
    const path = storagePathFor(DATA_SOURCE_EXCHANGE, pair, timeframe);
    let sinceMs: number;
    let priorCandles: number[][] = [];

    if (existing) {
      const intervalMs = timeframeToMinutes(timeframe) * 60 * 1000;
      sinceMs = existing.lastCandleAt.getTime() + intervalMs;
      if (sinceMs >= nowMs) {
        return { pair, timeframe, status: "skipped" };
      }
      priorCandles = await downloadExistingCandles(supabase, existing.storagePath);
    } else {
      sinceMs = nowMs - BACKFILL_DAYS * 24 * 60 * 60 * 1000;
    }

    // Same paginated-fetch shape the old client-side downloader used —
    // page forward until a short/empty page signals "caught up to now".
    const newCandles: number[][] = [];
    let cursor = sinceMs;
    for (;;) {
      const { data } = await fetchOhlcvPage(pair, timeframe, cursor, KLINES_PAGE_LIMIT);
      const page = data.candles;
      if (!page || page.length === 0) break;
      for (const candle of page) if (candle[0] <= nowMs) newCandles.push(candle);
      const lastTs = page[page.length - 1][0];
      if (page.length < KLINES_PAGE_LIMIT || lastTs >= nowMs) break;
      cursor = lastTs + 1;
    }

    if (newCandles.length === 0 && priorCandles.length === 0) {
      return { pair, timeframe, status: "skipped" };
    }

    const merged = mergeAndSort(priorCandles, newCandles);
    const { error: uploadError } = await supabase.storage
      .from(MARKET_DATA_BUCKET)
      .upload(path, new Blob([JSON.stringify(merged)], { type: "application/json" }), { upsert: true });
    if (uploadError) throw new Error(`Storage upload failed: ${uploadError.message}`);

    await prisma.marketDataCache.upsert({
      where: { exchange_pair_timeframe: { exchange: DATA_SOURCE_EXCHANGE, pair, timeframe } },
      create: {
        exchange: DATA_SOURCE_EXCHANGE,
        pair,
        timeframe,
        storagePath: path,
        candleCount: merged.length,
        firstCandleAt: new Date(merged[0][0]),
        lastCandleAt: new Date(merged[merged.length - 1][0]),
      },
      update: {
        candleCount: merged.length,
        firstCandleAt: new Date(merged[0][0]),
        lastCandleAt: new Date(merged[merged.length - 1][0]),
      },
    });

    return { pair, timeframe, status: "updated", candleCount: merged.length };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error(`[market-data-cache] refresh failed for ${pair} ${timeframe}:`, err);
    return { pair, timeframe, status: "error", error: message };
  }
}

export interface RefreshSummary {
  exchange: string;
  pairs: string[];
  timeframes: string[];
  updated: number;
  skipped: number;
  failed: number;
  errors: Array<{ pair: string; timeframe: string; error: string }>;
}

// Refreshes the shared cache for the current top-N-by-volume pairlist (the
// same set an auto-select bot's VolumePairList would use — see
// AUTO_PAIRLIST_SIZE's own doc comment in lib/hetzner.ts) plus
// DEFAULT_CORR_PAIRLIST's correlation-only pair, across every cached
// timeframe. Bounded concurrency (same reasoning the old client-side
// downloader used): don't open dozens of simultaneous exchange calls at
// once. Never throws for a single pair/timeframe failure — see refreshOne.
export async function refreshMarketDataCache(): Promise<RefreshSummary> {
  const supabase = serviceRoleClient();
  const { data: topPairs } = await fetchTopVolumeStakePairs(AUTO_PAIRLIST_SIZE);
  const pairs = Array.from(new Set([...topPairs, ...DEFAULT_CORR_PAIRLIST]));

  const tasks: Array<{ pair: string; timeframe: string }> = [];
  for (const pair of pairs) {
    for (const timeframe of CACHED_TIMEFRAMES) {
      tasks.push({ pair, timeframe });
    }
  }

  const results: RefreshOneResult[] = [];
  const CONCURRENCY = 4;
  let nextIndex = 0;
  async function worker() {
    for (;;) {
      const index = nextIndex++;
      if (index >= tasks.length) return;
      results.push(await refreshOne(supabase, tasks[index].pair, tasks[index].timeframe));
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker));

  return {
    exchange: DATA_SOURCE_EXCHANGE,
    pairs,
    timeframes: CACHED_TIMEFRAMES,
    updated: results.filter((r) => r.status === "updated").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "error").length,
    errors: results
      .filter((r): r is RefreshOneResult & { error: string } => r.status === "error" && !!r.error)
      .map((r) => ({ pair: r.pair, timeframe: r.timeframe, error: r.error })),
  };
}

export interface CachedTrainingData {
  /** Every pair with complete, fresh cached data for all requested timeframes — includes DEFAULT_CORR_PAIRLIST's correlation-only pair if present. */
  pairs: string[];
  files: Array<{ pair: string; timeframe: string; downloadUrl: string }>;
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

  const byPair = new Map<string, typeof rows>();
  for (const row of rows) {
    const group = byPair.get(row.pair) ?? [];
    group.push(row);
    byPair.set(row.pair, group);
  }
  const usableRows = Array.from(byPair.values())
    .filter((group) => group.length === timeframes.length)
    .flat();
  if (usableRows.length === 0) return null;

  const supabase = serviceRoleClient();
  const paths = usableRows.map((row) => row.storagePath);
  const { data: signedUrls, error } = await supabase.storage.from(MARKET_DATA_BUCKET).createSignedUrls(paths, 3600);
  if (error || !signedUrls) return null;

  const byPairSigned = new Map<string, Array<{ pair: string; timeframe: string; downloadUrl: string }>>();
  usableRows.forEach((row, i) => {
    const entry = signedUrls[i];
    if (!entry || entry.error || !entry.signedUrl) return;
    const group = byPairSigned.get(row.pair) ?? [];
    group.push({ pair: row.pair, timeframe: row.timeframe, downloadUrl: entry.signedUrl });
    byPairSigned.set(row.pair, group);
  });

  const files = Array.from(byPairSigned.values())
    .filter((group) => group.length === timeframes.length)
    .flat();
  if (files.length === 0) return null;

  const pairs = Array.from(new Set(files.map((f) => f.pair)));
  // include_corr_pairlist needs this pair's data regardless of mode — a
  // cache missing it entirely isn't usable for training at all, not just
  // for this one pair.
  if (!DEFAULT_CORR_PAIRLIST.every((p) => pairs.includes(p))) return null;

  return { pairs, files };
}
