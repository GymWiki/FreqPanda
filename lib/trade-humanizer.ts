import type { FreqtradeTrade } from "@/lib/freqtrade-client";

export interface HumanizedTrade {
  id: number;
  pair: string;
  isOpen: boolean;
  openedAt: string;
  closedAt: string | null;
  entryPrice: number;
  /** null while a position is still open — there's no exit fill yet. */
  exitPrice: number | null;
  profitAbs: number | null;
  profitRatio: number | null;
  /** null while a position is still open — there's no outcome to sign yet. */
  isWin: boolean | null;
  /** The Jip-en-Janneke translation — what happened, in one short sentence. */
  headline: string;
  /** "+$12.34 (+2.1%)" / "-$4.10 (-0.8%)" — always shown alongside headline. */
  amountLabel: string | null;
}

type Copy = (pair: string) => string;

// freqtrade's own exit_reason values, translated into plain language. Each
// reason gets a win/loss variant since the same reason can close either
// way (exit_signal and force_exit both fire regardless of whether the
// trade happened to be profitable at that moment) — only roi and
// stop_loss are inherently one-sided. An unmapped/custom reason (a
// strategy's own custom_exit tag, a future freqtrade addition) falls back
// to a generic win/loss sentence keyed on profit sign alone, so this never
// has a "trade with no headline" gap.
const EXIT_REASON_COPY: Record<string, { win: Copy; loss: Copy }> = {
  roi: {
    win: (pair) => `Doel bereikt! Winst veiliggesteld op ${pair}.`,
    loss: (pair) => `Doel bereikt op ${pair} — net geen winst, maar wel gesloten zoals gepland.`,
  },
  stop_loss: {
    win: (pair) => `Markt keerde op tijd — positie op ${pair} gesloten met winst.`,
    loss: (pair) => `Markt daalde. Positie op ${pair} veilig gesloten om erger te voorkomen.`,
  },
  trailing_stop_loss: {
    win: (pair) => `Winst vastgezet op ${pair} nadat de koers omsloeg.`,
    loss: (pair) => `Positie op ${pair} gesloten toen de koers terugviel vanaf de piek.`,
  },
  exit_signal: {
    win: (pair) => `AI zag een beter moment om winst te nemen op ${pair}.`,
    loss: (pair) => `AI sloot de positie op ${pair} vanwege een veranderd marktsignaal.`,
  },
  // Older freqtrade versions call the same signal-based exit "sell_signal".
  sell_signal: {
    win: (pair) => `AI zag een beter moment om winst te nemen op ${pair}.`,
    loss: (pair) => `AI sloot de positie op ${pair} vanwege een veranderd marktsignaal.`,
  },
  force_exit: {
    win: (pair) => `Positie op ${pair} handmatig gesloten — met winst.`,
    loss: (pair) => `Positie op ${pair} handmatig gesloten.`,
  },
  emergency_exit: {
    win: (pair) => `Noodstop actief — positie op ${pair} direct gesloten, met winst.`,
    loss: (pair) => `Noodstop actief — positie op ${pair} direct gesloten.`,
  },
  liquidation: {
    win: (pair) => `Positie op ${pair} geliquideerd door de exchange.`,
    loss: (pair) => `Positie op ${pair} geliquideerd door de exchange.`,
  },
};

function fallbackCopy(pair: string, isWin: boolean): string {
  return isWin ? `Winstgevende trade afgesloten op ${pair}.` : `Verlieslatende trade afgesloten op ${pair}.`;
}

function formatAmount(profitAbs: number, profitRatio: number): string {
  const sign = profitAbs >= 0 ? "+" : "";
  const pct = (profitRatio * 100).toFixed(1);
  return `${sign}$${profitAbs.toFixed(2)} (${sign}${pct}%)`;
}

// The single place freqtrade's technical exit_reason/sell_reason vocabulary
// becomes something a non-technical user can read at a glance — used by
// GET /api/bots/[id]/trades so the raw freqtrade shape never reaches the
// frontend.
export function humanizeTrade(trade: FreqtradeTrade): HumanizedTrade {
  const isOpen = trade.is_open;
  const profitAbs = trade.profit_abs ?? null;
  const profitRatio = trade.profit_ratio ?? null;
  const isWin = isOpen || profitAbs === null ? null : profitAbs >= 0;

  let headline: string;
  if (isOpen) {
    headline = `Positie open op ${trade.pair} — nog in de markt.`;
  } else {
    const reasonKey = trade.exit_reason ?? trade.sell_reason ?? "";
    const copy = EXIT_REASON_COPY[reasonKey];
    headline = copy ? copy[isWin ? "win" : "loss"](trade.pair) : fallbackCopy(trade.pair, isWin ?? false);
  }

  return {
    id: trade.trade_id,
    pair: trade.pair,
    isOpen,
    openedAt: trade.open_date,
    closedAt: trade.close_date,
    entryPrice: trade.open_rate,
    exitPrice: trade.close_rate,
    profitAbs,
    profitRatio,
    isWin,
    headline,
    amountLabel: profitAbs !== null && profitRatio !== null ? formatAmount(profitAbs, profitRatio) : null,
  };
}

export function humanizeTrades(trades: FreqtradeTrade[]): HumanizedTrade[] {
  return trades.map(humanizeTrade);
}
