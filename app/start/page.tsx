import { redirect } from "next/navigation";
import Link from "next/link";
import { Manrope, Space_Grotesk } from "next/font/google";
import { ArrowRight } from "lucide-react";
import { createClient } from "@/lib/supabase/server";

// Desktop-app entry screen (see src-tauri/tauri.conf.json's app.windows[0].url)
// — deliberately not the full marketing page (app/page.tsx): someone who
// already has the app installed has no use for feature lists or download
// buttons for the very app they're running. Same page-scoped font stack as
// app/page.tsx, kept out of app/layout.tsx for the same reason: only this
// FreqPanda-branded surface uses it, the dashboard/settings pages keep the
// app-wide Inter/JetBrains Mono untouched.
const displayFont = Space_Grotesk({ subsets: ["latin"], variable: "--font-panda-display" });
const bodyFont = Manrope({ subsets: ["latin"], variable: "--font-panda-body" });

export default async function DesktopStartPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // A returning, already-signed-in desktop user should never sit on a
  // splash screen — straight to the bot fleet, every launch after the first.
  if (user) {
    redirect("/dashboard");
  }

  return (
    <div
      className={`${displayFont.variable} ${bodyFont.variable} flex min-h-screen flex-col items-center justify-center bg-panda-ink px-6 font-panda-body text-panda-cream`}
    >
      <div className="flex flex-col items-center gap-8 text-center">
        <div className="flex items-center gap-2">
          <span className="text-2xl leading-none">🐼</span>
          <span className="font-panda-display text-lg font-semibold tracking-tight">FreqPanda</span>
        </div>

        <div className="relative">
          <div className="flex h-32 w-32 items-center justify-center rounded-full border-2 border-dashed border-panda-bamboo/40 bg-panda-charcoal text-6xl">
            🐼
          </div>
          <div className="absolute -bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full bg-panda-bamboo px-3 py-1.5 text-xs font-medium text-panda-ink shadow-md">
            Ik train, jij chillt 🎋
          </div>
        </div>

        <Link
          href="/login"
          className="mt-4 flex items-center gap-2 rounded-xl bg-panda-bamboo px-6 py-3.5 text-sm font-semibold text-panda-ink shadow-lg shadow-panda-bamboo/20 transition hover:bg-panda-bamboo-deep"
        >
          Start met traden
          <ArrowRight className="h-4 w-4" />
        </Link>
      </div>
    </div>
  );
}
