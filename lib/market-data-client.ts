import ccxt, { type Exchange } from "ccxt";
import { DATA_SOURCE_EXCHANGES, STAKE_CURRENCY } from "@/lib/hetzner";

// Public-data counterpart to lib/ccxt-client.ts (which handles the
// authenticated, per-user balance calls) — this one never takes API
// credentials, since it only ever reads public market data. Used by
// lib/market-data-cache.ts's daily refresh job (POST /api/data/refresh) to
// fetch candles/tickers for the shared, persistent market-data cache, and
// by the classic VM-side download-data fallback (lib/hetzner.ts) when
// that cache isn't usable for a given bot.
//
// Mirrors lib/ccxt-client.ts's CCXT_ID_OVERRIDES — empty today since our
// exchange ids (including "gate") already match ccxt's own exported class
// names; kept as an explicit table for any future real mismatch.
const CCXT_ID_OVERRIDES: Record<string, string> = {};

function resolveCcxtId(exchangeName: string): string {
  return CCXT_ID_OVERRIDES[exchangeName] ?? exchangeName;
}

const CCXT_TIMEOUT_MS = 12_000;

function buildPublicExchange(exchangeName: string): Exchange {
  const ccxtId = resolveCcxtId(exchangeName);
  const ExchangeClass = (ccxt as unknown as Record<string, new (config: Record<string, unknown>) => Exchange>)[
    ccxtId
  ];
  if (!ExchangeClass) {
    throw new Error(`ccxt has no exchange class for "${exchangeName}" (resolved id: "${ccxtId}")`);
  }
  return new ExchangeClass({ enableRateLimit: true, timeout: CCXT_TIMEOUT_MS });
}

export class MarketDataError extends Error {}

export interface MarketDataResult<T> {
  data: T;
  /** Which of DATA_SOURCE_EXCHANGES actually served this request — surfaced to the client for the same per-attempt visibility the VM-side training script already logs. */
  source: string;
}

// Tries each of DATA_SOURCE_EXCHANGES in order, same fallback pattern (and
// same reasoning — see lib/hetzner.ts's own doc comment on
// DATA_SOURCE_EXCHANGE) as the VM-side download-data step, just done here
// per single API call instead of per whole download.
async function withDataSourceFallback<T>(fn: (exchange: Exchange) => Promise<T>): Promise<MarketDataResult<T>> {
  let lastErr: unknown;
  for (const exchangeName of DATA_SOURCE_EXCHANGES) {
    try {
      const exchange = buildPublicExchange(exchangeName);
      const data = await fn(exchange);
      return { data, source: exchangeName };
    } catch (err) {
      lastErr = err;
      console.error(`[market-data-client] ${exchangeName} failed, trying next source if any:`, err);
    }
  }
  const message = lastErr instanceof Error ? lastErr.message : "Unknown error";
  throw new MarketDataError(`Every data source failed (tried: ${DATA_SOURCE_EXCHANGES.join(", ")}): ${message}`);
}

// Ranks by 24h quoteVolume and takes the top `limit` — mirrors exactly
// what VolumePairList (sort_key: "quoteVolume", number_assets:
// AUTO_PAIRLIST_SIZE) hands to FreqAI for a live auto-select bot, see
// buildPairlistConfig in lib/hetzner.ts. Backs lib/market-data-cache.ts's
// daily refresh job — caching literally every active USDT spot market
// (matching the classic VM-side download-data step's own ".*/USDT" regex
// expansion) would mean thousands of pair/timeframe files for a cache
// that's supposed to stay small and fast to serve.
// buildFreqAITrainingArtifacts's resolvedAutoSelectPairs param is what
// makes this safe: the training run's pairlist gets frozen to exactly the
// cached top-N (a StaticPairList) rather than leaving VolumePairList to
// re-rank by volume again at backtest time, so there's no risk of the VM
// wanting data for a pair the cache doesn't have.
export async function fetchTopVolumeStakePairs(limit: number): Promise<MarketDataResult<string[]>> {
  return withDataSourceFallback(async (exchange) => {
    const markets = await exchange.loadMarkets();
    const stakePairs = new Set(
      Object.values(markets)
        .filter((m) => m && m.spot && m.active !== false && m.quote === STAKE_CURRENCY)
        .map((m) => m!.symbol),
    );
    if (!exchange.has["fetchTickers"]) {
      throw new MarketDataError(`${exchange.id} does not support fetchTickers, cannot rank pairs by volume`);
    }
    const tickers = await exchange.fetchTickers();
    return Object.values(tickers)
      .filter((t): t is typeof t & { symbol: string } => !!t?.symbol && stakePairs.has(t.symbol))
      .sort((a, b) => (b.quoteVolume ?? 0) - (a.quoteVolume ?? 0))
      .slice(0, limit)
      .map((t) => t.symbol);
  });
}

export interface OhlcvPage {
  /** [timestampMs, open, high, low, close, volume][], ascending by timestamp — ccxt's own fetchOHLCV shape, which already matches freqtrade's JSON OHLCV file format exactly (see freqtrade/data/history/datahandlers/jsondatahandler.py). */
  candles: number[][];
}

// One page of OHLCV candles for a single pair/timeframe, starting at
// sinceMs — lib/market-data-cache.ts's refresh job calls this repeatedly,
// advancing sinceMs by the last returned candle's own timestamp + 1, until a
// short/empty page signals it has reached "now". Deliberately thin: ccxt's
// fetchOHLCV already normalizes pagination-cursor differences between
// exchanges, candle-limit differences, and symbol formatting — there is no
// exchange-specific logic left to write here.
export async function fetchOhlcvPage(pair: string, timeframe: string, sinceMs: number, limit: number): Promise<MarketDataResult<OhlcvPage>> {
  return withDataSourceFallback(async (exchange) => {
    const candles = await exchange.fetchOHLCV(pair, timeframe, sinceMs, limit);
    return { candles: candles as unknown as number[][] };
  });
}
