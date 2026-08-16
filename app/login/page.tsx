"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState, type FormEvent } from "react";
import { Loader2, Lock, Mail } from "lucide-react";
import { createClient } from "@/lib/supabase/client";

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  );
}

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const callbackUrl = searchParams.get("callbackUrl") || "/dashboard";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);

    try {
      const supabase = createClient();
      const { error: signInError } = await supabase.auth.signInWithPassword({ email, password });

      if (signInError) {
        setError("Onjuiste e-mail of wachtwoord");
        return;
      }

      router.push(callbackUrl);
      router.refresh();
    } catch (err) {
      console.error("[LoginForm] Sign in failed:", err);
      setError("Inloggen is mislukt. Probeer het opnieuw.");
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-sm">
        <Link href="/" className="mb-8 flex items-center justify-center gap-2">
          <img src="/logo/panda-bg-64.png" alt="FreqPanda" className="h-7 w-7 rounded-full" />
          <span className="font-display font-semibold tracking-tight">FreqPanda</span>
        </Link>

        <div className="card-surface p-6">
          <h1 className="text-lg font-semibold">Welkom terug</h1>
          <p className="mt-1 text-sm text-slate-400">Log in om je Bot Fleet te beheren.</p>

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
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
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="input pl-9"
                  placeholder="••••••••"
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
              Inloggen
            </button>
          </form>
        </div>

        <p className="mt-6 text-center text-sm text-slate-400">
          Nog geen account?{" "}
          <Link href="/signup" className="font-medium text-primary hover:text-primary-hover">
            Registreer je hier
          </Link>
        </p>
      </div>
    </div>
  );
}
