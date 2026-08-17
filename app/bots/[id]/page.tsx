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
}

// The detail page a dashboard card (components/BotCard.tsx) links to —
// mirrors app/dashboard/page.tsx's server-fetch pattern, just scoped to
// one bot instead of the whole fleet. A bot that doesn't exist, or belongs
// to someone else, renders the same 404 either way — not found and not
// yours are indistinguishable from the outside, on purpose.
export default async function BotDetailPage({ params }: BotDetailPageProps) {
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
            <BotDetailView bot={toBotDTO(bot)} />
          </ErrorBoundary>
        </main>
      </div>
    </I18nProvider>
  );
}
