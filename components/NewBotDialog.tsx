"use client";

import { useId, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ChevronLeft, ChevronRight, Loader2, Plus, X } from "lucide-react";
import type { BotConfigurationDTO, StrategyType } from "@/lib/types";
import { InfoTooltip } from "@/components/ui/Tooltip";
import { StrategyPicker } from "@/components/ui/StrategyPicker";
import { RuleBasedPicker } from "@/components/ui/RuleBasedPicker";
import { PairSelector } from "@/components/ui/PairSelector";
import { Switch } from "@/components/ui/Switch";
import { PairCountSlider } from "@/components/ui/PairCountSlider";
import { STRATEGY_PRESETS, type StrategyPreset } from "@/lib/strategy-presets";
import { RULE_BASED_PRESETS, type RuleBasedPreset } from "@/lib/rule-based-presets";
import { AUTO_PAIRLIST_SIZE_DEFAULT } from "@/lib/training-timerange";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";
import { isTauri } from "@/lib/tauri";
import { cn } from "@/lib/utils";

interface NewBotDialogProps {
  onCreated: (bot: BotConfigurationDTO) => void;
}

const DEFAULT_STRATEGY = STRATEGY_PRESETS[0];
const DEFAULT_RULE_BASED_STRATEGY = RULE_BASED_PRESETS[0];
const TOTAL_STEPS = 4;

const EMPTY_FORM = {
  botName: "",
  strategyType: "FREQAI" as StrategyType,
  strategyId: DEFAULT_STRATEGY.id,
  ruleBasedStrategyId: DEFAULT_RULE_BASED_STRATEGY.id,
  autoSelectCoins: true,
  autoSelectPairCount: AUTO_PAIRLIST_SIZE_DEFAULT,
  pairs: ["BTC/USDT", "ETH/USDT"] as string[],
  // Purely a UI choice, never sent to POST /api/bots — see handleSubmit's
  // own comment for why exchange-linking can't actually happen until a
  // bot exists (ConnectExchangeDialog needs a real botId to validate
  // credentials against). This only decides whether the freshly created
  // bot's own detail page opens that dialog automatically.
  connectExchangeAfterCreate: false,
};

// A stepped wizard rather than one long form: someone with no technical
// background should only ever face one decision at a time, each with a
// sensible default already picked — never a wall of fields. Every step
// keeps its own concern: name+strategy, exchange (clearly optional — see
// step 2's own copy for why it can't be handled here), coins, confirm.
// Confirming on step 4 does more than create the bot: for the desktop app
// (isTauri()) it navigates straight to the new bot's detail page with a
// query flag that makes it auto-start training/backtesting immediately
// — see app/bots/[id]/page.tsx and BotDetailView's autoStart prop — so
// finishing this wizard actually gets you a bot that's already working,
// not just a row on the dashboard waiting for another click.
export function NewBotDialog({ onCreated }: NewBotDialogProps) {
  const dict = useDictionary();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);
  const [form, setForm] = useState(EMPTY_FORM);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedStrategy: StrategyPreset =
    STRATEGY_PRESETS.find((s) => s.id === form.strategyId) ?? DEFAULT_STRATEGY;
  const selectedRuleBasedStrategy: RuleBasedPreset =
    RULE_BASED_PRESETS.find((s) => s.id === form.ruleBasedStrategyId) ?? DEFAULT_RULE_BASED_STRATEGY;
  const isRuleBased = form.strategyType === "RULE_BASED";
  const onDesktop = isTauri();

  function closeAndReset() {
    setForm(EMPTY_FORM);
    setStep(1);
    setError(null);
    setOpen(false);
  }

  function goNext() {
    if (step === 3 && !form.autoSelectCoins && form.pairs.length === 0) {
      setError(dict.newBot.validationNeedsPairs);
      return;
    }
    setError(null);
    setStep((s) => Math.min(s + 1, TOTAL_STEPS));
  }

  function goBack() {
    setError(null);
    setStep((s) => Math.max(s - 1, 1));
  }

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
          strategyType: form.strategyType,
          strategy: isRuleBased ? selectedRuleBasedStrategy.className : selectedStrategy.className,
          strategyCode: isRuleBased ? selectedRuleBasedStrategy.code : selectedStrategy.code,
          // Omitted entirely for a rule-based bot — the API rejects a
          // freqaiConfig on a RULE_BASED bot outright (see
          // app/api/bots/route.ts), it doesn't just ignore one.
          freqaiConfig: isRuleBased ? undefined : selectedStrategy.freqaiConfig,
          autoSelectCoins: form.autoSelectCoins,
          autoSelectPairCount: form.autoSelectPairCount,
          pairWhitelist: form.autoSelectCoins ? undefined : form.pairs.join(","),
        }),
      });
      onCreated(data.bot);
      closeAndReset();

      if (onDesktop) {
        // Only the desktop app can actually train/backtest locally (Docker
        // + Tauri, see BotDetailView) — on the web, land on the same page
        // but without the auto-start flag, since there's nothing for it to
        // trigger there.
        const params = new URLSearchParams({ autostart: "1" });
        if (form.connectExchangeAfterCreate) params.set("connectExchange", "1");
        router.push(`/bots/${data.bot.id}?${params.toString()}`);
      } else {
        router.push(`/bots/${data.bot.id}`);
      }
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

  const submitLabel = !onDesktop ? dict.newBot.submit : isRuleBased ? dict.newBot.submitAndBacktest : dict.newBot.submitAndTrain;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card-surface flex max-h-[90vh] w-full max-w-lg flex-col p-6">
        <div className="mb-1 flex shrink-0 items-center justify-between">
          <div>
            <h2 className="font-semibold">{dict.newBot.heading}</h2>
            <p className="text-xs text-slate-400">{dict.newBot.intro}</p>
          </div>
          <button type="button" onClick={closeAndReset} className="text-slate-400 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <WizardProgress step={step} />

        <form
          onSubmit={(e) => {
            // The Enter key (or a step's own "Volgende" button, which is
            // type="button") should never submit early — only step 4's
            // real submit button does, via handleSubmit below.
            if (step < TOTAL_STEPS) {
              e.preventDefault();
              goNext();
              return;
            }
            handleSubmit(e);
          }}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1 pt-3">
            {step === 1 && (
              <>
                <Field label={dict.newBot.botNameLabel}>
                  <input
                    required
                    autoFocus
                    value={form.botName}
                    onChange={(e) => setForm({ ...form, botName: e.target.value })}
                    className="input"
                    placeholder={dict.newBot.botNamePlaceholder}
                  />
                </Field>

                <FieldGroup label={dict.newBot.botTypeLabel}>
                  <div role="radiogroup" aria-label={dict.newBot.botTypeLabel} className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    {(["FREQAI", "RULE_BASED"] as const).map((type) => {
                      const checked = form.strategyType === type;
                      return (
                        <button
                          key={type}
                          type="button"
                          role="radio"
                          aria-checked={checked}
                          onClick={() => setForm({ ...form, strategyType: type })}
                          className={cn(
                            "flex flex-col gap-1 rounded-lg border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                            checked ? "border-primary bg-primary/10" : "border-border bg-background hover:border-primary/40",
                          )}
                        >
                          <span className={cn("text-sm font-semibold", checked ? "text-primary" : "text-slate-100")}>
                            {type === "FREQAI" ? dict.newBot.botTypeFreqAI : dict.newBot.botTypeRuleBased}
                          </span>
                          <p className="text-xs leading-relaxed text-slate-400">
                            {type === "FREQAI" ? dict.newBot.botTypeFreqAIDescription : dict.newBot.botTypeRuleBasedDescription}
                          </p>
                        </button>
                      );
                    })}
                  </div>
                </FieldGroup>

                <FieldGroup
                  label={isRuleBased ? dict.newBot.ruleBasedStrategyLabel : dict.newBot.aiBehaviorLabel}
                  tooltip={isRuleBased ? undefined : dict.newBot.aiBehaviorTooltip}
                >
                  {isRuleBased ? (
                    <RuleBasedPicker
                      selectedId={form.ruleBasedStrategyId}
                      onSelect={(preset) => setForm({ ...form, ruleBasedStrategyId: preset.id })}
                    />
                  ) : (
                    <StrategyPicker
                      selectedId={form.strategyId}
                      onSelect={(preset) => setForm({ ...form, strategyId: preset.id })}
                    />
                  )}
                </FieldGroup>
              </>
            )}

            {step === 2 && (
              <FieldGroup label={dict.newBot.step2Title}>
                <p className="mb-3 text-xs leading-relaxed text-slate-400">{dict.newBot.step2Intro}</p>
                <div role="radiogroup" aria-label={dict.newBot.step2Title} className="grid grid-cols-1 gap-2">
                  {([false, true] as const).map((connectNow) => {
                    const checked = form.connectExchangeAfterCreate === connectNow;
                    return (
                      <button
                        key={String(connectNow)}
                        type="button"
                        role="radio"
                        aria-checked={checked}
                        onClick={() => setForm({ ...form, connectExchangeAfterCreate: connectNow })}
                        className={cn(
                          "flex flex-col gap-1 rounded-lg border p-3 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
                          checked ? "border-primary bg-primary/10" : "border-border bg-background hover:border-primary/40",
                        )}
                      >
                        <span className={cn("text-sm font-semibold", checked ? "text-primary" : "text-slate-100")}>
                          {connectNow ? dict.newBot.step2ConnectTitle : dict.newBot.step2SkipTitle}
                        </span>
                        <p className="text-xs leading-relaxed text-slate-400">
                          {connectNow ? dict.newBot.step2ConnectDescription : dict.newBot.step2SkipDescription}
                        </p>
                      </button>
                    );
                  })}
                </div>
              </FieldGroup>
            )}

            {step === 3 && (
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
                    <>
                      <p className="rounded-lg bg-background px-3 py-2 text-[11px] leading-relaxed text-slate-400">
                        {dict.newBot.autoSelectHint}
                      </p>
                      <PairCountSlider
                        value={form.autoSelectPairCount}
                        onChange={(autoSelectPairCount) => setForm({ ...form, autoSelectPairCount })}
                      />
                    </>
                  ) : (
                    <PairSelector selected={form.pairs} onChange={(pairs) => setForm({ ...form, pairs })} />
                  )}
                </div>
              </FieldGroup>
            )}

            {step === 4 && (
              <div className="space-y-4">
                <p className="text-xs text-slate-400">{dict.newBot.step4ReadyIntro}</p>
                <dl className="space-y-2 rounded-lg border border-border bg-background p-3 text-xs">
                  <SummaryRow label={dict.newBot.step4SummaryName} value={form.botName || "—"} />
                  <SummaryRow
                    label={dict.newBot.step4SummaryType}
                    value={isRuleBased ? dict.newBot.botTypeRuleBased : dict.newBot.botTypeFreqAI}
                  />
                  <SummaryRow
                    label={dict.newBot.step4SummaryStrategy}
                    value={isRuleBased ? selectedRuleBasedStrategy.title : selectedStrategy.title}
                  />
                  <SummaryRow
                    label={dict.newBot.step4SummaryPairs}
                    value={form.autoSelectCoins ? dict.newBot.step4SummaryPairsAuto(form.autoSelectPairCount) : form.pairs.join(", ")}
                  />
                  <SummaryRow
                    label={dict.newBot.step4SummaryExchange}
                    value={form.connectExchangeAfterCreate ? dict.newBot.step4SummaryExchangeNow : dict.newBot.step4SummaryExchangeLater}
                  />
                </dl>

                <p className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 px-3 py-2.5 text-[11px] leading-relaxed text-emerald-300">
                  {dict.newBot.practiceModeNoticePrefix}
                  <strong>{dict.newBot.practiceModeNoticeBold}</strong>
                  {dict.newBot.practiceModeNoticeSuffix}
                </p>

                {!onDesktop && (
                  <p className="rounded-lg bg-background px-3 py-2 text-[11px] leading-relaxed text-slate-400">
                    {dict.newBot.submitWebOnlyNote}
                  </p>
                )}
              </div>
            )}

            {error && (
              <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </p>
            )}
          </div>

          <div className="mt-4 flex shrink-0 items-center gap-2">
            {step > 1 && (
              <button
                type="button"
                onClick={goBack}
                className="flex items-center gap-1.5 rounded-lg border border-border px-3 py-2 text-sm font-medium text-slate-300 transition hover:border-primary/40 hover:text-white"
              >
                <ChevronLeft className="h-4 w-4" />
                {dict.newBot.stepBack}
              </button>
            )}
            <button
              type="submit"
              disabled={isSubmitting || (step === 1 && !form.botName.trim())}
              className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-background transition hover:bg-primary-hover disabled:opacity-50"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {step < TOTAL_STEPS ? (
                <>
                  {dict.newBot.stepNext}
                  <ChevronRight className="h-4 w-4" />
                </>
              ) : (
                submitLabel
              )}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function WizardProgress({ step }: { step: number }) {
  const dict = useDictionary();
  return (
    <div className="mb-2 shrink-0">
      <p className="mb-1.5 text-[11px] font-medium text-slate-500">{dict.newBot.stepIndicator(step, TOTAL_STEPS)}</p>
      <div className="flex gap-1.5">
        {Array.from({ length: TOTAL_STEPS }, (_, i) => i + 1).map((s) => (
          <div key={s} className={cn("h-1 flex-1 rounded-full transition-colors", s <= step ? "bg-primary" : "bg-border")} />
        ))}
      </div>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-slate-500">{label}</dt>
      <dd className="truncate text-right font-medium text-slate-200">{value}</dd>
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
