import { notFound, redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { Navbar } from "@/components/Navbar";
import { BotDetailView } from "@/components/BotDetailView";
import { I18nProvider } from "@/components/I18nProvider";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { botSelect, toBotDTO } from "@/lib/bot-select";
import { getUserLocale } from "@/lib/profile-locale";

interface BotDetailPageProps {
  params: { id: string };
  // Set by the "New Bot" wizard's own navigation right after creating a
  // bot (see NewBotDialog's handleSubmit) — ?autostart=1 makes this page
  // immediately kick off local training (FreqAI) or a backtest (rule-
  // based) instead of leaving a freshly created bot idle until the user
  // clicks a button; ?connectExchange=1 opens the exchange-linking dialog
  // right away too, if that's what the user chose in the wizard's
  // exchange step. Both are read-once flags for BotDetailView, not
  // persisted state — a plain page refresh drops them, same as any other
  // one-time "just arrived from a specific action" signal.
  searchParams: { autostart?: string; connectExchange?: string };
}

// The detail page a dashboard card (components/BotCard.tsx) links to —
// mirrors app/dashboard/page.tsx's server-fetch pattern, just scoped to
// one bot instead of the whole fleet. A bot that doesn't exist, or belongs
// to someone else, renders the same 404 either way — not found and not
// yours are indistinguishable from the outside, on purpose.
export default async function BotDetailPage({ params, searchParams }: BotDetailPageProps) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    redirect("/login");
  }

  const [botOwnership, locale] = await Promise.all([
    prisma.botConfiguration.findUnique({ where: { id: params.id }, select: { userId: true } }),
    getUserLocale(user.id),
  ]);

  if (!botOwnership || botOwnership.userId !== user.id) {
    notFound();
  }

  const bot = await prisma.botConfiguration.findUniqueOrThrow({ where: { id: params.id }, select: botSelect });

  return (
    <I18nProvider locale={locale}>
      <div className="min-h-screen bg-background">
        <Navbar />
        <main>
          <ErrorBoundary>
            <BotDetailView
              bot={toBotDTO(bot)}
              autoStart={searchParams.autostart === "1"}
              autoConnectExchange={searchParams.connectExchange === "1"}
            />
          </ErrorBoundary>
        </main>
      </div>
    </I18nProvider>
  );
}
