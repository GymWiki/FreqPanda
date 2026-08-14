# Beginner-friendly UI + language setting — design

## Goal

FreqPanda's app UI (dashboard, new-bot wizard, settings, exchange
connection) currently reads like a developer admin panel: trading jargon
("Paper Trading", "Cloud slots", "FreqaiScalperStrategy", "Auto-Compounding"),
mixed English/Dutch, dense data-table-style cards. The landing page already
has a warm, friendly "FreqPanda" brand identity (bamboo-green accent, dark
"ink" background, rounded shapes, Space Grotesk/Manrope/IBM Plex Mono type
stack — see `app/page.tsx`, `tailwind.config.ts`) that the app itself never
adopted.

This redesign makes the app usable by someone with zero trading knowledge:
plain-language copy, tooltips explaining jargon in one sentence, and a
visual style that extends the existing landing-page brand into the app
instead of the current generic-dashboard look. No functionality is removed
— every existing option stays, just relabeled and explained.

On top of that: the user can now choose the app's display language
(Dutch/English), set once in Settings, persisted per account.

## Non-goals

- No functionality is added or removed. This is presentation-layer only —
  copy, layout, styling, and a new language preference. No API, database
  schema (beyond the new `Profile.locale` column), or business-logic
  changes beyond what's needed to read/write that preference.
- No URL-based locale routing (no `/nl/...`, `/en/...` route segments).
  The language is an account setting, not a routing concern.
- No translation of anything outside the browser-rendered UI (Telegram bot
  messages, email, freqtrade's own logs/API responses, error messages
  logged server-side for debugging) — only what a human reads in the app.

## Part 1 — i18n infrastructure

**Storage**: add `Profile.locale String @default("nl") @map("locale")` to
`prisma/schema.prisma`, applied via a Supabase migration (`ALTER TABLE
profiles ADD COLUMN locale text NOT NULL DEFAULT 'nl'`). Only two valid
values for now: `"nl"` | `"en"`.

**Dictionaries**: `lib/i18n/nl.ts` and `lib/i18n/en.ts`, each a flat,
strongly-typed object of string keys → translated strings (interpolation
via simple `{placeholder}` substitution where needed, e.g. bot names,
numbers). `lib/i18n/dictionary.ts` exports the `Dictionary` type (derived
from the Dutch dictionary's shape, so English is type-checked against the
same key set — a missing English key is a compile error) and a
`getDictionary(locale)` lookup.

**Server components** (`app/dashboard/page.tsx`, `app/settings/page.tsx` —
both already fetch the user's `Profile` row): read `profile.locale`, call
`getDictionary(locale)`, and either pass the resulting `dict` down as a
prop to client components or wrap the subtree in a small
`I18nProvider` client component (`components/I18nProvider.tsx`) that puts
`dict` in React context, consumed via a `useDictionary()` hook. Client
components deep in the tree (`BotCard`, `NewBotDialog` and its children,
`ConnectExchangeDialog`, etc.) use the hook instead of hardcoded strings.

**Changing the language**: Settings page gets a language dropdown, backed
by a new `PATCH /api/account/locale` route (same shape as the existing
`PATCH /api/account/telegram` — Zod-validated body, updates `Profile`,
returns the new value). On success, the client calls `router.refresh()`
so every server component re-renders with the new locale immediately —
no full page reload needed, matches how other settings changes in this
app already behave.

**Phase-1 scope check**: this phase moves the *existing* strings (current
Dutch/English mix, unchanged wording) into the dictionary system and wires
up the switcher end-to-end. The app must look and behave identically to
today when this phase ships — it's purely infrastructure. Content changes
happen in Part 2.

## Part 2 — Copy + visual redesign (within the i18n system)

**Terminology** (Dutch dictionary values change; English gets natural
equivalents, not literal translations of the old jargon):

| Old | New (NL) |
|---|---|
| Bot Fleet | Mijn bots |
| Paper Trading | Oefenmodus |
| Live Trading | Echt geld |
| "X / Y cloud slots in use" | "X van Y bots actief" |
| Strategy (FreqaiScalperStrategy, etc.) | Handelsstijl — "Snelle scalper" / "Geduldige spaarder" / "Trendvolger" (same 3 presets, renamed) |
| Auto-Compounding | Winst automatisch herinvesteren |
| Start Cloud Training / Local Training | "AI trainen" (cloud vs. lokaal becomes a sub-choice, not the headline verb) |
| Deploy to Cloud | Bot starten |
| Exchange-account koppelen | Je account koppelen |
| Auto-select coins | "Laat AI munten kiezen" vs. "Ik kies zelf" |

Every jargon term gets a one-sentence tooltip (reuse the existing
`components/ui/Tooltip.tsx` primitive) the first time it appears on a
screen.

**Visual**: extend the landing page's `panda-*` token usage (already
defined in `tailwind.config.ts`) into the dashboard, bot cards, new-bot
wizard, and settings — replacing the generic `card-surface`/
`bg-primary`/slate-gray styling. Concretely: rounder cards, larger touch
targets, a simple traffic-light status indicator (green/amber/red) instead
of raw status enum text, more whitespace, less table-density per card. The
Space Grotesk/Manrope/IBM Plex Mono type stack is already loaded app-wide
in `app/layout.tsx` (`--font-sans`/`--font-display`/`--font-mono`), so no
per-page font loading is needed for this.

**Existing prototype found during planning**: `app/platform/page.tsx`
(singular — not linked from `Navbar.tsx` or `BottomNav.tsx`, i.e. not
reachable from the real app today) is an earlier, unfinished "FreqPanda
brand exploration" of exactly this direction — `components/platform/
{PlatformHeader,PandaHero,PortfolioCard,BotOverview,PanicBar}.tsx`, real
bot data wired in via the same `botSelect`/`toBotDTO` pipeline `/dashboard`
uses, but missing bot creation, settings, deploy/train actions, and
exchange-connection management, plus one still-mocked value (portfolio
balance in `PortfolioCard`). Treat its components as the visual reference
this redesign extends into the real, linked `/dashboard` — not a page to
promote as-is (too much real functionality missing) and not a second
parallel dashboard to maintain going forward. Once `/dashboard` adopts this
look, `app/platform/` and its now-redundant components should be removed
rather than left as an orphaned duplicate — confirm during planning if any
part of it (e.g. `PanicBar`) is worth keeping in place of its
`/dashboard` equivalent (`components/PanicButton.tsx`) rather than
deleting.

**Files touched**: `components/Navbar.tsx`, `components/BottomNav.tsx`,
`components/BotFleetGrid.tsx`, `components/BotCard.tsx`,
`components/NewBotDialog.tsx` and its children in `components/ui/`
(`StrategyPicker.tsx`, `BudgetSlider.tsx`, `ExchangeCombobox.tsx`,
`PairSelector.tsx`, `StatusBadge.tsx`, `Switch.tsx`, `Toggle.tsx`,
`Tooltip.tsx`), `app/dashboard/page.tsx`, `app/settings/page.tsx`,
`components/ConnectExchangeDialog.tsx`, `components/TelegramSettingsForm.tsx`,
`components/GoLiveModal.tsx`, `components/PanicButton.tsx`,
`components/PnlChart.tsx`, `components/TradeHistoryFeed.tsx`,
`components/TrainingProgressBar.tsx`.

`components/DataServerAdminPanel.tsx` gets copy/style parity too, but stays
admin-only (unaffected by the beginner-facing goal since normal users never
see it).

## Part 3 — English translations

Once Part 2's Dutch wording is final, translate the full dictionary to
English (`lib/i18n/en.ts`). Not a literal word-for-word translation of the
Dutch jargon-replacement table — natural English equivalents for the same
concepts (e.g. "Oefenmodus" → "Practice mode", not "Exercise mode").

## Testing

- `npx tsc --noEmit` and `npm run build` after each part.
- Manual browser check (dev server) of: dashboard, new-bot wizard end to
  end, settings language switch (confirm `router.refresh()` picks up the
  new locale immediately), connecting an exchange account — in both
  languages.
- Confirm no functional regression: creating a bot, toggling auto-select,
  connecting an exchange, and the Telegram settings form still work
  exactly as before (only their copy/styling changed).

## Rollout

Same as every other change in this session: commit and push to
`claude/freqtrade-saas-mvp-wslmmk` after each part is verified (build +
manual check), not just at the very end — so a partial result is never
sitting uncommitted.
