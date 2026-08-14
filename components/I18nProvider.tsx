"use client";

import { createContext, useContext } from "react";
import type { Dictionary } from "@/lib/i18n";

const DictionaryContext = createContext<Dictionary | null>(null);

// Server components (app/dashboard/page.tsx, app/settings/page.tsx) fetch
// the user's Profile once, resolve it to a Dictionary via getUserLocale +
// getDictionary, and wrap their tree in this so every client component
// further down — BotCard, NewBotDialog and its children, etc. — can reach
// it via useDictionary() instead of every one of them re-fetching the
// profile or receiving `dict` as a prop threaded through several layers.
export function I18nProvider({ dict, children }: { dict: Dictionary; children: React.ReactNode }) {
  return <DictionaryContext.Provider value={dict}>{children}</DictionaryContext.Provider>;
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
