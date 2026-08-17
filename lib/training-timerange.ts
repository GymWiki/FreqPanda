// Pure, dependency-free module used by lib/hetzner.ts's live-deploy
// cloud-init. Kept as its own module (rather than folded into
// lib/hetzner.ts directly, a server-only module that also pulls in the
// Hetzner API client) mostly for historical reasons — lib/hetzner.ts
// re-exports both of these below so every existing "@/lib/hetzner" import
// of them keeps working unchanged.
export const STAKE_CURRENCY = "USDT";
/** FreqAI's include_corr_pairlist benchmark pair — see lib/hetzner.ts's own doc comment (where this is re-exported) for why it's a fixed platform default rather than per-bot. */
export const DEFAULT_CORR_PAIRLIST = [`BTC/${STAKE_CURRENCY}`];

// How many of the exchange's top-liquid USDT markets VolumePairList hands
// to FreqAI when auto-select is on — user-chosen per bot via the slider in
// NewBotDialog/BotCard (BotConfiguration.autoSelectPairCount), clamped to
// this range: below the floor there's too little diversification for
// FreqAI to find real opportunities, above the ceiling a single local
// training run (Docker on the user's own machine, not a beefy cloud box)
// stops being a "grab a coffee" wait. Needed client-side too (see
// components/ui/PairCountSlider.tsx), which is why this lives here rather
// than in lib/hetzner.ts alongside clampAutoPairlistSize — see this
// module's own top-of-file doc comment.
export const AUTO_PAIRLIST_SIZE_RANGE = { min: 10, max: 200 };
/** What a bot gets before the user ever touches the slider — the exact value the range above replaces as a single hardcoded constant. */
export const AUTO_PAIRLIST_SIZE_DEFAULT = 30;
