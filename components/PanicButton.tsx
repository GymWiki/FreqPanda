"use client";

import { useState } from "react";
import { AlertOctagon, Loader2, X } from "lucide-react";
import { apiFetch, toErrorMessage } from "@/lib/api-client";
import { useDictionary } from "@/components/I18nProvider";

interface PanicResult {
  botId: string;
  botName: string;
  ok: boolean;
  error?: string;
}

interface PanicButtonProps {
  disabled?: boolean;
  onPanicked: () => void | Promise<void>;
}

// The global kill switch (POST /api/bots/panic): force-closes every open
// position and pauses every deployed bot at once. A destructive, real-money
// action — gated behind a proper confirmation modal rather than a bare
// confirm(), matching the weight GoLiveModal already gives the way in.
export function PanicButton({ disabled, onPanicked }: PanicButtonProps) {
  const dict = useDictionary();
  const [isConfirmOpen, setIsConfirmOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<PanicResult[] | null>(null);

  async function handleConfirm() {
    setError(null);
    setIsSubmitting(true);
    try {
      const data = await apiFetch<{ results: PanicResult[] }>("/api/bots/panic", { method: "POST" });
      setResults(data.results);
      await onPanicked();
    } catch (err) {
      setError(toErrorMessage(err, dict.panic.failed));
    } finally {
      setIsSubmitting(false);
    }
  }

  function handleClose() {
    if (isSubmitting) return;
    setIsConfirmOpen(false);
    setResults(null);
    setError(null);
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setIsConfirmOpen(true)}
        disabled={disabled}
        className="flex items-center gap-2 rounded-lg border border-red-500/50 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-400 transition hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
      >
        <AlertOctagon className="h-4 w-4" />
        {dict.panic.trigger}
      </button>

      {isConfirmOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="card-surface w-full max-w-sm p-6">
            {!results ? (
              <>
                <div className="mb-4 flex items-start justify-between">
                  <div className="flex items-center gap-2 text-red-400">
                    <AlertOctagon className="h-5 w-5" />
                    <h2 className="font-semibold">{dict.panic.confirmHeading}</h2>
                  </div>
                  <button type="button" onClick={handleClose} className="text-slate-400 hover:text-white">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                <p className="text-sm text-slate-300">
                  {dict.panic.confirmBodyPrefix}
                  <strong>{dict.panic.confirmBodyBold}</strong>
                  {dict.panic.confirmBodySuffix}
                </p>
                {error && (
                  <p
                    role="alert"
                    className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-300"
                  >
                    {error}
                  </p>
                )}
                <div className="mt-5 flex gap-2">
                  <button
                    type="button"
                    onClick={handleClose}
                    disabled={isSubmitting}
                    className="flex-1 rounded-lg border border-border px-4 py-2 text-sm font-medium text-slate-300 transition hover:border-primary disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {dict.panic.confirmCancel}
                  </button>
                  <button
                    type="button"
                    onClick={handleConfirm}
                    disabled={isSubmitting}
                    className="flex flex-1 items-center justify-center gap-2 rounded-lg bg-red-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-400 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
                    {dict.panic.confirmProceed}
                  </button>
                </div>
              </>
            ) : (
              <>
                <div className="mb-4 flex items-center justify-between">
                  <h2 className="font-semibold">{dict.panic.resultHeading}</h2>
                  <button type="button" onClick={handleClose} className="text-slate-400 hover:text-white">
                    <X className="h-4 w-4" />
                  </button>
                </div>
                {results.length === 0 ? (
                  <p className="text-sm text-slate-400">{dict.panic.resultEmpty}</p>
                ) : (
                  <ul className="space-y-2 text-sm">
                    {results.map((r) => (
                      <li key={r.botId} className="flex items-start justify-between gap-3">
                        <span className="text-slate-200">{r.botName}</span>
                        <span className={r.ok ? "text-right text-emerald-400" : "text-right text-amber-400"}>
                          {r.ok ? dict.panic.resultStopped : dict.panic.resultPartial}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                <button
                  type="button"
                  onClick={handleClose}
                  className="mt-5 w-full rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-background transition hover:bg-primary-hover"
                >
                  {dict.common.close}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}
