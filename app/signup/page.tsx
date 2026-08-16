"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { CheckCircle2, Loader2, Lock, Mail, User } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function SignupPage() {
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [needsEmailConfirmation, setNeedsEmailConfirmation] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const supabase = createClient();
      const { data, error: signUpError } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: { name },
          // Without this, the confirmation email links back to whatever
          // Supabase's project "Site URL" is set to — which drifts stale
          // the moment the app moves domains (see NEXT_PUBLIC_APP_URL in
          // .env.example) and would send users to the wrong host instead
          // of this deployment's own /login.
          emailRedirectTo: `${window.location.origin}/login`,
        },
      });

      if (signUpError) {
        setError(
          signUpError.message === "User already registered"
            ? "Er bestaat al een account met dit e-mailadres"
            : signUpError.message,
        );
        return;
      }

      // Projects with "Confirm email" enabled don't return a session until
      // the user clicks the confirmation link — send them to /login with a
      // hint instead of a dashboard they can't actually reach yet.
      if (!data.session) {
        setNeedsEmailConfirmation(true);
        return;
      }

      router.push("/dashboard");
      router.refresh();
    } catch (err) {
      console.error("[SignupPage] Sign up failed:", err);
      setError("Registreren is mislukt. Probeer het opnieuw.");
    } finally {
      setIsSubmitting(false);
    }
  }

  if (needsEmailConfirmation) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-6">
        <div className="w-full max-w-sm text-center">
          <div className="card-surface p-6">
            <CheckCircle2 className="mx-auto h-10 w-10 text-primary" />
            <h1 className="mt-4 text-lg font-semibold">Bevestig je e-mailadres</h1>
            <p className="mt-2 text-sm text-slate-400">
              We hebben een bevestigingslink gestuurd naar <strong>{email}</strong>. Klik op de link
              om je account te activeren en daarna in te loggen.
            </p>
            <Link
              href="/login"
              className="mt-6 inline-block rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-background transition hover:bg-primary-hover"
            >
              Naar inloggen
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 py-12">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2">
          <img src="/logo/panda-bg-64.png" alt="FreqPanda" className="h-7 w-7 rounded-full" />
          <span className="font-display font-semibold tracking-tight">FreqPanda</span>
        </Link>

        <div className="card-surface p-6">
          <h1 className="text-lg font-semibold">Account aanmaken</h1>
          <p className="mt-1 text-sm text-slate-400">Begin gratis met lokaal trainen.</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            <div>
              <label htmlFor="name" className="mb-1 block text-xs font-medium text-slate-400">
                Naam
              </label>
              <div className="relative">
                <User className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  id="name"
                  type="text"
                  required
                  autoComplete="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="input pl-9"
                  placeholder="Jouw naam"
                />
              </div>
            </div>

            <div>
              <label htmlFor="email" className="mb-1 block text-xs font-medium text-slate-400">
                E-mailadres
              </label>
              <div className="relative">
                <Mail className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  id="email"
                  type="email"
                  required
                  autoComplete="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  className="input pl-9"
                  placeholder="jij@voorbeeld.nl"
                />
              </div>
            </div>

            <div>
              <label htmlFor="password" className="mb-1 block text-xs font-medium text-slate-400">
                Wachtwoord
              </label>
              <div className="relative">
                <Lock className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  id="password"
                  type="password"
                  required
                  minLength={8}
                  autoComplete="new-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pl-9"
                  placeholder="Minimaal 8 tekens"
                />
              </div>
            </div>

            {error && (
              <p role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                {error}
              </p>
            )}

            <button
              type="submit"
              disabled={isSubmitting}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2.5 text-sm font-semibold text-background transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              Registreren
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-slate-400">
          Heb je al een account?{" "}
          <Link href="/login" className="font-medium text-primary hover:text-primary-hover">
            Log hier in
          </Link>
        </p>
      </div>
    </div>
  );
}
