"use client";

import { LineChart, TrendingUp, Waves, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { RULE_BASED_PRESETS, type RuleBasedPreset } from "@/lib/rule-based-presets";
import { useDictionary } from "@/components/I18nProvider";

const ICONS: Record<string, LucideIcon> = {
  "rb-rsi-macd": LineChart,
  "rb-trend-volume": TrendingUp,
  "rb-bollinger": Waves,
};

const RISK_STYLES: Record<RuleBasedPreset["risk"], string> = {
  Laag: "bg-emerald-500/10 text-emerald-300 border-emerald-500/30",
  Gemiddeld: "bg-amber-500/10 text-amber-300 border-amber-500/30",
  Hoog: "bg-red-500/10 text-red-300 border-red-500/30",
};

interface RuleBasedPickerProps {
  selectedId: string;
  onSelect: (preset: RuleBasedPreset) => void;
}

// The rule-based sibling of StrategyPicker (see lib/strategy-presets.ts's
// FreqAI cards) — same card layout, but for lib/rule-based-presets.ts's
// classic indicator strategies: no training, no model, just a fixed set of
// entry/exit rules. preset.title/description/risk/timeframe come from that
// file and are still Dutch-only regardless of the active language, same
// deferred-localization note as StrategyPicker.
export function RuleBasedPicker({ selectedId, onSelect }: RuleBasedPickerProps) {
  const dict = useDictionary();
  return (
    <div role="radiogroup" aria-label={dict.ruleBasedPicker.ariaLabel} className="grid grid-cols-1 gap-2 sm:grid-cols-3">
      {RULE_BASED_PRESETS.map((preset) => {
        const Icon = ICONS[preset.id] ?? LineChart;
        const checked = preset.id === selectedId;
        return (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={checked}
            onClick={() => onSelect(preset)}
            className={cn(
              "flex flex-col gap-2 rounded-lg border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
              checked
                ? "border-primary bg-primary/10"
                : "border-border bg-background hover:border-primary/40",
            )}
          >
            <div className="flex items-center justify-between">
              <Icon className={cn("h-5 w-5", checked ? "text-primary" : "text-slate-400")} />
              <span
                className={cn(
                  "rounded-full border px-1.5 py-0.5 text-[10px] font-medium",
                  RISK_STYLES[preset.risk],
                )}
              >
                {preset.risk}
                {dict.strategyPicker.riskSuffix}
              </span>
            </div>
            <div>
              <div className={cn("text-sm font-semibold", checked ? "text-primary" : "text-slate-100")}>
                {preset.title}
              </div>
              <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{preset.description}</p>
            </div>
            <span className="text-[11px] text-slate-500">
              {dict.ruleBasedPicker.timeframePrefix}
              {preset.timeframe}
            </span>
          </button>
        );
      })}
    </div>
  );
}
