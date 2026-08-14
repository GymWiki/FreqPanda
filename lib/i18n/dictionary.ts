// The Dictionary type is derived from the Dutch dictionary's own shape
// (see nl.ts) rather than declared separately — that's what makes a
// missing or extra key in en.ts a compile error instead of a silent
// runtime gap. Every other locale file must satisfy this exact shape.
import type { nl } from "./nl";

export type Dictionary = typeof nl;

export type Locale = "nl" | "en";

export const SUPPORTED_LOCALES: Locale[] = ["nl", "en"];

export const DEFAULT_LOCALE: Locale = "nl";

export function isLocale(value: string): value is Locale {
  return (SUPPORTED_LOCALES as string[]).includes(value);
}
