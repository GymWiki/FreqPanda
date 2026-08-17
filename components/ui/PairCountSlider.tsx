"use client";

import { useDictionary } from "@/components/I18nProvider";
import { AUTO_PAIRLIST_SIZE_RANGE } from "@/lib/training-timerange";

interface PairCountSliderProps {
  value: number;
  onChange: (value: number) => void;
}

// Below this many pairs there's too little diversification for the advice
// copy to still call it "narrow but fast"; above it, training time starts
// dominating the experience. Three bands, not five — this is directional
// guidance for a slider, not a precision instrument.
const LOW_BAND_MAX = 40;
const HIGH_BAND_MIN = 120;

// freqtrade's download-data fetches one pair/timeframe combination at a
// time — empirically ~3-4s each against this app's data source (see
// DATA_SOURCE_EXCHANGE in lib/hetzner.ts). 4 timeframes is this app's own
// per-strategy count (baseTimeframe + includeTimeframes — see
// STRATEGY_PRESETS in lib/strategy-presets.ts) rounded to one number simple
// enough to drive a live, moving estimate rather than a per-strategy exact
// figure. This estimates the download step specifically (the part that
// actually scales with the slider) — backtesting itself afterwards costs
// roughly the same regardless of how many pairs were downloaded.
const SECONDS_PER_PAIR_PER_TIMEFRAME = 3.5;
const TIMEFRAMES_PER_TRAINING_RUN = 4;

function estimateSeconds(pairCount: number): number {
  return pairCount * TIMEFRAMES_PER_TRAINING_RUN * SECONDS_PER_PAIR_PER_TIMEFRAME;
}

// Replaces the old fixed AUTO_PAIRLIST_SIZE constant (see
// AUTO_PAIRLIST_SIZE_RANGE/DEFAULT in lib/hetzner.ts) with a value the user
// picks per bot — how many of the exchange's top-liquid USDT markets
// VolumePairList hands to FreqAI when auto-select is on. Mirrors
// BudgetSlider's layout (label row + value, range input, hint box below)
// so the bot-creation form reads as one consistent slider language.
export function PairCountSlider({ value, onChange }: PairCountSliderProps) {
  const dict = useDictionary();
  const { min, max } = AUTO_PAIRLIST_SIZE_RANGE;

  const advice =
    value <= LOW_BAND_MAX
      ? dict.pairCountSlider.adviceLow
      : value >= HIGH_BAND_MIN
        ? dict.pairCountSlider.adviceHigh
        : dict.pairCountSlider.adviceMedium;

  const totalSeconds = estimateSeconds(value);
  const minutes = Math.round(totalSeconds / 60);
  const estimatedTime =
    minutes < 1
      ? dict.pairCountSlider.underAMinute
      : minutes < 60
        ? dict.pairCountSlider.minutesEstimate(minutes)
        : dict.pairCountSlider.hoursEstimate(Math.round((minutes / 60) * 2) / 2);

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-center justify-between text-xs text-slate-400">
          <span>{dict.pairCountSlider.label}</span>
          <span className="font-mono font-semibold text-primary">{value}</span>
        </div>
        <input
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="mt-1.5 w-full accent-primary"
          aria-label={dict.pairCountSlider.ariaLabel}
        />
      </div>

      <p className="rounded-lg bg-background px-3 py-2 text-[11px] leading-relaxed text-slate-400">{advice}</p>
      <p className="rounded-lg bg-background px-3 py-2 text-[11px] leading-relaxed text-slate-400">
        {dict.pairCountSlider.estimatedTimeLabel(estimatedTime)}
      </p>
    </div>
  );
}
