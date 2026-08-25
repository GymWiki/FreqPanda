import type { Dictionary } from "@/lib/i18n";

// Turns whatever train_local_model/run_local_backtest (src-tauri/src/
// main.rs) rejected with into plain language — NEVER the raw string
// itself. That raw string can be an internal Rust validation message
// ("generated config.json is missing required key '...'"), a bare Docker
// exit code ("docker exited with status 1"), or — worst case, if freqtrade
// itself crashes inside the container — a line straight out of a Python
// traceback (run_freqtrade_step_resumable only wraps a non-zero exit
// code in its own Err; it doesn't scrub the stdout it streams alongside
// it, see useLocalTrainingSync's own log-filtering for that half of this
// fix). A user with no technical background should never have to read
// any of that. Matched against a closed, deliberately small set of
// substrings this app's own Rust code is known to emit verbatim — every
// unmatched error (including ones this list hasn't been updated for yet)
// falls through to a generic, always-safe, always-actionable message.
export function toFriendlyTrainingError(rawError: unknown, dict: Dictionary, phase: "training" | "backtest"): string {
  const raw = rawError instanceof Error ? rawError.message : typeof rawError === "string" ? rawError : "";
  const errors = dict.trainingErrors;

  if (raw.includes("could not spawn docker") || raw.includes("Docker Desktop")) {
    return errors.dockerNotRunning;
  }
  if (raw.includes("historical data download failed against every data source")) {
    return errors.downloadFailed;
  }
  if (raw.includes("pairWhitelist must contain at least one pair")) {
    return errors.noPairsSelected;
  }
  if (raw.includes("local data is missing for")) {
    return errors.dataMissingAfterDownload;
  }
  if (raw.includes("timeframe = ") || raw.includes("strategy code")) {
    return errors.strategyCodeInvalid;
  }
  return phase === "training" ? errors.genericTraining : errors.genericBacktest;
}

// Applied to every line train_local_model/run_local_backtest streams live
// (the "training-progress" event, see useLocalTrainingSync and
// BotDetailView) before it's ever shown — the second half of the "no raw
// error text" requirement. This app's own status lines (emit_status in
// src-tauri/src/main.rs) always look like "=== ... ===" and are always
// safe/plain-language-adjacent; freqtrade's own stdout also includes
// genuinely useful download-progress bars (tqdm-style, containing "%|").
// Anything else — a raw log line, a stray warning, or (worst case) a
// Python traceback — is filtered out here rather than risk showing it,
// even though that means occasionally hiding a harmless line along with
// it. Returns null for a line that should stay hidden.
export function toFriendlyProgressLine(rawLine: string): string | null {
  const trimmed = rawLine.trim();
  if (trimmed.startsWith("===") && trimmed.endsWith("===")) {
    return trimmed.replace(/^=== | ===$/g, "");
  }
  if (trimmed.includes("%|")) {
    return trimmed;
  }
  return null;
}
