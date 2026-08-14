import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { Navbar } from "@/components/Navbar";
import { TelegramSettingsForm } from "@/components/TelegramSettingsForm";
import { DataServerAdminPanel } from "@/components/DataServerAdminPanel";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { I18nProvider } from "@/components/I18nProvider";
import { isAdminUser } from "@/lib/admin";
import { getUserLocale } from "@/lib/profile-locale";
import { getDictionary } from "@/lib/i18n";

export default async function SettingsPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  // upsert (not findUniqueOrThrow) for the same reason as app/dashboard/page.tsx
  // — self-heals a lagging signup trigger instead of crashing the page.
  // locale is read separately (getUserLocale) rather than added to this
  // select: that helper tolerates the column not existing yet (migration
  // rollout window), this upsert's own select shouldn't gain that same
  // failure mode for a field the rest of this query doesn't need.
  const [profile, locale] = await Promise.all([
    prisma.profile.upsert({
      where: { id: user.id },
      update: {},
      create: { id: user.id },
      select: { telegramChatId: true },
    }),
    getUserLocale(user.id),
  ]);
  const dict = getDictionary(locale);

  return (
    <I18nProvider locale={locale}>
      <div className="min-h-screen bg-background">
        <Navbar />
        <main className="mx-auto max-w-2xl px-4 pb-24 pt-6 sm:px-6 sm:py-10 md:pb-10">
          <div className="mb-8">
            <h1 className="text-2xl font-bold tracking-tight">{dict.settings.title}</h1>
            <p className="mt-1 text-sm text-slate-400">{dict.settings.subtitle}</p>
          </div>

          <div className="space-y-6">
            <LanguageSwitcher initialLocale={locale} />
            <TelegramSettingsForm initialChatId={profile.telegramChatId} />

            {/* Operator-only — see lib/admin.ts. Manages the one permanent
                data server this app depends on (app/api/admin/data-server). */}
            {isAdminUser(user.email) && <DataServerAdminPanel />}
          </div>
        </main>
      </div>
    </I18nProvider>
  );
}
