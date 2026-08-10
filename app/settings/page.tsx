import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { Navbar } from "@/components/Navbar";
import { TelegramSettingsForm } from "@/components/TelegramSettingsForm";
import { DataServerAdminPanel } from "@/components/DataServerAdminPanel";
import { isAdminUser } from "@/lib/admin";

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
  const profile = await prisma.profile.upsert({
    where: { id: user.id },
    update: {},
    create: { id: user.id },
    select: { telegramChatId: true },
  });

  return (
    <div className="min-h-screen bg-background">
      <Navbar />
      <main className="mx-auto max-w-2xl px-4 pb-24 pt-6 sm:px-6 sm:py-10 md:pb-10">
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight">Instellingen</h1>
          <p className="mt-1 text-sm text-slate-400">Accountbreed — geldt voor elke bot die je (her)deployt.</p>
        </div>

        <TelegramSettingsForm initialChatId={profile.telegramChatId} />

        {/* Operator-only — see lib/admin.ts. Manages the one permanent
            data server this app depends on (app/api/admin/data-server). */}
        {isAdminUser(user.email) && (
          <div className="mt-6">
            <DataServerAdminPanel />
          </div>
        )}
      </main>
    </div>
  );
}
