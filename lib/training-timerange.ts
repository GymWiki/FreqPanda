// Pure, dependency-free module used by lib/hetzner.ts's live-deploy
// cloud-init. Kept as its own module (rather than folded into
// lib/hetzner.ts directly, a server-only module that also pulls in the
// Hetzner API client) mostly for historical reasons — lib/hetzner.ts
// re-exports both of these below so every existing "@/lib/hetzner" import
// of them keeps working unchanged.
export const STAKE_CURRENCY = "USDT";
/** FreqAI's include_corr_pairlist benchmark pair — see lib/hetzner.ts's own doc comment (where this is re-exported) for why it's a fixed platform default rather than per-bot. */
export const DEFAULT_CORR_PAIRLIST = [`BTC/${STAKE_CURRENCY}`];
