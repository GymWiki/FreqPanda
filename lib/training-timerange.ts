import type { FreqAIProfileConfig } from "@/lib/strategy-presets";

// Pure, dependency-free module shared by lib/hetzner.ts (cloud-init
// generation) and lib/market-data-cache.ts (the daily cache-refresh job) so
// both compute training/backfill windows the exact same way — if these two
// ever drifted apart, the cache could hold a different range of candles
// than a training run expects to find.

// Live here (rather than only in lib/hetzner.ts, a server-only module that
// also pulls in the Hetzner API client) so lib/market-data-cache.ts can
// import just these two small values without the rest of lib/hetzner.ts.
// lib/hetzner.ts re-exports both so every existing import of them from
// "@/lib/hetzner" keeps working unchanged.
export const STAKE_CURRENCY = "USDT";
/** FreqAI's include_corr_pairlist benchmark pair — see lib/hetzner.ts's own doc comment (where this is re-exported) for why it's a fixed platform default rather than per-bot. */
export const DEFAULT_CORR_PAIRLIST = [`BTC/${STAKE_CURRENCY}`];

export const TIMEFRAME_MINUTES: Record<string, number> = {
  "1m": 1,
  "3m": 3,
  "5m": 5,
  "15m": 15,
  "30m": 30,
  "1h": 60,
  "2h": 120,
  "4h": 240,
  "6h": 360,
  "8h": 480,
  "12h": 720,
  "1d": 1440,
};

// Falls back to 60 (1h) for a timeframe we don't recognize — a
// conservative middle ground that neither wildly over- nor
// under-estimates a download-range buffer.
export function timeframeToMinutes(timeframe: string): number {
  return TIMEFRAME_MINUTES[timeframe] ?? 60;
}

// Needs enough history to fill the training window plus backtest window
// several times over, or FreqAI has nothing meaningful to train on — AND,
// regardless of which timeframe the preset uses, enough extra at the very
// front of the range for every indicator/feature to be fully warmed up
// (startupCandleCount candles' worth, converted to real days via the base
// timeframe) before FreqAI's own window even starts. Insufficient warm-up
// produces partial-NaN features on the earliest candles — a real source of
// spurious training noise, independent of anything FreqAI itself learned,
// i.e. exactly what generously over-provisioning history here is meant to
// rule out.
export function computeTrainingTimerangeDays(freqaiConfig: FreqAIProfileConfig): number {
  return Math.max(
    90,
    (freqaiConfig.training.trainPeriodDays + freqaiConfig.training.backtestPeriodDays) * 4,
    freqaiConfig.training.trainPeriodDays +
      freqaiConfig.training.backtestPeriodDays +
      Math.ceil(
        (freqaiConfig.features.startupCandleCount * timeframeToMinutes(freqaiConfig.features.baseTimeframe)) /
          (60 * 24),
      ),
  );
}

// yyyymmdd, freqtrade's own --timerange format (see buildFreqAITrainingArtifacts).
function fmtYyyymmdd(d: Date): string {
  return d.toISOString().slice(0, 10).replace(/-/g, "");
}

export interface TrainingTimerange {
  /** freqtrade's own "yyyymmdd-yyyymmdd" --timerange string. */
  timerangeString: string;
  /** Inclusive start of the range, as a millisecond timestamp — what a paginated fetch pages forward from. */
  startMs: number;
  /** End of the range (now), as a millisecond timestamp. */
  endMs: number;
}

export function computeTrainingTimerange(freqaiConfig: FreqAIProfileConfig, timerangeDays?: number): TrainingTimerange {
  const days = timerangeDays ?? computeTrainingTimerangeDays(freqaiConfig);
  const end = new Date();
  const start = new Date(end.getTime() - days * 24 * 60 * 60 * 1000);
  return {
    timerangeString: `${fmtYyyymmdd(start)}-${fmtYyyymmdd(end)}`,
    startMs: start.getTime(),
    endMs: end.getTime(),
  };
}
