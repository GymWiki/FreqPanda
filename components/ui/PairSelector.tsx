"use client";

import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { PAIR_PRESETS } from "@/lib/pair-presets";
import { useDictionary } from "@/components/I18nProvider";

interface PairSelectorProps {
  selected: string[];
  onChange: (pairs: string[]) => void;
}

// Replaces a comma-separated free-text field with clickable chips, so a
// beginner can't typo a pair symbol into something the exchange rejects.
export function PairSelector({ selected, onChange }: PairSelectorProps) {
  const dict = useDictionary();
  function toggle(symbol: string) {
    onChange(selected.includes(symbol) ? selected.filter((s) => s !== symbol) : [...selected, symbol]);
  }

  return (
    <div className="space-y-2">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {selected.map((symbol) => (
            <span
              key={symbol}
              className="flex items-center gap-1 rounded-full border border-primary/40 bg-primary/10 py-0.5 pl-2.5 pr-1 text-xs font-medium text-primary"
            >
              {symbol}
              <button
                type="button"
                onClick={() => toggle(symbol)}
                aria-label={dict.pairSelector.removeAriaLabel(symbol)}
                className="rounded-full p-0.5 transition hover:bg-primary/20"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5" role="group" aria-label={dict.pairSelector.availableAriaLabel}>
        {PAIR_PRESETS.map(({ symbol, label }) => {
          const checked = selected.includes(symbol);
          return (
            <button
              key={symbol}
              type="button"
              aria-pressed={checked}
              onClick={() => toggle(symbol)}
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs font-medium transition",
                checked
                  ? "border-primary bg-primary/10 text-primary"
                  : "border-border bg-background text-slate-300 hover:border-primary/40 hover:text-primary",
              )}
            >
              {symbol}
              <span className="text-slate-500"> · {label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
