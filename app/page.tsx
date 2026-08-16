import Link from "next/link";
import { Manrope, Space_Grotesk, IBM_Plex_Mono } from "next/font/google";
import { ArrowRight, Cpu, Cloud, Download, ShieldCheck, Gauge, GitBranch } from "lucide-react";
import { createClient } from "@/lib/supabase/server";
import { SignOutButton } from "@/components/AuthButtons";

// Same page-scoped FreqPanda type stack as app/platform/page.tsx — kept out
// of app/layout.tsx so it doesn't touch typography anywhere else (the
// dashboard/platforms/settings pages keep the app-wide Inter/JetBrains Mono
// untouched). Landing and /platform are the two FreqPanda-branded surfaces.
const displayFont = Space_Grotesk({ subsets: ["latin"], variable: "--font-panda-display" });
const bodyFont = Manrope({ subsets: ["latin"], variable: "--font-panda-body" });
const monoFont = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500"], variable: "--font-panda-mono" });

// Resolves to whatever the latest *published* GitHub Release's matching
// installer is, live, on every click (see app/api/download/route.ts) — so
// the button always starts a real download immediately instead of
// dropping the visitor on the GitHub releases page. Falls back to that
// releases page itself only if nothing's been published yet.
const DOWNLOAD_WINDOWS_URL = "/api/download?platform=windows";
const DOWNLOAD_MAC_URL = "/api/download?platform=mac";

const FEATURES = [
  {
    icon: Cpu,
    title: "Train gratis, lokaal",
    description:
      "Train je FreqAI-model op je eigen computer via de Desktop App — geen rekenkosten voor backtesting of hyperopt.",
  },
  {
    icon: Cloud,
    title: "Eén klik naar de cloud",
    description:
      "Zet een getrainde strategie live op een eigen VPS die 24/7 doortrade, zonder dat jouw laptop aan hoeft te blijven.",
  },
  {
    icon: Gauge,
    title: "Betaal per bot",
    description:
      "Geen abonnement per stoel — je betaalt alleen voor de bots die je daadwerkelijk live laat draaien.",
  },
  {
    icon: ShieldCheck,
    title: "Jouw sleutels, versleuteld",
    description:
      "Exchange-API-sleutels worden versleuteld opgeslagen en pas bij het live zetten in je bot geïnjecteerd.",
  },
  {
    icon: GitBranch,
    title: "Paper of live — jij kiest",
    description:
      "Elke bot start in paper trading, zodat je een strategie risicovrij kan testen voor je 'm live zet.",
  },
];

export default async function LandingPage() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  return (
    <div
      className={`${displayFont.variable} ${bodyFont.variable} ${monoFont.variable} min-h-screen bg-panda-ink font-panda-body text-panda-cream`}
    >
      <header className="sticky top-0 z-50 border-b border-panda-charcoal-light bg-panda-ink/90 backdrop-blur">
        <nav className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2">
            <img src="/logo/panda-bg-64.png" alt="FreqPanda" className="h-7 w-7 rounded-full" />
            <span className="font-panda-display text-lg font-semibold tracking-tight text-panda-cream">
              FreqPanda
            </span>
          </Link>
          <div className="flex items-center gap-3">
            {user ? (
              <>
                <SignOutButton className="hidden text-sm font-medium text-panda-mist transition hover:text-panda-cream sm:inline" />
                <Link
                  href="/dashboard"
                  className="rounded-full bg-panda-bamboo px-4 py-2 text-sm font-semibold text-panda-ink transition hover:bg-panda-bamboo-deep"
                >
                  Naar dashboard
                </Link>
              </>
            ) : (
              <Link
                href="/login"
                className="rounded-full bg-panda-bamboo px-4 py-2 text-sm font-semibold text-panda-ink transition hover:bg-panda-bamboo-deep"
              >
                Inloggen
              </Link>
            )}
          </div>
        </nav>
      </header>

      <main>
        <section className="relative overflow-hidden px-4 pb-16 pt-14 sm:px-6 sm:pb-24 sm:pt-20">
          {/* Soft bamboo glow — same atmospheric device as PandaHero on
              /platform, purely decorative, sits behind the mascot. */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-24 -top-24 h-72 w-72 rounded-full bg-panda-bamboo/20 blur-3xl"
          />

          <div className="relative mx-auto flex max-w-6xl flex-col items-center gap-10 text-center lg:flex-row lg:items-center lg:text-left">
            <div className="max-w-xl">
              <div className="mx-auto inline-flex items-center gap-2 rounded-full bg-panda-charcoal px-4 py-1.5 font-panda-mono text-[11px] uppercase tracking-[0.2em] text-panda-mist lg:mx-0">
                <span className="h-1.5 w-1.5 rounded-full bg-panda-bamboo" />
                Gebouwd op Freqtrade &amp; FreqAI
              </div>
              <h1 className="mt-6 font-panda-display text-4xl font-semibold leading-tight text-panda-cream sm:text-5xl lg:text-6xl">
                Train lokaal. <span className="text-panda-bamboo">Trade in de cloud.</span>
              </h1>
              <p className="mt-5 text-base leading-relaxed text-panda-mist sm:text-lg">
                FreqPanda splitst het werk waar het hoort: zware FreqAI-modellen train je gratis op
                je eigen hardware via de Desktop App. Daarna zet één klik je bot 24/7 live op een
                cloud-VPS — je betaalt alleen zolang die draait.
              </p>
              <div className="mt-8 flex flex-col items-center gap-3 sm:flex-row lg:items-start">
                <Link
                  href={user ? "/dashboard" : "/login"}
                  className="flex items-center gap-2 rounded-xl bg-panda-bamboo px-6 py-3.5 text-sm font-semibold text-panda-ink shadow-lg shadow-panda-bamboo/20 transition hover:bg-panda-bamboo-deep"
                >
                  {user ? "Naar dashboard" : "Inloggen"}
                  <ArrowRight className="h-4 w-4" />
                </Link>
                <a
                  href={DOWNLOAD_WINDOWS_URL}
                  className="flex items-center gap-2 rounded-xl bg-panda-charcoal px-6 py-3.5 text-sm font-semibold text-panda-cream transition hover:bg-panda-charcoal-light"
                >
                  <Download className="h-4 w-4" />
                  Download Desktop App
                </a>
              </div>
              <p className="mt-3 font-panda-mono text-xs text-panda-mist">
                macOS-build{" "}
                <a
                  href={DOWNLOAD_MAC_URL}
                  className="underline underline-offset-2 hover:text-panda-bamboo"
                >
                  hier beschikbaar
                </a>{" "}
                &middot; gratis, geen account nodig om lokaal te trainen
              </p>
            </div>

            {/* Mascot — this page's signature hero visual. */}
            <div className="relative shrink-0">
              <div className="h-40 w-40 overflow-hidden rounded-full border-2 border-dashed border-panda-bamboo/40 bg-panda-cream sm:h-52 sm:w-52">
                <img src="/logo/panda-bg-512.png" alt="FreqPanda" className="h-full w-full object-cover" />
              </div>
              <div className="absolute -left-6 top-2 rounded-full bg-panda-bamboo px-3 py-1.5 text-xs font-medium text-panda-ink shadow-md sm:-left-8">
                Ik train, jij chillt 🎋
              </div>
            </div>
          </div>
        </section>

        <section className="border-t border-panda-charcoal-light bg-panda-charcoal/30 px-4 py-16 sm:px-6 sm:py-20">
          <div className="mx-auto max-w-6xl">
            <div className="mb-12 text-center">
              <h2 className="font-panda-display text-2xl font-semibold text-panda-cream sm:text-3xl">
                Eén workflow, twee omgevingen
              </h2>
              <p className="mx-auto mt-3 max-w-xl text-sm text-panda-mist sm:text-base">
                Alles wat je nodig hebt om van strategie-idee naar een live, 24/7 tradende bot te
                gaan.
              </p>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, description }) => (
                <div key={title} className="rounded-2xl bg-panda-charcoal p-6 transition hover:bg-panda-charcoal-light">
                  <div className="flex h-10 w-10 items-center justify-center rounded-full bg-panda-bamboo/15 text-panda-bamboo">
                    <Icon className="h-5 w-5" />
                  </div>
                  <h3 className="mt-4 font-panda-display font-semibold text-panda-cream">{title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-panda-mist">{description}</p>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="px-4 py-16 text-center sm:px-6 sm:py-20">
          <div className="mx-auto max-w-2xl">
            <h2 className="font-panda-display text-2xl font-semibold text-panda-cream sm:text-3xl">
              Klaar om een bot aan het werk te zetten?
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-sm text-panda-mist sm:text-base">
              Download de Desktop App om gratis te beginnen met trainen, of ga direct naar het
              dashboard als je model al klaar staat.
            </p>
            <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
              <Link
                href={user ? "/dashboard" : "/login"}
                className="flex items-center gap-2 rounded-xl bg-panda-bamboo px-6 py-3.5 text-sm font-semibold text-panda-ink shadow-lg shadow-panda-bamboo/20 transition hover:bg-panda-bamboo-deep"
              >
                {user ? "Naar dashboard" : "Inloggen"}
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-panda-charcoal-light px-4 py-8 text-center font-panda-mono text-xs text-panda-mist sm:px-6">
        &copy; {new Date().getFullYear()} FreqPanda. Niet verbonden aan het open-source
        Freqtrade-project.
      </footer>
    </div>
  );
}
