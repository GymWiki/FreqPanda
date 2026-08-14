import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { prisma } from "@/lib/prisma";
import { withErrorHandling, parseJsonBody } from "@/lib/api-handler";
import { SUPPORTED_LOCALES } from "@/lib/i18n";

export const dynamic = "force-dynamic";

const localeBodySchema = z.object({
  locale: z.enum(SUPPORTED_LOCALES as [string, ...string[]]),
});

// Same PATCH-a-Profile-field shape as app/api/account/telegram — the
// client calls router.refresh() after a successful save (see
// components/LanguageSwitcher.tsx) so every server component re-renders
// in the new language immediately, no full reload needed.
export const PATCH = withErrorHandling(async (req: NextRequest) => {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseJsonBody(req, localeBodySchema);
  if ("error" in parsed) return parsed.error;

  const profile = await prisma.profile.upsert({
    where: { id: user.id },
    update: { locale: parsed.data.locale },
    create: { id: user.id, locale: parsed.data.locale },
    select: { locale: true },
  });

  return NextResponse.json({ locale: profile.locale });
});
