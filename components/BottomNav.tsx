"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Bot, Settings } from "lucide-react";
import { cn } from "@/lib/utils";
import { getDictionary, type Locale } from "@/lib/i18n";

// Exchange-account management moved from its own global "Platformen" tab
// into each bot's own card (see components/BotCard.tsx, components/
// ConnectExchangeDialog.tsx) — there's no longer a bot-independent
// "platforms" screen for this tab to point at.
function tabs(dict: ReturnType<typeof getDictionary>) {
  return [
    { href: "/dashboard", label: dict.nav.myBots, icon: Bot },
    { href: "/settings", label: dict.nav.settings, icon: Settings },
  ] as const;
}

// The mobile alternative to a sidebar (per the design brief: no complex
// sidebars on small screens) — fixed to the viewport bottom, thumb reach
// on any phone size. Desktop keeps Navbar's inline text links instead
// (this is md:hidden); rendered only when Navbar already confirmed an
// authenticated session, so no separate auth check here — but auth alone
// isn't enough to gate this: a signed-in user can still land on "/" (the
// marketing page also renders <Navbar />), and this nav's own destinations
// don't include it, so it stays hidden there and only appears once the
// user has actually navigated into one of the three tabs below.
//
// Takes `locale` (a plain string) as a prop from Navbar, not the resolved
// dict — Navbar is a server component, BottomNav a client component, and a
// Dictionary's values include functions, which can't cross a Server-to-
// Client props boundary (React throws at render time). getDictionary() is
// resolved here instead, client-side, from that plain locale string.
//
// Doesn't use useDictionary() either: this component can render on pages
// that never set up an <I18nProvider> at all (Navbar renders on "/", the
// public marketing page, too), so it can't assume that context exists.
export function BottomNav({ locale }: { locale: Locale }) {
  const pathname = usePathname();
  const TABS = tabs(getDictionary(locale));
  const isOnAppRoute = TABS.some(({ href }) => pathname === href || pathname.startsWith(`${href}/`));
  if (!isOnAppRoute) return null;

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-background/95 backdrop-blur md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto flex max-w-6xl items-stretch justify-around">
        {TABS.map(({ href, label, icon: Icon }) => {
          const isActive = pathname === href || pathname.startsWith(`${href}/`);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex min-w-[64px] flex-1 flex-col items-center gap-0.5 py-2.5 text-[11px] font-medium transition",
                isActive ? "text-primary" : "text-slate-500",
              )}
              aria-current={isActive ? "page" : undefined}
            >
              <Icon className="h-5 w-5" />
              {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
