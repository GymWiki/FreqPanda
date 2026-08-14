import { prisma } from "@/lib/prisma";
import { DEFAULT_LOCALE, type Locale } from "@/lib/i18n";

// Reads a user's display-language preference. Wrapped in try/catch
// deliberately: Profile.locale is a genuinely new column, added via a
// migration that may not have reached the live database yet by the time
// this code ships (Prisma throws on any query selecting a column Postgres
// doesn't have) — every page that renders in a language should still
// render, in the default language, rather than 500 during that window.
// Safe to simplify to a plain `profile.locale` read once the migration is
// confirmed applied everywhere this runs.
export async function getUserLocale(userId: string): Promise<Locale> {
  try {
    const profile = await prisma.profile.findUnique({ where: { id: userId }, select: { locale: true } });
    const locale = profile?.locale;
    return locale === "en" ? "en" : DEFAULT_LOCALE;
  } catch (err) {
    console.error("[profile-locale] Could not read Profile.locale (migration not applied yet?):", err);
    return DEFAULT_LOCALE;
  }
}
