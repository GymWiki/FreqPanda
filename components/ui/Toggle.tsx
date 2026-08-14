"use client";

import { cn } from "@/lib/utils";
import { useDictionary } from "@/components/I18nProvider";
import { InfoTooltip } from "@/components/ui/Tooltip";

interface TrainingModeToggleProps {
  mode: "LOCAL" | "CLOUD";
  onChange: (mode: "LOCAL" | "CLOUD") => void;
  disabled?: boolean;
}

// The tooltip trigger is a real <button>, so it can't nest inside the
// toggle's own <button> (invalid HTML, and it'd eat the toggle's click) —
// rendered as a sibling row above the switch instead.
export function TrainingModeToggle({ mode, onChange, disabled }: TrainingModeToggleProps) {
  const dict = useDictionary();
  const isCloud = mode === "CLOUD";
  return (
    <div className="flex w-full items-center gap-1.5">
      <button
        type="button"
        role="switch"
        aria-checked={isCloud}
        disabled={disabled}
        onClick={() => onChange(isCloud ? "LOCAL" : "CLOUD")}
        className={
          // One color variant regardless of LOCAL/CLOUD — matches
          // components/ui/Switch.tsx, which never varies its on-color either.
          // Was accent (gold) for CLOUD and primary (green) for LOCAL, which
          // made an otherwise-identical control look like two different
          // components depending on state.
          "flex min-w-0 flex-1 items-center justify-between rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-xs font-medium text-primary transition disabled:cursor-not-allowed disabled:opacity-50"
        }
      >
        <span>{isCloud ? dict.trainingToggle.cloud : dict.trainingToggle.local}</span>
        <span className={cn("relative h-5 w-9 shrink-0 rounded-full transition", isCloud ? "bg-primary" : "bg-border")}>
          <span
            className={cn(
              // left-0.5 pins the thumb's resting position explicitly — left
              // unset here would resolve to the track's horizontal center
              // (inherited text-align:center from the parent button's UA
              // default), not its left edge, pushing the "on" translate past
              // the track's right side. See components/ui/Switch.tsx for the
              // same fix with the full explanation.
              "absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white transition-transform",
              isCloud ? "translate-x-4" : "translate-x-0",
            )}
          />
        </span>
      </button>
      <InfoTooltip text={dict.trainingToggle.tooltip} />
    </div>
  );
}
