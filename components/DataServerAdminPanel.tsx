"use client";

import { useState } from "react";
import { Copy, Loader2, Server } from "lucide-react";
import { apiFetch, toErrorMessage } from "@/lib/api-client";

interface ProvisionResult {
  id: number;
  status: string;
  ip: string | null;
}

// TEMPORARY: UI for the one-off POST /api/admin/provision-data-server
// action — see that route's own doc comment for why this exists and why
// it's meant to come out again once the permanent data server has been
// created. Not linked from anywhere else, and the route itself is gated to
// a single hardcoded operator account (lib/admin.ts) — this component
// rendering is just convenience, not the real access control.
export function DataServerAdminPanel() {
  const [isProvisioning, setIsProvisioning] = useState(false);
  const [result, setResult] = useState<ProvisionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [justCopied, setJustCopied] = useState(false);

  async function handleProvision() {
    setError(null);
    setIsProvisioning(true);
    try {
      const data = await apiFetch<ProvisionResult>("/api/admin/provision-data-server", { method: "POST" });
      setResult(data);
    } catch (err) {
      setError(toErrorMessage(err, "Aanmaken van de data-server is mislukt"));
    } finally {
      setIsProvisioning(false);
    }
  }

  async function handleCopy() {
    if (!result?.ip) return;
    await navigator.clipboard.writeText(result.ip);
    setJustCopied(true);
    setTimeout(() => setJustCopied(false), 2000);
  }

  return (
    <div className="card-surface p-6">
      <div className="mb-4 flex items-center gap-2">
        <Server className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">Data-server provisionen (tijdelijk)</h2>
      </div>

      <p className="mb-4 text-xs text-slate-400">
        Maakt de permanente Hetzner-server aan die dagelijks marktdata downloadt (zie <code>buildDataServerCloudInit</code>
        ). Eenmalige actie — de eerste volledige backfill start automatisch en kan uren duren.
      </p>

      {!result && (
        <button
          type="button"
          onClick={handleProvision}
          disabled={isProvisioning}
          className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-background transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isProvisioning && <Loader2 className="h-4 w-4 animate-spin" />}
          Server aanmaken
        </button>
      )}

      {result && (
        <div className="space-y-3 text-xs">
          <p className="text-slate-300">
            Server aangemaakt: <span className="font-mono">id={result.id}</span>{" "}
            <span className="font-mono">status={result.status}</span>
          </p>

          {result.ip ? (
            <div>
              <span className="mb-1 block text-slate-400">
                Zet dit als <code className="text-slate-300">DATA_SERVER_HOST</code> in Vercel (Production):
              </span>
              <div className="flex items-center gap-2">
                <code className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-slate-200">
                  {result.ip}
                </code>
                <button
                  type="button"
                  onClick={handleCopy}
                  className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-slate-300 transition hover:bg-slate-800"
                >
                  <Copy className="h-3.5 w-3.5" />
                  {justCopied ? "Gekopieerd" : "Kopieer"}
                </button>
              </div>
            </div>
          ) : (
            <p className="text-amber-300">
              Nog geen IP toegewezen — herlaad de Hetzner Cloud console over een paar seconden om 'm op te zoeken.
            </p>
          )}

          <p className="text-slate-500">
            Vergeet niet ook <code className="text-slate-400">DATA_SERVER_SSH_PRIVATE_KEY</code> te zetten (de sleutel die
            je al hebt gekregen) — zonder die twee samen doet deze server niets voor lopende trainingsruns.
          </p>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300">
          {error}
        </p>
      )}
    </div>
  );
}
