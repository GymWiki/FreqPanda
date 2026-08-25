import type { Dictionary } from "@/lib/i18n";

export type BacktestTone = "negative" | "caution" | "positive";

export interface BacktestInterpretation {
  tone: BacktestTone;
  text: string;
}

// A one-sentence, plain-language reading to sit next to the raw backtest
// numbers — someone with no trading background shouldn't have to work out
// for themselves whether "-4.20%" or "62% win-rate" is good or bad. Kept
// deliberately simple (a handful of thresholds on profit% and drawdown%,
// not a scoring model) — the goal is a sane, honest nudge in plain
// language, not a precise verdict.
//
// Returns null only when totalProfitPct itself is null (the one field
// this can't say anything sensible about without) — every other input can
// be missing and this still degrades gracefully, same as the raw stat
// tiles it sits next to.
export function interpretBacktestResult(
  result: { totalProfitPct: number | null; maxDrawdownPct: number | null },
  dict: Dictionary,
): BacktestInterpretation | null {
  const { totalProfitPct, maxDrawdownPct } = result;
  if (totalProfitPct === null) return null;

  const highDrawdown = maxDrawdownPct !== null && maxDrawdownPct >= 30;

  if (totalProfitPct <= -10) {
    return { tone: "negative", text: dict.backtestResults.interpretationStronglyNegative };
  }
  if (totalProfitPct < 0) {
    return { tone: "negative", text: dict.backtestResults.interpretationNegative };
  }
  if (highDrawdown) {
    return { tone: "caution", text: dict.backtestResults.interpretationHighDrawdown };
  }
  if (totalProfitPct >= 15) {
    return { tone: "positive", text: dict.backtestResults.interpretationStronglyPositive };
  }
  return { tone: "positive", text: dict.backtestResults.interpretationPositive };
}
