"use client";

import { useEffect, useState } from "react";
import { Copy, Loader2, Server, Trash2 } from "lucide-react";
import { apiFetch, toErrorMessage } from "@/lib/api-client";

interface DataServerStatus {
  id: number;
  status: string;
  ip: string | null;
  created: string;
}

// Settings-page panel for the one permanent data server this app depends
// on (see buildDataServerCloudInit in lib/hetzner.ts) — shows whether it
// exists, and lets the operator create or delete it. Backed by
// app/api/admin/data-server, which is itself gated to a single hardcoded
// operator account (lib/admin.ts); this component rendering (see
// app/settings/page.tsx) is just convenience, not the real access control.
export function DataServerAdminPanel() {
  const [server, setServer] = useState<DataServerStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isMutating, setIsMutating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justCopied, setJustCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch<{ server: DataServerStatus | null }>("/api/admin/data-server")
      .then((data) => {
        if (!cancelled) setServer(data.server);
      })
      .catch((err) => {
        if (!cancelled) setError(toErrorMessage(err, "Kon status niet ophalen"));
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleCreate() {
    setError(null);
    setIsMutating(true);
    try {
      const data = await apiFetch<{ id: number; status: string; ip: string | null }>("/api/admin/data-server", {
        method: "POST",
      });
      setServer({ ...data, created: new Date().toISOString() });
    } catch (err) {
      setError(toErrorMessage(err, "Aanmaken van de data-server is mislukt"));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleDelete() {
    if (!confirm("Data-server verwijderen? De permanente marktdata gaat hiermee verloren — nieuwe trainingsruns vallen dan terug op de klassieke download-per-run.")) {
      return;
    }
    setError(null);
    setIsMutating(true);
    try {
      await apiFetch("/api/admin/data-server", { method: "DELETE" });
      setServer(null);
    } catch (err) {
      setError(toErrorMessage(err, "Verwijderen is mislukt"));
    } finally {
      setIsMutating(false);
    }
  }

  async function handleCopy() {
    if (!server?.ip) return;
    await navigator.clipboard.writeText(server.ip);
    setJustCopied(true);
    setTimeout(() => setJustCopied(false), 2000);
  }

  return (
    <div className="card-surface p-6">
      <div className="mb-4 flex items-center gap-2">
        <Server className="h-4 w-4 text-primary" />
        <h2 className="font-semibold">Data-server</h2>
      </div>

      <p className="mb-4 text-xs text-slate-400">
        De permanente Hetzner-server die dagelijks marktdata downloadt voor auto-select training (zie{" "}
        <code>buildDataServerCloudInit</code>).
      </p>

      {isLoading ? (
        <p className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          Status ophalen...
        </p>
      ) : server ? (
        <div className="space-y-3 text-xs">
          <p className="text-slate-300">
            <span className="font-mono">id={server.id}</span> · <span className="font-mono">status={server.status}</span>
          </p>

          {server.ip && (
            <div>
              <span className="mb-1 block text-slate-400">
                IP (hoort als <code className="text-slate-300">DATA_SERVER_HOST</code> in Vercel te staan):
              </span>
              <div className="flex items-center gap-2">
                <code className="rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 font-mono text-slate-200">
                  {server.ip}
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
          )}

          <button
            type="button"
            onClick={handleDelete}
            disabled={isMutating}
            className="flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-2 text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isMutating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Server verwijderen
          </button>

          <SshKeyInstructions />
        </div>
      ) : (
        <div>
          <p className="mb-3 text-xs text-amber-300">Geen data-server gevonden.</p>
          <button
            type="button"
            onClick={handleCreate}
            disabled={isMutating}
            className="flex items-center justify-center gap-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-background transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isMutating && <Loader2 className="h-4 w-4 animate-spin" />}
            Server aanmaken
          </button>
          <p className="mt-2 text-[11px] text-slate-500">
            Na aanmaken: zet <code className="text-slate-400">DATA_SERVER_HOST</code> (het IP hierboven) en{" "}
            <code className="text-slate-400">DATA_SERVER_SSH_PRIVATE_KEY</code> in Vercel. De eerste volledige backfill
            start automatisch en kan uren duren.
          </p>
          <SshKeyInstructions />
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

// DATA_SERVER_SSH_PRIVATE_KEY must be a base64 encoding of the full PEM key
// — see normalizeBase64Key's own doc comment in lib/hetzner.ts for why a
// raw multi-line PEM pasted straight into a Vercel env var doesn't survive
// reliably (three separate production incidents, in order: literal "\n"
// text, real CRLF line endings, and finally newlines disappearing
// altogether). Purely instructional — no key material is ever generated,
// shown, or handled by this UI; (re)keying the datasync trust relationship
// on the data server itself still requires the manual SSH steps this
// component only documents, not automates.
function SshKeyInstructions() {
  return (
    <details className="mt-1 text-[11px] text-slate-500">
      <summary className="cursor-pointer select-none text-slate-400">SSH-sleutel instellen of vervangen</summary>
      <div className="mt-2 space-y-2 pl-2">
        <p>1. Genereer een base64-waarde van de private key (op je eigen machine, nooit hier):</p>
        <pre className="overflow-x-auto rounded-lg border border-slate-700 bg-slate-900 p-2 font-mono text-slate-300">
          base64 -w0 id_dataserver{"\n"}
          {"# macOS: base64 -i id_dataserver"}
        </pre>
        <p>
          2. Plak die ene regel als <code className="text-slate-400">DATA_SERVER_SSH_PRIVATE_KEY</code> in Vercel
          (Production) — nooit de ruwe PEM-inhoud direct, die overleeft het env-var-veld niet betrouwbaar.
        </p>
        <p>
          3. Het bijbehorende publieke deel moet al in <code className="text-slate-400">~/.ssh/authorized_keys</code>{" "}
          van de <code className="text-slate-400">datasync</code>-gebruiker op de data-server staan (gebeurt
          automatisch bij het aanmaken van de server hierboven — alleen nodig om opnieuw te doen bij een volledig
          nieuw sleutelpaar).
        </p>
      </div>
    </details>
  );
}
