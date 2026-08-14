"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Languages, Loader2 } from "lucide-react";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";
import type { Locale } from "@/lib/i18n";

const LANGUAGE_LABELS: Record<Locale, string> = {
  nl: "Nederlands",
  en: "English",
};

export function LanguageSwitcher({ initialLocale }: { initialLocale: Locale }) {
  const dict = useDictionary();
  const router = useRouter();
  const [locale, setLocale] = useState(initialLocale);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleChange(next: Locale) {
    if (next === locale) return;
    setError(null);
    setIsSaving(true);
    const previous = locale;
    setLocale(next); // optimistic — feels instant, reverted below on failure
    try {
      await apiFetch("/api/account/locale", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ locale: next }),
      });
      // Every server component (this page included) re-renders with the
      // new locale — see app/settings/page.tsx's own getUserLocale call.
      router.refresh();
    } catch (err) {
      setLocale(previous);
      setError(toErrorMessage(err, dict.settings.languageSaveFailed));
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <div className="card-surface p-6">
      <div className="mb-4 flex items-center gap-2">
        <Languages className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">{dict.settings.languageLabel}</h2>
      </div>

      <div className="flex items-center gap-2">
        {(Object.keys(LANGUAGE_LABELS) as Locale[]).map((code) => (
          <button
            key={code}
            type="button"
            onClick={() => handleChange(code)}
            disabled={isSaving}
            aria-pressed={locale === code}
            className={`rounded-lg border px-4 py-2 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
              locale === code
                ? "border-primary bg-primary/10 text-primary"
                : "border-slate-700 text-slate-300 hover:bg-slate-800"
            }`}
          >
            {LANGUAGE_LABELS[code]}
          </button>
        ))}
        {isSaving && <Loader2 className="h-4 w-4 animate-spin text-slate-500" />}
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
