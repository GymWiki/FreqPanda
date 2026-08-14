"use client";

import { useState, type FormEvent } from "react";
import { Loader2, X } from "lucide-react";
import { InfoTooltip } from "@/components/ui/Tooltip";
import { ExchangeCombobox } from "@/components/ui/ExchangeCombobox";
import { EXCHANGE_PRESETS } from "@/lib/exchange-presets";
import type { ExchangeConnectionDTO } from "@/lib/types";
import type { FreeBalance } from "@/lib/ccxt-client";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";

interface ConnectExchangeDialogProps {
  botId: string;
  botName: string;
  // Null the first time a bot connects an account — nothing chose an
  // exchange for it at creation anymore (see prisma/schema.prisma). Once
  // set, it's immutable, so every later "Vervang" call reuses it and skips
  // the picker below.
  exchangeName: string | null;
  onConnected: (connection: ExchangeConnectionDTO) => void;
  onClose: () => void;
}

// Bot-scoped equivalent of the old, now-removed /platforms "Platform
// koppelen" dialog — same shape (exchange + API key/secret). The exchange
// itself is only a choice here the very first time: once ExchangeConnection
// exists (botId is unique — see prisma/schema.prisma), the bot's
// exchangeName is fixed, and every later "Vervang" call reuses it rather
// than showing the picker again. POST validates the credentials with a
// real balance call before saving anything — see
// app/api/bots/[id]/exchange-connection.
export function ConnectExchangeDialog({ botId, botName, exchangeName, onConnected, onClose }: ConnectExchangeDialogProps) {
  const dict = useDictionary();
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [pickedExchangeName, setPickedExchangeName] = useState(exchangeName ?? EXCHANGE_PRESETS[0].id);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const effectiveExchangeName = exchangeName ?? pickedExchangeName;
  const preset = EXCHANGE_PRESETS.find((e) => e.id === effectiveExchangeName);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const data = await apiFetch<{ connection: ExchangeConnectionDTO; balance: FreeBalance }>(
        `/api/bots/${botId}/exchange-connection`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            apiKey,
            apiSecret,
            ...(exchangeName === null && { exchangeName: pickedExchangeName }),
          }),
        },
      );
      onConnected(data.connection);
      onClose();
    } catch (err) {
      setError(toErrorMessage(err, dict.connectExchange.connectFailed));
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="card-surface flex max-h-[90vh] w-full max-w-md flex-col p-6">
        <div className="mb-4 flex shrink-0 items-center justify-between">
          <div>
            <h2 className="font-semibold">{dict.connectExchange.heading}</h2>
            <p className="text-xs text-slate-400">
              {exchangeName
                ? dict.connectExchange.subtitleWithExchange(botName, preset?.label ?? exchangeName)
                : dict.connectExchange.subtitleWithoutExchange(botName)}
              {dict.connectExchange.subtitleSuffix}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 shrink-0 items-center justify-center text-slate-400 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex min-h-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto pr-1">
            {exchangeName === null && (
              <label className="block">
                <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
                  {dict.connectExchange.exchangeLabel}
                  <InfoTooltip text={dict.connectExchange.exchangeHint} />
                </span>
                <ExchangeCombobox
                  value={pickedExchangeName}
                  onChange={setPickedExchangeName}
                  aria-label={dict.connectExchange.exchangeLabel}
                />
              </label>
            )}

            {preset && (
              <p className="rounded-lg bg-background px-3 py-2 text-[11px] leading-relaxed text-slate-400">
                {preset.feeNote}
              </p>
            )}

            <label className="block">
              <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
                {dict.connectExchange.apiKeyLabel}
                <InfoTooltip text={dict.connectExchange.apiKeyHint} />
              </span>
              <input
                required
                type="password"
                autoComplete="off"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                className="input"
                placeholder={dict.connectExchange.secretPlaceholder}
              />
            </label>

            <label className="block">
              <span className="mb-1 flex items-center gap-1.5 text-xs font-medium text-slate-400">
                {dict.connectExchange.apiSecretLabel}
                <InfoTooltip text={dict.connectExchange.apiSecretHint} />
              </span>
              <input
                required
                type="password"
                autoComplete="off"
                value={apiSecret}
                onChange={(e) => setApiSecret(e.target.value)}
                className="input"
                placeholder={dict.connectExchange.secretPlaceholder}
              />
            </label>

            {error && (
              <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </p>
            )}
          </div>

          <button
            type="submit"
            disabled={isSubmitting}
            className="mt-4 flex w-full shrink-0 items-center justify-center gap-2 rounded-lg bg-primary px-4 py-3 text-sm font-semibold text-background transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
            {isSubmitting ? dict.connectExchange.verifying : dict.connectExchange.submit}
          </button>
        </form>
      </div>
    </div>
  );
}
