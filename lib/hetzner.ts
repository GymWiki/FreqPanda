import { isSafePythonIdentifier } from "@/lib/strategy-validation";
import type { FreqAIProfileConfig } from "@/lib/strategy-presets";
import { EXCHANGE_PRESETS } from "@/lib/exchange-presets";
import {
  STAKE_CURRENCY,
  DEFAULT_CORR_PAIRLIST,
  AUTO_PAIRLIST_SIZE_RANGE,
  AUTO_PAIRLIST_SIZE_DEFAULT,
} from "@/lib/training-timerange";

// Re-exported so every existing "@/lib/hetzner" import of these keeps
// working unchanged — see training-timerange.ts's own doc comment for why
// the values themselves now live there instead.
export { STAKE_CURRENCY, DEFAULT_CORR_PAIRLIST, AUTO_PAIRLIST_SIZE_RANGE, AUTO_PAIRLIST_SIZE_DEFAULT };

const HETZNER_API_BASE = "https://api.hetzner.cloud/v1";

// Every bot in this app runs FreqAI unconditionally (see the `freqai:
// { enabled: true, ... }` block below and every preset in
// lib/strategy-presets.ts, all of which set freqaiModel to a real model
// like "LightGBMRegressor") — but the plain `freqtradeorg/freqtrade:stable`
// image is built from just requirements.txt, which does NOT include
// FreqAI's ML dependencies (scikit-learn, lightgbm, ...). Those only ship
// in the `stable_freqai` tag (built from the separate
// requirements-freqai.txt), or `stable_freqaitorch`/`stable_freqairl` for
// PyTorch/RL models. Using the plain tag here would pull successfully but
// fail the instant `backtesting --freqaimodel LightGBMRegressor` actually
// imports lightgbm — a real, latent bug, found by checking whether this
// project genuinely uses freqtrade's own FreqAI packaging correctly.
const FREQTRADE_DOCKER_IMAGE = "freqtradeorg/freqtrade:stable_freqai";

// Exported so lib/train-cloud.ts uses this same check instead of a second,
// separately-maintained copy — one place to keep the error message and the
// diagnostic logging below in sync.
export function requireHetznerToken(): string {
  const token = process.env.HETZNER_API_TOKEN;
  if (!token) {
    // Never log the token itself — only which HETZNER_* names Vercel
    // actually injected into this invocation, so a typo'd or
    // wrong-environment (Preview vs Production) var name shows up
    // server-side (Vercel function logs) without leaking any value.
    const hetznerKeysPresent = Object.keys(process.env)
      .filter((key) => key.startsWith("HETZNER"))
      .sort();
    console.error(
      `[lib/hetzner.ts] HETZNER_API_TOKEN is missing. HETZNER_* env vars present in this runtime: ${
        hetznerKeysPresent.length > 0 ? hetznerKeysPresent.join(", ") : "(none)"
      }`,
    );
    throw new Error(
      "HETZNER_API_TOKEN is not set (checked in lib/hetzner.ts, requireHetznerToken()) — " +
        "set it in the Vercel project's Environment Variables before provisioning, stopping, or deleting a VPS.",
    );
  }
  return token;
}

// Every call in this file goes through here so a slow/hanging Hetzner API
// can't hang the Vercel function that's awaiting it (provisioning/deleting
// a VPS, both of which run inline in an API route — see lib/deploy-bot.ts,
// app/api/bots/[id]/route.ts), and so a DNS/network failure surfaces as a
// clear message instead of an unhandled TypeError.
const HETZNER_TIMEOUT_MS = 15_000;

async function hetznerFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HETZNER_TIMEOUT_MS);
  try {
    return await fetch(`${HETZNER_API_BASE}${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Hetzner API request timed out after ${HETZNER_TIMEOUT_MS / 1000}s (${path})`);
    }
    throw new Error(`Could not reach Hetzner API: ${err instanceof Error ? err.message : "Unknown error"}`);
  } finally {
    clearTimeout(timeout);
  }
}

type FirewallProfile = "live-trading";

// Creates (or reuses) a Hetzner Cloud Firewall for the given profile and
// returns its id. "live-trading" — the only profile left now that cloud
// training and the permanent data server are gone (bots only ever run on a
// VPS, never train there) — opens only what a deployed bot actually needs:
// the freqtrade REST API, plus SSH only if a key is configured.
async function ensureFirewall(profile: FirewallProfile): Promise<number> {
  const token = requireHetznerToken();
  const name = `freqtrade-command-center-${profile}`;

  const listRes = await hetznerFetch(`/firewalls?name=${encodeURIComponent(name)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!listRes.ok) {
    throw new Error(`Hetzner API error (${listRes.status}): ${await listRes.text()}`);
  }
  const { firewalls } = (await listRes.json()) as { firewalls: Array<{ id: number }> };
  if (firewalls?.[0]?.id) return firewalls[0].id;

  const sshRule = {
    direction: "in",
    protocol: "tcp",
    port: "22",
    source_ips: ["0.0.0.0/0", "::/0"],
    description: "SSH (key-only auth)",
  };

  const rules = [
    {
      direction: "in",
      protocol: "tcp",
      port: "8080",
      source_ips: ["0.0.0.0/0", "::/0"],
      description: "Freqtrade REST API / FreqUI",
    },
    ...(process.env.HETZNER_SSH_KEY_ID ? [sshRule] : []),
  ];

  const createRes = await hetznerFetch(`/firewalls`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, rules, labels: { app: "freqtrade-command-center" } }),
  });
  if (!createRes.ok) {
    throw new Error(`Hetzner API error (${createRes.status}): ${await createRes.text()}`);
  }
  const { firewall } = (await createRes.json()) as { firewall: { id: number } };
  return firewall.id;
}

interface CreateServerParams {
  name: string;
  cloudInit: string;
  serverType?: string;
  /** Attaches the matching Hetzner Cloud Firewall. Omit only for servers that should have no inbound rules managed at all. */
  firewallProfile?: FirewallProfile;
}

interface HetznerServerResponse {
  server: {
    id: number;
    name: string;
    public_net: { ipv4?: { ip: string } };
    status: string;
  };
  action: { id: number; status: string };
}

// Not every server type is orderable in every location (e.g. "unsupported
// location for server type" — a real 422 seen in production) — Hetzner's
// own catalog is the only source of truth for that, and it isn't stable
// enough to hardcode a snapshot of it here.
//
// server_types[].prices[].location is NOT that source of truth, even
// though it looks like one: it's Hetzner's pricing catalog, which can list
// a location a type has a historical/listed price for without that type
// actually having capacity there right now — exactly the mismatch that
// made an earlier version of this check claim a location Hetzner had just
// rejected with a 422 was "available". datacenters[].server_types.available
// is the real, current-capacity list actually enforced at server-creation
// time, so that's what gets checked here instead.
async function fetchLocationsForServerType(serverType: string, token: string): Promise<string[]> {
  const typeRes = await hetznerFetch(`/server_types?name=${encodeURIComponent(serverType)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!typeRes.ok) {
    throw new Error(`Hetzner API error (${typeRes.status}): ${await typeRes.text()}`);
  }
  const { server_types } = (await typeRes.json()) as { server_types: Array<{ id: number; name: string }> };
  const match = server_types.find((t) => t.name === serverType);
  if (!match) {
    throw new Error(`Hetzner server type "${serverType}" does not exist`);
  }

  const dcRes = await hetznerFetch(`/datacenters`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!dcRes.ok) {
    throw new Error(`Hetzner API error (${dcRes.status}): ${await dcRes.text()}`);
  }
  const { datacenters } = (await dcRes.json()) as {
    datacenters: Array<{ location: { name: string }; server_types: { available: number[] } }>;
  };

  const locations = new Set<string>();
  for (const dc of datacenters) {
    if (dc.server_types.available.includes(match.id)) {
      locations.add(dc.location.name);
    }
  }
  return Array.from(locations);
}

// Hetzner periodically retires older server-type names (seen in production:
// a type still listed — and still showing real datacenter availability —
// in /server_types can still be rejected by POST /servers with a 422
// "server type <id> is deprecated"). deprecation is non-null once Hetzner
// has scheduled a type for retirement, so this is the one field that
// actually reflects "can I still order this", unlike datacenter
// availability (see fetchLocationsForServerType's own doc comment for the
// same kind of catalog-vs-enforcement mismatch). Used by createHetznerServer
// below to pick a safe automatic fallback rather than surfacing a raw
// Hetzner error the first time this app's own hardcoded default type name
// goes stale.
async function fetchOrderableServerTypes(
  token: string,
): Promise<Array<{ name: string; cores: number; memory: number; cpuType: string }>> {
  const res = await hetznerFetch(`/server_types`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Hetzner API error (${res.status}): ${await res.text()}`);
  }
  const { server_types } = (await res.json()) as {
    server_types: Array<{
      name: string;
      cores: number;
      memory: number;
      cpu_type: string;
      deprecation: unknown | null;
    }>;
  };
  return server_types
    .filter((t) => !t.deprecation)
    .map((t) => ({ name: t.name, cores: t.cores, memory: t.memory, cpuType: t.cpu_type }));
}

// Validates the configured HETZNER_LOCATION against this server type's real
// availability before ever attempting to create anything, and picks a
// working fallback instead of letting a stale/mismatched env var 422 on
// every single deploy or training run. Best-effort: if the lookup itself
// fails (network hiccup, rate limit), falls through to the preferred
// location unchanged — the create call's own 422 handling below is the
// last line of defense in that case. Only used as resolveServerPlacement's
// own last resort below, when nothing at all is orderable in the preferred
// location — the common "type isn't available here" case is handled there
// by changing the TYPE instead, which is what that function exists for.
async function resolveServerLocation(serverType: string, preferredLocation: string, token: string): Promise<string> {
  let availableLocations: string[];
  try {
    availableLocations = await fetchLocationsForServerType(serverType, token);
  } catch (err) {
    console.error(`[hetzner] Could not look up available locations for server type "${serverType}":`, err);
    return preferredLocation;
  }
  if (availableLocations.length === 0) {
    throw new Error(`Hetzner server type "${serverType}" is not currently orderable in any location`);
  }
  if (availableLocations.includes(preferredLocation)) {
    return preferredLocation;
  }
  const fallback = availableLocations[0];
  console.warn(
    `[hetzner] HETZNER_LOCATION "${preferredLocation}" does not support server type "${serverType}" — ` +
      `using "${fallback}" instead. Available for this type: ${availableLocations.join(", ")}.`,
  );
  return fallback;
}

interface ServerPlacement {
  serverType: string;
  location: string;
}

// Picks BOTH the server type and location together, preferring to keep
// HETZNER_LOCATION fixed over keeping the requested type fixed — the
// opposite priority from the old resolveServerLocation-only approach above.
// A type the operator configured is much more likely to be an arbitrary
// size/cost pick than a location they configured is, so this treats
// location as the harder constraint of the two.
//
// Common case (requested type already available in the requested location)
// costs one /server_types + one /datacenters lookup and changes nothing —
// same cost resolveServerLocation already paid. Falls back to
// resolveServerLocation's old type-fixed/location-varies behavior only when
// literally nothing orderable exists in the preferred location at all.
async function resolveServerPlacement(
  preferredType: string,
  preferredLocation: string,
  token: string,
): Promise<ServerPlacement> {
  let server_types: Array<{ id: number; name: string; cores: number; memory: number; cpu_type: string; deprecation: unknown }>;
  let datacenters: Array<{ location: { name: string }; server_types: { available: number[] } }>;
  try {
    const typeRes = await hetznerFetch(`/server_types`, { headers: { Authorization: `Bearer ${token}` } });
    if (!typeRes.ok) throw new Error(`Hetzner API error (${typeRes.status}): ${await typeRes.text()}`);
    ({ server_types } = await typeRes.json());

    const dcRes = await hetznerFetch(`/datacenters`, { headers: { Authorization: `Bearer ${token}` } });
    if (!dcRes.ok) throw new Error(`Hetzner API error (${dcRes.status}): ${await dcRes.text()}`);
    ({ datacenters } = await dcRes.json());
  } catch (err) {
    console.error(`[hetzner] Could not look up server type/location availability:`, err);
    return { serverType: preferredType, location: preferredLocation };
  }

  const preferred = server_types.find((t) => t.name === preferredType);
  const dc = datacenters.find((d) => d.location.name === preferredLocation);

  if (preferred && dc && dc.server_types.available.includes(preferred.id)) {
    return { serverType: preferredType, location: preferredLocation };
  }

  if (dc) {
    const availableInLocation = server_types.filter((t) => !t.deprecation && dc.server_types.available.includes(t.id));
    if (availableInLocation.length > 0) {
      const best =
        (preferred &&
          availableInLocation
            .filter((t) => t.cpu_type === preferred.cpu_type)
            .sort(
              (a, b) => Math.abs(a.cores - preferred.cores) - Math.abs(b.cores - preferred.cores) || a.memory - b.memory,
            )[0]) ||
        availableInLocation.filter((t) => t.cpu_type === "shared").sort((a, b) => a.cores - b.cores || a.memory - b.memory)[0] ||
        availableInLocation[0];
      console.warn(
        `[hetzner] Server type "${preferredType}" is not orderable in "${preferredLocation}" — using "${best.name}" ` +
          `there instead, keeping the location fixed (see resolveServerPlacement's own doc comment for why).`,
      );
      return { serverType: best.name, location: preferredLocation };
    }
  }

  // Nothing at all orderable in preferredLocation (or it doesn't exist) —
  // fall back to the old type-fixed/location-varies behavior as a last
  // resort, same as before this function existed.
  const location = await resolveServerLocation(preferredType, preferredLocation, token);
  return { serverType: preferredType, location };
}

// allowDeprecatedFallback: internal-only, set to false on the one retry
// createHetznerServer below makes for itself — prevents an infinite loop if
// Hetzner's own /server_types listing were ever inconsistent with what
// POST /servers actually accepts (its own fallback pick turning out to
// also 422 as deprecated).
async function createHetznerServerOnce(
  { name, cloudInit, serverType, firewallProfile }: CreateServerParams,
  token: string,
  allowDeprecatedFallback: boolean,
): Promise<HetznerServerResponse> {
  const firewallId = firewallProfile ? await ensureFirewall(firewallProfile) : undefined;

  const preferredServerType = serverType || process.env.HETZNER_SERVER_TYPE || "cx11";
  const preferredLocation = process.env.HETZNER_LOCATION || "nbg1";
  const { serverType: resolvedServerType, location } = await resolveServerPlacement(
    preferredServerType,
    preferredLocation,
    token,
  );

  const res = await hetznerFetch(`/servers`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name,
      server_type: resolvedServerType,
      image: process.env.HETZNER_IMAGE || "ubuntu-24.04",
      location,
      user_data: cloudInit,
      ssh_keys: process.env.HETZNER_SSH_KEY_ID ? [process.env.HETZNER_SSH_KEY_ID] : undefined,
      firewalls: firewallId ? [{ firewall: firewallId }] : undefined,
      labels: { app: "freqtrade-command-center" },
    }),
  });

  if (!res.ok) {
    const errorBody = await res.text();
    // Translate the specific "type not orderable in this location" 422
    // into something actionable instead of raw Hetzner JSON — this can
    // still happen even after resolveServerPlacement above (e.g. the
    // lookup itself failed and fell through, or Hetzner's catalog changed
    // mid-request), so it's a real fallback, not dead code.
    if (res.status === 422 && errorBody.includes("unsupported location for server type")) {
      const validLocations = await fetchLocationsForServerType(resolvedServerType, token).catch(() => []);
      throw new Error(
        `Serverlocatie "${location}" ondersteunt geen "${resolvedServerType}"-servers.` +
          (validLocations.length > 0
            ? ` Beschikbare locaties voor dit type: ${validLocations.join(", ")}. Zet HETZNER_LOCATION in Vercel op een van deze waardes.`
            : " Kon geen beschikbare locaties ophalen bij Hetzner — probeer het later opnieuw."),
      );
    }
    // Hetzner retires server-type names over time (seen in production: a
    // hardcoded default like "cx22" starts getting rejected here with
    // "server type <id> is deprecated" even though it still showed up as
    // orderable everywhere else we'd checked — see fetchOrderableServerTypes'
    // own doc comment). Rather than surface that raw error, automatically
    // retry once against the cheapest still-orderable shared-vCPU type —
    // this app never needs a specific type badly enough to fail a whole
    // provisioning request over a name Hetzner renamed out from under it.
    if (res.status === 422 && /is deprecated/i.test(errorBody) && allowDeprecatedFallback) {
      const available = await fetchOrderableServerTypes(token).catch(() => []);
      const fallback = available
        .filter((t) => t.cpuType === "shared" && t.name !== resolvedServerType)
        .sort((a, b) => a.cores - b.cores || a.memory - b.memory)[0];
      if (fallback) {
        console.warn(
          `[hetzner] Server type "${resolvedServerType}" is deprecated by Hetzner — retrying with "${fallback.name}" instead.`,
        );
        return createHetznerServerOnce({ name, cloudInit, serverType: fallback.name, firewallProfile }, token, false);
      }
      throw new Error(
        `Server-type "${resolvedServerType}" is afgeschaft bij Hetzner en er kon geen geldig alternatief gevonden worden — probeer het later opnieuw.`,
      );
    }
    throw new Error(`Hetzner API error (${res.status}): ${errorBody}`);
  }

  return res.json();
}

export async function createHetznerServer(params: CreateServerParams): Promise<HetznerServerResponse> {
  const token = requireHetznerToken();
  return createHetznerServerOnce(params, token, true);
}

export async function deleteHetznerServer(serverId: string): Promise<void> {
  const token = requireHetznerToken();

  const res = await hetznerFetch(`/servers/${serverId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 404) {
    const errorBody = await res.text();
    throw new Error(`Hetzner API error (${res.status}): ${errorBody}`);
  }
}

// Sleep Mode: powers the VM off (immediate, hard poweroff — safe here
// since only paper-trading bots with no real position at risk are ever
// eligible, see app/api/bots/sleep-sweep) without deleting it, so Hetzner
// stops billing for compute while still billing the (much cheaper) disk.
// Resuming (POST /api/bots/[id]/resume) still goes through the normal
// delete-and-recreate redeploy path — deleteHetznerServer works fine on an
// already-powered-off server, so no special-casing is needed there.
export async function stopHetznerServer(serverId: string): Promise<void> {
  const token = requireHetznerToken();

  const res = await hetznerFetch(`/servers/${serverId}/actions/poweroff`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok && res.status !== 404) {
    const errorBody = await res.text();
    throw new Error(`Hetzner API error (${res.status}): ${errorBody}`);
  }
}

// Defense in depth: app/api/bots/route.ts already rejects an unsafe
// `strategy` value at creation time, but this function shouldn't blindly
// trust callers for something used as a filesystem path.
function assertSafePythonIdentifier(value: string, label: string): void {
  if (!isSafePythonIdentifier(value)) {
    throw new Error(`${label} must be a valid Python identifier (got: ${JSON.stringify(value)})`);
  }
}

// Renders a cloud-init `write_files` entry. Content lands in the target
// file completely verbatim — no shell involved, so arbitrary strategy
// source (quotes, `$`, backticks, anything) is always safe here.
function writeFilesBlock(entries: Array<{ path: string; content: string; permissions?: string }>): string {
  return entries
    .map(({ path, content, permissions = "0644" }) => {
      const indented = content
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n");
      return `  - path: ${path}\n    permissions: '${permissions}'\n    content: |\n${indented}`;
    })
    .join("\n");
}

// STAKE_CURRENCY and DEFAULT_CORR_PAIRLIST now live in
// lib/training-timerange.ts and are re-exported above. DEFAULT_CORR_PAIRLIST
// backs FreqAI's required include_corr_pairlist config key
// (freqtrade/config_schema/config_schema.py — a MISSING key fails config
// validation outright, unlike an empty list).

// The exchange whose PUBLIC market data every paper-trading bot with no
// linked exchange yet falls back to (see buildFreqtradeCloudInit below) —
// deliberately NOT the bot's own exchangeName (which may not even be set
// yet — see Bot.exchangeName in prisma/schema.prisma, nullable until a real
// ExchangeConnection is linked), which is only relevant once real money
// moves (live `trade`) and is the user's own choice, not ours to guarantee.
//
// NOT Binance/Bybit, deliberately, despite being the more obvious/common
// default picks: Bybit's own CloudFront distribution started hard-blocking
// every EEA IP on 2026-08-03 as part of its MiCA exit. Binance failed to
// secure its own MiCA licence and began suspending EU services around the
// same time (found via live research, so worth re-verifying if this ever
// needs revisiting). OKX (Malta MiCA licence, deep USDT pairs) is confirmed
// still serving the EEA normally.
export const DATA_SOURCE_EXCHANGE = "okx";

// clamped rather than trusted as-is: below AUTO_PAIRLIST_SIZE_RANGE.min
// there's too little diversification for FreqAI to find real
// opportunities, above .max a single local training run (Docker on the
// user's own machine, not a beefy cloud box) stops being a "grab a coffee"
// wait.
function clampAutoPairlistSize(count: number): number {
  return Math.min(AUTO_PAIRLIST_SIZE_RANGE.max, Math.max(AUTO_PAIRLIST_SIZE_RANGE.min, Math.round(count)));
}

// The taker fee freqtrade uses to simulate costs during backtesting/
// dry-run (config's top-level "fee" key — see EXCHANGE_PRESETS for the
// per-exchange source data). Falls back to a conservative 0.1% if the
// exchange somehow isn't in our list — app/api/bots/route.ts already
// rejects that at creation time, so this is defense in depth, not the
// primary guard.
function lookupExchangeFee(exchangeName: string | null): number {
  return EXCHANGE_PRESETS.find((e) => e.id === exchangeName)?.takerFee ?? 0.001;
}

interface PairlistConfig {
  pair_whitelist: string[];
  pairlists: Array<Record<string, unknown>>;
}

// FreqAI needs some universe of pairs to run its per-candle predictions
// against. Auto-select hands that choice to freqtrade's own VolumePairList
// instead of a fixed list the user typed in: it re-ranks the exchange's
// USDT markets by 24h quote volume on every refresh_period and feeds
// whatever's currently most liquid to the strategy, so the bot keeps
// trading where there's real volume instead of stalling on a pair that
// went quiet. Manual mode is the opposite trade-off — a fixed, predictable
// set the user explicitly chose — via StaticPairList.
function buildPairlistConfig(autoSelectCoins: boolean, pairWhitelist: string[], autoSelectPairCount: number): PairlistConfig {
  if (autoSelectCoins) {
    return {
      pair_whitelist: [`.*/${STAKE_CURRENCY}`],
      pairlists: [
        {
          method: "VolumePairList",
          number_assets: clampAutoPairlistSize(autoSelectPairCount),
          sort_key: "quoteVolume",
          min_value: 0,
          refresh_period: 1800,
        },
      ],
    };
  }
  return {
    pair_whitelist: pairWhitelist,
    pairlists: [{ method: "StaticPairList" }],
  };
}

// Every config.json this app generates needs entry_pricing/exit_pricing:
// freqtrade's Exchange.validate_config (freqtrade/exchange/exchange.py)
// does a raw `config["exit_pricing"]` / `config["entry_pricing"]` dict
// subscript unconditionally in its own __init__. Unlike most other config
// keys, these two have no schema-level default that freqtrade could
// silently fill in for a missing key (only their own nested `price_side`
// sub-field does) — omitting them entirely is a bare KeyError, not a
// graceful validation error. `price_side: "same"` + `use_order_book: true`
// matches freqtrade's own documented example config; order_book_top: 1
// reads the best bid/ask, which is the correct behavior for `use_order_book:
// true` — see validate_pricing's own check that the exchange supports
// fetchL2OrderBook (OKX, this app's DATA_SOURCE_EXCHANGE, does).
const PRICE_DISCOVERY_CONFIG = {
  entry_pricing: { price_side: "same", use_order_book: true, order_book_top: 1 },
  exit_pricing: { price_side: "same", use_order_book: true, order_book_top: 1 },
};

// freqtrade's config_schema.py (SCHEMA_TRADE_REQUIRED) lists
// max_open_trades as a required top-level config key, and — unlike
// stoploss/minimal_roi/timeframe, which freqtrade's StrategyResolver
// copies out of the strategy class into config before validation — it has
// no strategy-level equivalent in this app's generated Python (see
// lib/strategy-presets.ts) and no schema default, so it has to be set
// explicitly in every config this app generates.
const DEFAULT_MAX_OPEN_TRADES = 5;

interface CloudInitParams {
  botName: string;
  /**
   * Null until a real ExchangeConnection is linked (see Bot.exchangeName in
   * prisma/schema.prisma — a bot no longer picks an exchange at creation).
   * Falls back to DATA_SOURCE_EXCHANGE below when null, which only
   * legitimately happens for paper trading (live trading requires a
   * verified connection — see lib/deploy-bot.ts's own guard — which always
   * sets this alongside itself, see app/api/bots/[id]/exchange-connection).
   */
  exchangeName: string | null;
  exchangeApiKey: string;
  exchangeApiSecret: string;
  strategy: string;
  strategyCode: string;
  /** Every bot runs FreqAI — this drives the generated freqai config.json block (see lib/strategy-presets.ts). */
  freqaiConfig: FreqAIProfileConfig;
  /** When true, pairWhitelist below is ignored and VolumePairList picks the pairs instead (see buildPairlistConfig). */
  autoSelectCoins: boolean;
  /** How many top-liquid pairs VolumePairList hands to FreqAI — only meaningful when autoSelectCoins is true (see AUTO_PAIRLIST_SIZE_RANGE). */
  autoSelectPairCount: number;
  /** The user's manual pair selection — only used when autoSelectCoins is false. */
  pairWhitelist: string[];
  /** Total amount (stake_currency) this bot may put to work. freqtrade itself is told "unlimited" — custom_stake_amount in the strategy code is the real sizing logic, reading this back via custom_user_settings. */
  totalBudget: number;
  /** Hard ceiling, as a percent of totalBudget, custom_stake_amount enforces on any single trade. */
  maxStakePercentage: number;
  isPaperTrading: boolean;
  /** Snowball mode — see BotConfiguration.autoCompound in prisma/schema.prisma. Read back out of custom_user_settings by custom_stake_amount (lib/strategy-presets.ts) to size off the live wallet instead of the fixed totalBudget snapshot. */
  autoCompound: boolean;
  /**
   * Caps what fraction of the *whole* exchange wallet freqtrade may ever
   * touch — only meaningful (and only ever passed) when autoCompound is on
   * for a live deployment; lib/deploy-bot.ts computes it from
   * totalBudget/liveBalance at deploy time so a real, growing account
   * balance still can't be traded beyond what the user actually allocated
   * to this bot. Omitted for paper trading (the dry-run wallet is already
   * fully virtual — there's no other real balance to protect) and left
   * undefined whenever autoCompound is off, in which case freqtrade's own
   * default (0.99) applies.
   */
  tradableBalanceRatio?: number;
  aiModelDownloadUrl?: string;
  apiServerUsername: string;
  apiServerPassword: string;
  apiServerJwtSecret: string;
  /** POST /api/bots/[id]/status on this deployment — lets the running instance report retraining/error events back. */
  statusWebhookUrl: string;
  /** One-time bearer token for the above, hashed and stored as BotConfiguration.statusWebhookTokenHash. */
  statusWebhookToken: string;
  /**
   * Our single central Telegram bot's token (process.env.TELEGRAM_BOT_TOKEN)
   * — the same bot for every user, distinguished only by which chat_id it's
   * telling to notify. Both this and telegramChatId must be present for
   * freqtrade's own telegram integration to turn on; either missing (no
   * server-wide token configured, or this user never linked a chat) just
   * silently skips the block, exactly like aiModelDownloadUrl being absent
   * skips the model-download step.
   */
  telegramBotToken?: string;
  /** This bot owner's linked chat — see Profile.telegramChatId in prisma/schema.prisma. */
  telegramChatId?: string;
}

// Builds a cloud-init script that installs Docker, writes the strategy
// source, Freqtrade config.json, and webhook.json (this bot's
// POST /api/bots/[id]/status URL + token), (optionally) fetches the
// uploaded .joblib FreqAI model, and starts the container. Callers must
// attach the "live-trading" firewall profile (see createHetznerServer)
// since this opens the REST API on 0.0.0.0:8080 — that's why real,
// per-deployment api_server credentials are required params here rather
// than a constant.
export function buildFreqtradeCloudInit(params: CloudInitParams): string {
  const {
    botName,
    exchangeName,
    exchangeApiKey,
    exchangeApiSecret,
    strategy,
    strategyCode,
    freqaiConfig,
    autoSelectCoins,
    autoSelectPairCount,
    pairWhitelist,
    totalBudget,
    maxStakePercentage,
    isPaperTrading,
    autoCompound,
    tradableBalanceRatio,
    aiModelDownloadUrl,
    apiServerUsername,
    apiServerPassword,
    apiServerJwtSecret,
    statusWebhookUrl,
    statusWebhookToken,
    telegramBotToken,
    telegramChatId,
  } = params;

  assertSafePythonIdentifier(strategy, "strategy");
  const safeBotName = botName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const pairlistConfig = buildPairlistConfig(autoSelectCoins, pairWhitelist, autoSelectPairCount);
  // A bot only ever reaches here with exchangeName null while paper
  // trading (live requires a verified ExchangeConnection, which always
  // sets it — see the CloudInitParams doc comment above) — falls back to
  // the same fixed, EEA-safe public data source training uses, so a
  // brand-new bot with no connection yet still paper-trades against real
  // market data instead of failing outright. Once a connection exists
  // (even while still paper trading, for a realistic dry-run), this is
  // always the bot's own real exchange again.
  const effectiveExchangeName = exchangeName ?? DATA_SOURCE_EXCHANGE;

  const freqtradeConfig = {
    max_open_trades: DEFAULT_MAX_OPEN_TRADES,
    stake_currency: STAKE_CURRENCY,
    // "unlimited" hands sizing entirely to custom_stake_amount in the
    // strategy code, which reads total_budget/max_stake_pct back out of
    // custom_user_settings below — a fixed config.json number can't scale
    // with FreqAI's own per-trade confidence the way that function does.
    stake_amount: "unlimited",
    // Used by freqtrade to simulate trading costs in backtests and
    // dry-run (real live trades read the exchange's actual fill fees
    // instead) — without this, dry-run defaults to a generic ~0.25% that
    // may not match the exchange the user actually picked, understating
    // or overstating how much a scalping strategy's paper P&L would
    // really keep after costs.
    fee: lookupExchangeFee(effectiveExchangeName),
    dry_run: isPaperTrading,
    dry_run_wallet: totalBudget,
    cancel_open_orders_on_exit: false,
    trading_mode: "spot",
    ...PRICE_DISCOVERY_CONFIG,
    // Not read by freqtrade core — this is how the strategy's
    // custom_stake_amount (see lib/strategy-presets.ts) gets the user's
    // budget, per-trade risk ceiling, and snowball preference out of
    // config.json.
    custom_user_settings: {
      total_budget: totalBudget,
      max_stake_pct: maxStakePercentage,
      auto_compound: autoCompound,
    },
    // freqtrade's own real setting (not custom_user_settings) — the safety
    // margin on top of custom_stake_amount's own ceiling, so a bug or an
    // unexpectedly large live balance still can't make freqtrade try to
    // use funds outside what this bot was ever allocated. Absent whenever
    // it wasn't computed (paper trading, or autoCompound off) — freqtrade
    // defaults to 0.99 on its own.
    ...(tradableBalanceRatio !== undefined && { tradable_balance_ratio: tradableBalanceRatio }),
    exchange: {
      name: effectiveExchangeName,
      key: exchangeApiKey,
      secret: exchangeApiSecret,
      ccxt_config: {},
      ccxt_async_config: {},
      pair_whitelist: pairlistConfig.pair_whitelist,
      pair_blacklist: [],
    },
    pairlists: pairlistConfig.pairlists,
    strategy,
    // Every bot runs FreqAI — freqaimodel is a top-level config key (also
    // settable via --freqaimodel on the CLI, which the training pipeline
    // uses instead; here the strategy is started via `trade`, so it has to
    // go in config.json).
    freqaimodel: freqaiConfig.freqaiModel,
    ...(freqaiConfig.positionAdjustment?.enabled && {
      position_adjustment_enable: true,
      max_entry_position_adjustment: freqaiConfig.positionAdjustment.maxEntryPositionAdjustment,
    }),
    freqai: aiModelDownloadUrl
      ? {
          enabled: true,
          identifier: `${safeBotName}-model`,
          train_period_days: freqaiConfig.training.trainPeriodDays,
          backtest_period_days: freqaiConfig.training.backtestPeriodDays,
          live_retrain_hours: freqaiConfig.training.liveRetrainHours,
          feature_parameters: {
            include_timeframes: freqaiConfig.features.includeTimeframes,
            include_corr_pairlist: DEFAULT_CORR_PAIRLIST,
            indicator_periods_candles: freqaiConfig.features.indicatorPeriods,
          },
          data_split_parameters: { test_size: 0.25 },
        }
      : undefined,
    api_server: {
      enabled: true,
      listen_ip_address: "0.0.0.0",
      listen_port: 8080,
      jwt_secret_key: apiServerJwtSecret,
      username: apiServerUsername,
      password: apiServerPassword,
    },
    // freqtrade's own built-in Telegram integration — no notification-
    // sending code of our own needed, it messages the chat directly from
    // inside the container on every entry/exit. Omitted entirely (rather
    // than enabled: false) whenever either half is missing, so an unset
    // server-wide token or an unlinked user never even renders the block.
    ...(telegramBotToken &&
      telegramChatId && {
        telegram: {
          enabled: true,
          token: telegramBotToken,
          chat_id: telegramChatId,
        },
      }),
  };

  const configJson = JSON.stringify(freqtradeConfig, null, 2);

  // Not consumed by freqtrade itself — this is the integration point for a
  // custom FreqAI model class or strategy callback (both fully under the
  // user's control via strategyCode) to report "retrain_needed" or
  // "training_complete" back to our backend. Vanilla freqtrade has no
  // built-in hook for "I just retrained", so wiring this up is on the
  // strategy/model code; we just guarantee the credentials are there.
  const webhookJson = JSON.stringify({ url: statusWebhookUrl, token: statusWebhookToken }, null, 2);

  // Each runcmd entry is rendered via JSON.stringify — JSON's double-quoted
  // string syntax is valid YAML flow-scalar syntax, which guarantees a `#`,
  // `"`, or `\` in an interpolated URL can never be misread as a YAML
  // comment or break the surrounding quoting.
  const runcmdSteps = [
    "systemctl enable docker",
    "systemctl start docker",
    ...(aiModelDownloadUrl
      ? [
          "mkdir -p /opt/freqtrade/user_data/models",
          `curl -fsSL "${aiModelDownloadUrl}" -o /opt/freqtrade/user_data/models/${safeBotName}-model.joblib`,
        ]
      : []),
    `docker run -d --name ${safeBotName} --restart unless-stopped -v /opt/freqtrade/user_data:/freqtrade/user_data -p 8080:8080 ${FREQTRADE_DOCKER_IMAGE} trade --config /freqtrade/user_data/config.json --strategy ${strategy}`,
  ];
  const runcmdYaml = runcmdSteps.map((step) => `  - ${JSON.stringify(step)}`).join("\n");

  return `#cloud-config
package_update: true
packages:
  - docker.io
  - docker-compose-plugin

write_files:
${writeFilesBlock([
  { path: "/opt/freqtrade/user_data/config.json", content: configJson },
  { path: `/opt/freqtrade/user_data/strategies/${strategy}.py`, content: strategyCode },
  { path: "/opt/freqtrade/user_data/webhook.json", content: webhookJson, permissions: "0600" },
])}

runcmd:
${runcmdYaml}
`;
}

