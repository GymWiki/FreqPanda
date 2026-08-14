import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { Navbar } from "@/components/Navbar";
import { BotFleetGrid } from "@/components/BotFleetGrid";
import { PnlChart } from "@/components/PnlChart";
import { I18nProvider } from "@/components/I18nProvider";
import { botSelect, toBotDTO } from "@/lib/bot-select";
import { getUserLocale } from "@/lib/profile-locale";
import { getDictionary } from "@/lib/i18n";

export default async function DashboardPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [profile, bots, locale] = await Promise.all([
    // A Supabase trigger creates this row on signup (see the profiles
    // migration), but upsert instead of findUniqueOrThrow so a lagging or
    // failed trigger self-heals into a default profile instead of crashing
    // the whole dashboard with a P2025. The update clause doubles as Sleep
    // Mode's activity signal — a dashboard load is exactly "the user is
    // here" (see app/api/bots/sleep-sweep, which reads this same column) —
    // piggybacking on the query this page already needs instead of adding
    // a second write per page load.
    prisma.profile.upsert({
      where: { id: user.id },
      update: { lastActiveAt: new Date() },
      create: { id: user.id },
      select: { vpsBotQuota: true },
    }),
    prisma.botConfiguration.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "desc" },
      select: botSelect,
    }),
    // Separate try/catch-wrapped lookup (see getUserLocale) rather than
    // added to the upsert's own select — same reasoning as
    // app/settings/page.tsx: a missing locale column shouldn't be able to
    // break the upsert this page actually depends on.
    getUserLocale(user.id),
  ]);

  const botDTOs = bots.map(toBotDTO);
  const activeVpsBots = botDTOs.filter((b) => b.deploymentStatus === "VPS_ACTIVE").length;
  const dict = getDictionary(locale);

  return (
    <I18nProvider dict={dict}>
      <div className="min-h-screen bg-background">
        <Navbar />
        <main className="mx-auto max-w-6xl px-4 pb-24 pt-6 sm:px-6 sm:py-10 md:pb-10">
          <div className="mb-8 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight">{dict.dashboard.title}</h1>
              <p className="mt-1 text-sm text-slate-400">{dict.dashboard.activeBots(activeVpsBots, profile.vpsBotQuota)}</p>
            </div>
          </div>

          <div className="mb-6">
            <PnlChart />
          </div>

          <BotFleetGrid initialBots={botDTOs} vpsBotQuota={profile.vpsBotQuota} />
        </main>
      </div>
    </I18nProvider>
  );
}
