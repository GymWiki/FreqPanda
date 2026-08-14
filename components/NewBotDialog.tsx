"use client";

import { useId, useState, type FormEvent } from "react";
import { Loader2, Plus, X } from "lucide-react";
import type { BotConfigurationDTO } from "@/lib/types";
import { InfoTooltip } from "@/components/ui/Tooltip";
import { StrategyPicker } from "@/components/ui/StrategyPicker";
import { PairSelector } from "@/components/ui/PairSelector";
import { Switch } from "@/components/ui/Switch";
import { STRATEGY_PRESETS, type StrategyPreset } from "@/lib/strategy-presets";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";

interface NewBotDialogProps {
  onCreated: (bot: BotConfigurationDTO) => void;
}

const DEFAULT_STRATEGY = STRATEGY_PRESETS[0];

const EMPTY_FORM = {
  botName: "",
  strategyId: DEFAULT_STRATEGY.id,
  autoSelectCoins: true,
  pairs: ["BTC/USDT", "ETH/USDT"] as string[],
};

// No exchange choice here at all — training and paper trading run against
// a fixed public data source (see DATA_SOURCE_EXCHANGE in lib/hetzner.ts),
// decoupled from any exchange this bot might eventually connect to. The
// exchange itself only gets picked later, on the bot's own card, at the
// "Koppel exchange account" step (see ConnectExchangeDialog) — required
// only once the user actually wants to go live.
export function NewBotDialog({ onCreated }: NewBotDialogProps) {
  const dict = useDictionary();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedStrategy: StrategyPreset =
    STRATEGY_PRESETS.find((s) => s.id === form.strategyId) ?? DEFAULT_STRATEGY;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);

    if (!form.autoSelectCoins && form.pairs.length === 0) {
      setError(dict.newBot.validationNeedsPairs);
      return;
    }

    setIsSubmitting(true);
    try {
      const data = await apiFetch<{ bot: BotConfigurationDTO }>("/api/bots", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          botName: form.botName,
          strategy: selectedStrategy.className,
          strategyCode: selectedStrategy.code,
          freqaiConfig: selectedStrategy.freqaiConfig,
          autoSelectCoins: form.autoSelectCoins,
          pairWhitelist: form.autoSelectCoins ? undefined : form.pairs.join(","),
        }),
      });
      onCreated(data.bot);
      setForm(EMPTY_FORM);
      setOpen(false);
    } catch (err) {
      setError(toErrorMessage(err, dict.newBot.createFailed));
    } finally {
      setIsSubmitting(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex items-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-background transition hover:bg-primary-hover"
      >
        <Plus className="h-4 w-4" />
        {dict.newBot.trigger}
      </button>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card-surface flex max-h-[90vh] w-full max-w-lg flex-col p-6">
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <div>
            <h2 className="font-semibold">{dict.newBot.heading}</h2>
            <p className="text-xs text-slate-400">{dict.newBot.intro}</p>
          </div>
          <button type="button" onClick={() => setOpen(false)} className="text-slate-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            <Field label={dict.newBot.botNameLabel}>
              <input
                required
                value={form.botName}
                onChange={(e) => setForm({ ...form, botName: e.target.value })}
                className="input"
                placeholder={dict.newBot.botNamePlaceholder}
              />
            </Field>

            <FieldGroup label={dict.newBot.aiBehaviorLabel}>
              <StrategyPicker
                selectedId={form.strategyId}
                onSelect={(preset) => setForm({ ...form, strategyId: preset.id })}
              />
            </FieldGroup>

            <FieldGroup label={dict.newBot.pairsLabel}>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2.5">
                  <span id="auto-select-coins-label" className="text-xs font-medium text-slate-200">
                    {dict.newBot.autoSelectLabel} <span className="text-primary">{dict.newBot.recommended}</span>
                  </span>
                  <Switch
                    checked={form.autoSelectCoins}
                    onChange={(autoSelectCoins) => setForm({ ...form, autoSelectCoins })}
                    aria-labelledby="auto-select-coins-label"
                  />
                </div>

                {form.autoSelectCoins ? (
                  <p className="rounded-lg bg-background px-3 py-2 text-[11px] leading-relaxed text-slate-400">
                    {dict.newBot.autoSelectHint}
                  </p>
                ) : (
                  <PairSelector selected={form.pairs} onChange={(pairs) => setForm({ ...form, pairs })} />
                )}
              </div>
            </FieldGroup>

            <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-emerald-300">
              {dict.newBot.practiceModeNoticePrefix}
              <strong>{dict.newBot.practiceModeNoticeBold}</strong>
              {dict.newBot.practiceModeNoticeSuffix}
            </p>

            {error && (
              <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-4 flex w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-background transition hover:bg-primary-hover disabled:opacity-50"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {dict.newBot.submit}
          </button>
        </form>
      </div>
    </div>
  );
}

// For a field with exactly one native form control — a real <label>
// wrapper gives correct implicit association with no downsides.
function Field({
  label,
  tooltip,
  children,
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </span>
      {children}
    </label>
  );
}

// For a field built from a composite widget with multiple interactive
// descendants (StrategyPicker, PairSelector, the platform picker above).
// Wrapping several buttons in a native <label> is a real bug, not just a
// style nit: once a click handler mutates the DOM (e.g. removing the
// first button), the browser's own label-click-forwarding step
// re-evaluates "the label's control" against the *new* DOM and fires a
// second, spurious click on whatever button ends up first — observed
// here as removing one selected pair silently removing a second one too.
// A plain group with aria-labelledby gives the same accessible name
// without that behavior.
function FieldGroup({
  label,
  tooltip,
  children,
}: {
  label: string;
  tooltip?: string;
  children: React.ReactNode;
}) {
  const labelId = useId();
  return (
    <div>
      <span id={labelId} className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
        {label}
        {tooltip && <InfoTooltip text={tooltip} />}
      </span>
      <div role="group" aria-labelledby={labelId}>
        {children}
      </div>
    </div>
  );
}
