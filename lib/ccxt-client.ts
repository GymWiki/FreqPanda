import ccxt, { type Exchange, type Balances } from "ccxt";

// Our exchange ids (see lib/exchange-presets.ts) match ccxt's own exchange
// ids everywhere we use — including "gate" (ccxt's own exported class is
// already named "gate", not "gateio"). Kept as an explicit table (even
// though it's empty today) so a future real mismatch has an obvious place
// to go, rather than requiring a full 1:1 table that would just drift out
// of sync.
const CCXT_ID_OVERRIDES: Record<string, string> = {};

function resolveCcxtId(exchangeName: string): string {
  return CCXT_ID_OVERRIDES[exchangeName] ?? exchangeName;
}

export class BalanceFetchError extends Error {}

export interface FreeBalance {
  asset: "USDT" | "USDC";
  amount: number;
}

// Vercel functions have their own hard ceiling (10-60s depending on plan);
// this keeps a single ccxt call well under that so a slow/hanging exchange
// fails fast with a translatable RequestTimeout instead of taking the whole
// function down with it.
const CCXT_TIMEOUT_MS = 10_000;

// Translates ccxt's exception hierarchy into a message a non-technical user
// can act on, instead of a raw stack trace. Order matters: ccxt's own
// classes nest (RequestTimeout/ExchangeNotAvailable/RateLimitExceeded are
// all NetworkError subclasses, PermissionDenied is an AuthenticationError
// subclass), so the more specific checks must run before their parents.
function translateCcxtError(err: unknown, exchangeName: string): string {
  if (err instanceof ccxt.PermissionDenied) {
    return `De API-key voor ${exchangeName} heeft niet genoeg rechten (permission denied). Controleer de key-permissies.`;
  }
  if (err instanceof ccxt.AuthenticationError) {
    return `De API-key of -secret voor ${exchangeName} is ongeldig. Controleer je gegevens en probeer opnieuw.`;
  }
  if (err instanceof ccxt.RateLimitExceeded || err instanceof ccxt.DDoSProtection) {
    return `${exchangeName} ontvangt te veel verzoeken op dit moment. Probeer het over een paar minuten opnieuw.`;
  }
  if (err instanceof ccxt.RequestTimeout) {
    return `De verbinding met ${exchangeName} verliep te traag (timeout). Probeer het opnieuw.`;
  }
  if (err instanceof ccxt.OnMaintenance || err instanceof ccxt.ExchangeNotAvailable) {
    return `${exchangeName} is momenteel niet bereikbaar (onderhoud of storing). Probeer het later opnieuw.`;
  }
  if (err instanceof ccxt.NetworkError) {
    return `Kon geen verbinding maken met ${exchangeName}. Controleer je internetverbinding en probeer opnieuw.`;
  }
  if (err instanceof ccxt.ExchangeError) {
    return `${exchangeName} gaf een foutmelding: ${err.message}`;
  }
  const message = err instanceof Error ? err.message : "Unknown error";
  return `Kon balans niet ophalen van ${exchangeName}: ${message}`;
}

// The one place this app talks to a real exchange's balance endpoint — used
// by connecting a bot's exchange account (see app/api/bots/[id]/
// exchange-connection, which requires this to succeed before saving
// anything as verified) and the Go Live flow (the $50 minimum-balance
// gate). Read-only: only ever calls fetchBalance, never a trading
// endpoint, so a connection with trade-only API key permissions (no
// withdraw) still works fully.
export async function fetchFreeBalance(exchangeName: string, apiKey: string, apiSecret: string): Promise<FreeBalance> {
  const ccxtId = resolveCcxtId(exchangeName);
  const ExchangeClass = (ccxt as unknown as Record<string, new (config: Record<string, unknown>) => Exchange>)[
    ccxtId
  ];
  if (!ExchangeClass) {
    throw new BalanceFetchError(`ccxt has no exchange class for "${exchangeName}" (resolved id: "${ccxtId}")`);
  }

  const exchange = new ExchangeClass({
    apiKey,
    secret: apiSecret,
    enableRateLimit: true,
    timeout: CCXT_TIMEOUT_MS,
  });

  let balance: Balances;
  try {
    balance = await exchange.fetchBalance();
  } catch (err) {
    console.error(`[ccxt-client] fetchBalance failed for ${exchangeName}:`, err);
    throw new BalanceFetchError(translateCcxtError(err, exchangeName));
  }

  // USDT first (the platform's default stake currency everywhere else —
  // see STAKE_CURRENCY in lib/hetzner.ts), USDC as the common fallback for
  // exchanges/accounts that hold their stable balance there instead.
  for (const asset of ["USDT", "USDC"] as const) {
    const free = balance[asset]?.free;
    if (typeof free === "number" && free > 0) {
      return { asset, amount: free };
    }
  }

  return { asset: "USDT", amount: 0 };
}
