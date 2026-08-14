import { nl } from "./nl";
import { en } from "./en";
import { type Dictionary, type Locale, DEFAULT_LOCALE, isLocale } from "./dictionary";

const DICTIONARIES: Record<Locale, Dictionary> = { nl, en };

// Accepts any string (e.g. straight out of Profile.locale, which is a
// plain `string` column, not a Postgres enum) and falls back to Dutch for
// anything unrecognized — a stray/legacy value should never crash a page,
// just render in the default language.
export function getDictionary(locale: string | null | undefined): Dictionary {
  if (locale && isLocale(locale)) return DICTIONARIES[locale];
  return DICTIONARIES[DEFAULT_LOCALE];
}

export type { Dictionary, Locale };
export { SUPPORTED_LOCALES, DEFAULT_LOCALE, isLocale } from "./dictionary";
