"use client";

import { createContext, useContext } from "react";
import { getDictionary, type Dictionary, type Locale } from "@/lib/i18n";

const DictionaryContext = createContext<Dictionary | null>(null);

// Server components (app/dashboard/page.tsx, app/settings/page.tsx) fetch
// the user's Profile once, resolve it to a Locale via getUserLocale, and
// wrap their tree in this so every client component further down — BotCard,
// NewBotDialog and its children, etc. — can reach the dictionary via
// useDictionary() instead of every one of them re-fetching the profile or
// receiving `dict` as a prop threaded through several layers.
//
// Takes `locale` (a plain string), not the resolved `dict` object: a
// Dictionary's values include functions (e.g. dashboard.activeBots), and
// React Server Components can only pass serializable data as props into a
// Client Component — a function crossing that boundary throws at render
// time ("Functions cannot be passed directly to Client Components...").
// getDictionary() itself is a pure lookup over plain, statically-imported
// objects (no server secrets, no I/O), so resolving it here on the client
// is exactly as safe as resolving it on the server was.
export function I18nProvider({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  return <DictionaryContext.Provider value={getDictionary(locale)}>{children}</DictionaryContext.Provider>;
}

// Throws instead of silently falling back to a default dictionary — a
// client component rendering outside an I18nProvider is a real bug (a
// forgotten wrapper), not a legitimate "no preference set yet" case; the
// default *locale* already has its own fallback (see getUserLocale), this
// is a different failure mode worth surfacing loudly during development.
export function useDictionary(): Dictionary {
  const dict = useContext(DictionaryContext);
  if (!dict) {
    throw new Error("useDictionary() called outside an <I18nProvider> — wrap this component's tree in one.");
  }
  return dict;
}
