import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { SignInButton, SignOutButton } from "@/components/AuthButtons";
import { BottomNav } from "@/components/BottomNav";
import { getUserLocale } from "@/lib/profile-locale";
import { getDictionary } from "@/lib/i18n";

// Resolves its own dictionary (an extra, try/catch-wrapped Profile lookup
// — see getUserLocale) rather than expecting every page that renders
// <Navbar /> to pass one in: Navbar is a server component nested inside
// whatever page rendered it, so it can't reach a page-level I18nProvider's
// context (React Context providers created by Client Components can wrap
// Server Components, but a Server Component itself can never call
// useContext) — passing `dict` down as a prop from every call site would
// work too, but would leak this component's own i18n plumbing into every
// page that uses it instead of staying self-contained.
export async function Navbar() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const dict = getDictionary(user ? await getUserLocale(user.id) : undefined);

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-border bg-background/80 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <span className="text-2xl leading-none">🐼</span>
            {/* Full wordmark only where there's room — BottomNav (mobile)
                and these same three destinations, so nothing is lost by
                hiding it, just the branding is compacted. */}
            <span className="hidden font-display font-semibold tracking-tight text-slate-100 sm:inline">
              {dict.nav.brand}
            </span>
          </Link>
          <div className="flex items-center gap-3 sm:gap-4">
            {user ? (
              <>
                {/* Text links + the "Go to Dashboard" pill move into
                    BottomNav below md: — repeating them here too would
                    just be the overflowing row this replaces. */}
                <Link
                  href="/settings"
                  className="hidden text-sm font-medium text-slate-300 transition hover:text-primary md:inline"
                >
                  {dict.nav.settings}
                </Link>
                <Link
                  href="/dashboard"
                  className="hidden rounded-full bg-primary px-4 py-2 text-sm font-semibold text-background transition hover:bg-primary-hover md:inline-block"
                >
                  {dict.nav.toDashboard}
                </Link>
                <SignOutButton />
              </>
            ) : (
              <SignInButton />
            )}
          </div>
        </nav>
      </header>
      {user && <BottomNav dict={dict} />}
    </>
  );
}
