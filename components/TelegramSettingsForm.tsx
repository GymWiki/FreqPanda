"use client";

import { useState, type FormEvent } from "react";
import { Check, Loader2, Send, Unlink } from "lucide-react";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";

interface TelegramSettingsFormProps {
  initialChatId: string | null;
}

// Deliberately the simple, manual-entry version: the user pastes the
// numeric chat id our central bot needs, rather than us running a
// deep-link + webhook flow that auto-captures it. That's the natural next
// iteration if this needs to feel more "magic" later, but it's a genuinely
// separate feature (a public Telegram webhook receiver, a linking-code
// scheme back to the Supabase user) — not just a UI tweak on this one.
export function TelegramSettingsForm({ initialChatId }: TelegramSettingsFormProps) {
  const dict = useDictionary();
  const [chatId, setChatId] = useState(initialChatId ?? "");
  const [savedChatId, setSavedChatId] = useState(initialChatId);
  const [isSaving, setIsSaving] = useState(false);
  const [isUnlinking, setIsUnlinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSaving(true);
    try {
      const data = await apiFetch<{ telegramChatId: string | null }>("/api/account/telegram", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramChatId: chatId.trim() || null }),
      });
      setSavedChatId(data.telegramChatId);
      setJustSaved(true);
      setTimeout(() => setJustSaved(false), 2000);
    } catch (err) {
      setError(toErrorMessage(err, dict.telegram.saveFailed));
    } finally {
      setIsSaving(false);
    }
  }

  async function handleUnlink() {
    setError(null);
    setIsUnlinking(true);
    try {
      await apiFetch<{ telegramChatId: string | null }>("/api/account/telegram", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ telegramChatId: null }),
      });
      setSavedChatId(null);
      setChatId("");
    } catch (err) {
      setError(toErrorMessage(err, dict.telegram.unlinkFailed));
    } finally {
      setIsUnlinking(false);
    }
  }

  // Set at build time by the operator (the same account that owns
  // TELEGRAM_BOT_TOKEN server-side) — not fabricated here, since a wrong
  // guessed @handle would send the user looking for a bot that doesn't
  // exist. Falls back to generic wording when unset.
  const botUsername = process.env.NEXT_PUBLIC_TELEGRAM_BOT_USERNAME;

  return (
    <div className="card-surface p-6">
      <div className="mb-4 flex items-center gap-2">
        <Send className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">{dict.telegram.heading}</h2>
      </div>

      <ol className="mb-4 list-decimal space-y-1.5 pl-4 text-xs text-slate-400">
        <li>
          {botUsername ? (
            dict.telegram.stepOneWithUsername(botUsername)
          ) : (
            dict.telegram.stepOneFallback
          )}
        </li>
        <li>
          {dict.telegram.stepTwoPrefix}
          <a
            href="https://t.me/userinfobot"
            target="_blank"
            rel="noreferrer"
            className="text-primary hover:text-primary-hover"
          >
            {dict.telegram.stepTwoLinkLabel}
          </a>
          {dict.telegram.stepTwoSuffix}
        </li>
        <li>{dict.telegram.stepThree}</li>
      </ol>

      <form onSubmit={handleSubmit} className="flex items-end gap-2">
        <label className="block flex-1">
          <span className="mb-1 block text-xs font-medium text-slate-400">{dict.telegram.chatIdLabel}</span>
          <input
            value={chatId}
            onChange={(e) => setChatId(e.target.value)}
            placeholder={dict.telegram.chatIdPlaceholder}
            inputMode="numeric"
            className="input"
          />
        </label>
        <button
          type="submit"
          disabled={isSaving || chatId.trim() === (savedChatId ?? "")}
          className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-background transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : justSaved ? <Check className="h-4 w-4" /> : null}
          {dict.telegram.save}
        </button>
      </form>

      {savedChatId && (
        <button
          type="button"
          onClick={handleUnlink}
          disabled={isUnlinking}
          className="mt-3 flex items-center gap-1.5 text-[11px] text-slate-500 transition hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isUnlinking ? <Loader2 className="h-3 w-3 animate-spin" /> : <Unlink className="h-3 w-3" />}
          {dict.telegram.unlink}
        </button>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
