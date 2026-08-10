import { isSafePythonIdentifier } from "@/lib/strategy-validation";
import { STRATEGY_PRESETS, type FreqAIProfileConfig } from "@/lib/strategy-presets";
import { EXCHANGE_PRESETS } from "@/lib/exchange-presets";
import {
  computeTrainingTimerangeDays,
  computeTrainingTimerange,
  timeframeToMinutes,
  STAKE_CURRENCY,
  DEFAULT_CORR_PAIRLIST,
} from "@/lib/training-timerange";

// Re-exported so every existing "@/lib/hetzner" import of these keeps
// working unchanged — see training-timerange.ts's own doc comment for why
// the values themselves now live there instead.
export { STAKE_CURRENCY, DEFAULT_CORR_PAIRLIST };

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

type FirewallProfile = "live-trading" | "training" | "data-server";

// Creates (or reuses) a Hetzner Cloud Firewall for the given profile and
// returns its id. "live-trading" opens only what a deployed bot actually
// needs (the freqtrade REST API, plus SSH only if a key is configured);
// "training" opens nothing at all — the ephemeral training VM never
// listens on any port, it only makes outbound calls (including the rsync
// pull FROM the data server below — that's this VM connecting OUT, not
// something it needs to accept inbound). "data-server" is the one
// permanent box in this whole setup and opens only SSH — see
// buildDataServerCloudInit's own doc comment for why key-only auth over
// the public internet (same trade-off "live-trading" already makes for
// its own optional admin SSH) is an acceptable, deliberately simple
// choice here rather than standing up a private network for a single
// always-on box serving nothing but public market data.
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

  const rules =
    profile === "live-trading"
      ? [
          {
            direction: "in",
            protocol: "tcp",
            port: "8080",
            source_ips: ["0.0.0.0/0", "::/0"],
            description: "Freqtrade REST API / FreqUI",
          },
          ...(process.env.HETZNER_SSH_KEY_ID ? [sshRule] : []),
        ]
      : profile === "data-server"
        ? [sshRule]
        : [];

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
// This matters specifically for training VMs pulling market data from the
// permanent data server (see rsyncDataScript / buildDataServerCloudInit):
// the whole reason that transfer is fast is both boxes sitting in the same
// Hetzner datacenter, so a training VM silently landing in a different
// region because its own hardcoded default type (e.g. HETZNER_TRAINING_SERVER_TYPE)
// isn't orderable there defeats that design even though it still "works" —
// seen in production as cpx31 training VMs landing in ash/hil (Ashburn/
// Hillsboro, US) while the data server sits in fsn1 (Falkenstein, DE). A
// type the operator configured is much more likely to be an arbitrary
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

// Fixed name for the one permanent data server this app ever creates (see
// buildDataServerCloudInit) — shared by scripts/provision-data-server.ts
// and app/api/admin/data-server so "look it up", "create it", and "delete
// it" all agree on which Hetzner server they mean, the same way
// ensureFirewall's own firewall names double as their lookup key.
export const DATA_SERVER_HETZNER_NAME = "freqpanda-data-server";

export interface DataServerStatus {
  id: number;
  status: string;
  ip: string | null;
  created: string;
}

// Looks the permanent data server up by name rather than tracking its id
// anywhere in our own DB — there's exactly one of these, ever, so Hetzner's
// own server-list is already the single source of truth for whether it
// exists and what state it's in. Returns null (not an error) when none
// exists yet, e.g. before the first provisioning call.
export async function findDataServer(): Promise<DataServerStatus | null> {
  const token = requireHetznerToken();
  const res = await hetznerFetch(`/servers?name=${encodeURIComponent(DATA_SERVER_HETZNER_NAME)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    throw new Error(`Hetzner API error (${res.status}): ${await res.text()}`);
  }
  const { servers } = (await res.json()) as {
    servers: Array<{ id: number; status: string; created: string; public_net: { ipv4?: { ip: string } } }>;
  };
  const server = servers[0];
  if (!server) return null;
  return { id: server.id, status: server.status, ip: server.public_net.ipv4?.ip ?? null, created: server.created };
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
// source (quotes, `$`, backticks, anything) is always safe here, unlike
// content destined for a shell script (see shellEscapeDouble below).
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
// validation outright, unlike an empty list) and also the permanent data
// server's own download-pairs union (see buildDataServerCloudInit below) —
// otherwise a run using that server's data would silently be missing the
// one pair every FreqAI feature set actually depends on.

// The exchange whose PUBLIC market data (download-data/backtesting) every
// FreqAI training run actually reads candles from — deliberately NOT the
// bot's own exchangeName (which may not even be set yet — see Bot.exchangeName
// in prisma/schema.prisma, nullable until a real ExchangeConnection is
// linked), which is only relevant once real money moves (live `trade`, see
// buildFreqtradeCloudInit) and is the user's own choice, not ours to
// guarantee. Training's own VM never receives real account credentials in
// the first place (see the doc comment on buildFreqAITrainingArtifacts
// below), so there was never a reason to tie its data source to whichever
// exchange the bot happens to trade on.
//
// NOT Binance/Bybit, deliberately, despite being the more obvious/common
// default picks: Bybit's own CloudFront distribution started hard-blocking
// every EEA IP (including this platform's Hetzner training VMs, hosted in
// Germany) on 2026-08-03 as part of its MiCA exit — the exact failure this
// constant exists to route around, discovered when it was still hardcoded
// as the bot's own exchange. Binance failed to secure its own MiCA licence
// and began suspending EU services around the same time (found via live
// research, so worth re-verifying if this ever needs revisiting). OKX (Malta
// MiCA licence, deep USDT pairs) and Gate.io (Malta CASP authorization,
// also deep USDT pairs) are both confirmed still serving the EEA normally.
// If either ever has its own outage/block, change these two constants —
// every training run and the data server's own daily cron (see
// buildDataServerCloudInit) pick it up on their next run, no per-bot
// migration.
export const DATA_SOURCE_EXCHANGE = "okx";
export const DATA_SOURCE_EXCHANGE_FALLBACK = "gate";
export const DATA_SOURCE_EXCHANGES = [DATA_SOURCE_EXCHANGE, DATA_SOURCE_EXCHANGE_FALLBACK];

// Dedicated, low-privilege account on the permanent data server — never
// root, and its authorized_keys entry (see buildDataServerCloudInit) is
// restricted to rsync's own `rrsync` wrapper in read-only mode, so even a
// leaked training-VM private key only ever unlocks read access to the
// downloaded market data, nothing else on that box.
export const DATA_SERVER_SSH_USER = "datasync";

export interface DataServerConfig {
  host: string;
  /**
   * Base64 encoding of the full private key PEM (BEGIN/END lines and all
   * internal newlines included in what gets encoded) — NOT the raw PEM
   * text. See normalizeBase64Key's own doc comment for why.
   */
  sshPrivateKey: string;
}

// DATA_SERVER_SSH_PRIVATE_KEY is stored as a single-line BASE64 encoding of
// the full PEM private key, not the raw multi-line PEM text. Three
// different production incidents, in order, all traced back to the same
// root cause — a Vercel env var is a single text field, and something
// between "paste" and "the value Node actually reads back" kept mangling
// whatever newlines were in there: literal "\n" text, then real CRLF line
// endings, and finally (confirmed via the ssh-keygen diagnostic in
// rsyncDataScript below) newlines disappearing altogether — "1 lines, 381
// bytes" for a key that should be 6 lines, nothing left to even
// reconstruct breaks from. Base64's alphabet has no newlines, carriage
// returns, or other whitespace in it, so there is nothing left for an
// env-var UI to mangle: whatever comes back out of process.env is decoded
// byte-for-byte on the VM itself (`base64 -d`, see rsyncDataScript), which
// is what actually reconstructs the original multi-line PEM. This
// sidesteps the newline-preservation problem instead of chasing yet
// another way to lose it.
//
// To generate this value from a private key file:
//   base64 -w0 id_dataserver > value_to_paste.txt     # Linux
//   base64 -i id_dataserver -o value_to_paste.txt     # macOS
// then paste value_to_paste.txt's content as DATA_SERVER_SSH_PRIVATE_KEY in
// Vercel (Production) — it's one line, so there's no multi-line paste
// behavior left to trust in the first place.
function normalizeBase64Key(raw: string): string {
  // Base64 text never legitimately contains whitespace, so stripping every
  // whitespace character anywhere (not just at the ends) is always safe
  // here — unlike the old PEM-text normalization, there's no structure
  // (line breaks) worth preserving to begin with.
  return raw.replace(/\s+/g, "");
}

// Both env vars are set once, by hand, after running
// scripts/provision-data-server.ts (see that script's own doc comment) —
// there's no way to know the server's IP or mint its trusted key pair from
// inside a Vercel request. Returns null (never throws) when either is
// missing, exactly like the old resolveCachedTrainingData did for an
// unusable cache: lib/train-cloud.ts falls back to the classic on-VM
// download-data loop below rather than failing a training run outright —
// this whole feature is additive, not a hard requirement to run the app.
export function getDataServerConfig(): DataServerConfig | null {
  const host = process.env.DATA_SERVER_HOST;
  const rawSshPrivateKey = process.env.DATA_SERVER_SSH_PRIVATE_KEY;
  if (!host || !rawSshPrivateKey) return null;
  return { host, sshPrivateKey: normalizeBase64Key(rawSshPrivateKey) };
}

// Public half of the dedicated ed25519 keypair every training VM uses to
// reach the data server (see rsyncDataScript below for the private half's
// own doc comment, and DataServerConfig.sshPrivateKey above for where that
// half actually comes from — DATA_SERVER_SSH_PRIVATE_KEY, never this file).
// Safe to hardcode: it's a public key, and the account it's trusted by
// (DATA_SERVER_SSH_USER) can only ever run one restricted command anyway
// (see the authorized_keys entry in buildDataServerCloudInit below).
const DATA_SERVER_TRUSTED_PUBLIC_KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIDqbEwpkia/KRcsteyWz/0QtE9zYFNtZL7r/D6jaVwuC freqtrade-training-vm-to-dataserver";

// Both DATA_SERVER_SSH_USER's $HOME and the directory rrsync is restricted
// to below — also what rsyncDataScript's relative paths ("user_data/data/...",
// "pairlist.json") resolve against once rrsync chdir's into it. Changing
// this constant alone (without also updating a live server) would break
// every training VM's rsync pull, so it isn't meant to ever change.
const DATA_SERVER_HOME_DIR = "/opt/freqdata";

// Cloud-init for the one permanent, always-on box this whole platform
// provisions — every other Hetzner server this app creates (live-trading
// deploys via buildFreqtradeCloudInit, training VMs via
// buildFreqAITrainingArtifacts) is ephemeral, torn down right after a
// single job. This one runs freqtrade's own `download-data` on a plain
// system cron, once a day, and just keeps a normal, standard-format
// freqtrade data directory on disk — ephemeral training VMs rsync from it
// (see rsyncDataScript in buildFreqAITrainingArtifacts above) instead of
// each independently re-downloading the same candles from the exchange.
//
// This replaces the old Supabase-Storage-backed cache
// (lib/market-data-cache.ts, deleted) outright. That design's entire
// complexity — day-partitioned chunks, a shuffled task queue, a starvation
// fix, a training-readiness gate — existed to work around ONE constraint:
// a Vercel serverless function can't stay running for hours. A real,
// always-on server has no such limit, so none of that was actually
// necessary to solve the underlying problem ("keep a rolling window of
// candles on hand") — it's just freqtrade's own documented workflow
// (`download-data` on a cron), run on a box that can actually run it
// uninterrupted.
//
// Provisioned once, by hand, via scripts/provision-data-server.ts — not
// through the normal bot-deploy/training request flow, since nothing about
// "stand up the one permanent data server" is a per-request operation.
export function buildDataServerCloudInit(): string {
  // Reuses the exact same VolumePairList spec a real auto-select bot gets
  // (see buildPairlistConfig) — this server's own top-AUTO_PAIRLIST_SIZE
  // resolution is meant to be identical to what a bot would ask for, not a
  // separately-maintained approximation of it.
  const pairlistConfig = buildPairlistConfig(true, []);

  const timeframes = Array.from(
    new Set(
      STRATEGY_PRESETS.flatMap((preset) => [
        preset.freqaiConfig.features.baseTimeframe,
        ...preset.freqaiConfig.features.includeTimeframes,
      ]),
    ),
  ).sort((a, b) => timeframeToMinutes(a) - timeframeToMinutes(b));

  // Max across every strategy preset's own computeTrainingTimerangeDays
  // (lib/training-timerange.ts) — this server keeps enough history for
  // whichever preset a given bot ends up using, not just one of them.
  const backfillDays = Math.max(
    ...STRATEGY_PRESETS.map((preset) => computeTrainingTimerangeDays(preset.freqaiConfig)),
  );

  const dataServerConfig = {
    exchange: {
      name: DATA_SOURCE_EXCHANGE,
      key: "",
      secret: "",
      ccxt_config: {},
      ccxt_async_config: {},
      pair_whitelist: pairlistConfig.pair_whitelist,
      pair_blacklist: [],
    },
    pairlists: pairlistConfig.pairlists,
    stake_currency: STAKE_CURRENCY,
    // freqtrade's SCHEMA_MINIMAL_REQUIRED (config_schema.py) — the only
    // required keys under RunMode.OTHER, which is what download-data and
    // test-pairlist both run under — is just this list. No
    // stoploss/minimal_roi/entry_pricing/exit_pricing/max_open_trades here,
    // unlike buildFreqtradeCloudInit/buildFreqAITrainingArtifacts above:
    // this config.json never drives `trade` or `backtesting`, only
    // download-data/test-pairlist.
    dry_run: true,
    dataformat_ohlcv: "feather",
    dataformat_trades: "jsongz",
  };
  const configJson = JSON.stringify(dataServerConfig, null, 2);

  const timeframeArgs = timeframes.map((tf) => shellEscapeDouble(tf)).join(" ");
  const dataSourceList = DATA_SOURCE_EXCHANGES.map((ds) => shellEscapeDouble(ds)).join(" ");
  const corrPairlistJson = JSON.stringify(DEFAULT_CORR_PAIRLIST);

  // Runs once immediately at boot (the first-ever backfill — see runcmd
  // below) and then once a day via /etc/cron.d/freqdata-refresh. The exact
  // same script handles both cases with no branching between them:
  // freqtrade's download-data is naturally idempotent/incremental (an
  // overlapping --days range only ever fetches what's actually missing and
  // appends locally), which is what let this whole design drop the old
  // cache's separate "first run vs. daily run" logic entirely.
  const refreshScript = `#!/bin/bash
set -uo pipefail
cd "${DATA_SERVER_HOME_DIR}" || exit 1
LOG=/var/log/freqdata-refresh.log

{
echo "=== freqdata refresh run: $(date -u +%FT%TZ) ==="

REFRESH_OK=0
for data_source in ${dataSourceList}; do
  echo "--- trying data source: $data_source ---"
  jq --arg name "$data_source" '.exchange.name = $name' user_data/config.json > user_data/config.json.tmp \\
    && mv user_data/config.json.tmp user_data/config.json

  # --print-json writes exactly the resolved pair list, and nothing else,
  # to stdout — freqtrade's own INFO/WARNING logging goes to stderr, which
  # is what lets PAIRS_JSON below capture clean JSON without filtering.
  PAIRS_JSON=$(docker run --rm -v "${DATA_SERVER_HOME_DIR}/user_data:/freqtrade/user_data" ${FREQTRADE_DOCKER_IMAGE} \\
    test-pairlist --config user_data/config.json --print-json 2>>"$LOG")
  if ! echo "$PAIRS_JSON" | jq -e 'type == "array" and length > 0' >/dev/null 2>&1; then
    echo "test-pairlist against $data_source returned no usable pairlist, trying next source"
    continue
  fi

  # BTC/USDT is unioned in for DOWNLOADING purposes only (every FreqAI
  # preset's feature engineering needs it for correlation features even on
  # a run where it wouldn't otherwise be in the top pairs by volume — see
  # DEFAULT_CORR_PAIRLIST's own doc comment). pairlist.json itself (written
  # below, only once download-data actually succeeds) stays the real,
  # untouched top-pairs list — this union never affects what a bot trades,
  # only what gets downloaded.
  DOWNLOAD_PAIRS_JSON=$(echo "$PAIRS_JSON" | jq -c --argjson corr '${corrPairlistJson}' '. + $corr | unique')
  readarray -t DOWNLOAD_PAIRS < <(echo "$DOWNLOAD_PAIRS_JSON" | jq -r '.[]')

  echo "--- downloading ${timeframes.length} timeframes x \${#DOWNLOAD_PAIRS[@]} pairs, ${backfillDays} days, via $data_source ---"
  if docker run --rm -v "${DATA_SERVER_HOME_DIR}/user_data:/freqtrade/user_data" ${FREQTRADE_DOCKER_IMAGE} \\
    download-data --config user_data/config.json --days ${backfillDays} \\
    --timeframes ${timeframeArgs} \\
    --pairs "\${DOWNLOAD_PAIRS[@]}" \\
    >>"$LOG" 2>&1; then
    echo "$PAIRS_JSON" > "${DATA_SERVER_HOME_DIR}/pairlist.json"
    REFRESH_OK=1
    echo "=== refresh succeeded via $data_source ==="
    break
  else
    echo "=== download-data failed via $data_source, trying next source ==="
  fi
done

if [ "$REFRESH_OK" -eq 1 ]; then
  chown -R ${DATA_SERVER_SSH_USER}:${DATA_SERVER_SSH_USER} "${DATA_SERVER_HOME_DIR}/user_data" "${DATA_SERVER_HOME_DIR}/pairlist.json"
else
  echo "=== refresh FAILED against every data source (tried: ${DATA_SOURCE_EXCHANGES.join(", ")}) — yesterday's data on disk is untouched, training VMs still get that ==="
fi
} >> "$LOG" 2>&1
`;

  // Where rrsync actually ends up on disk, regardless of how this
  // particular image's rsync package happens to ship it (see the runcmd
  // step below) — authorized_keys references this fixed path rather than
  // whatever the OS package's own layout happens to be, so the two can
  // never drift out of sync with each other.
  const RRSYNC_PATH = "/usr/local/bin/rrsync";

  // -ro (read-only) + this specific directory is the entire security
  // boundary for a leaked training-VM private key: rrsync itself refuses
  // any path outside DATA_SERVER_HOME_DIR and refuses to ever write.
  // no-pty/no-port-forwarding/no-X11-forwarding/no-agent-forwarding close
  // off every other thing an SSH session could otherwise be used for.
  //
  // Deliberately kept as rrsync rather than pinning a literal
  // `command="rsync --server ..."` string instead (the obvious-looking
  // simpler alternative): that would hardcode the exact flag sequence
  // rsync's client and server sides happen to negotiate today, which
  // silently breaks on the next rsync version bump on either end — rrsync
  // exists specifically to stay correct across that without caring which
  // flags a compatible rsync invocation actually used, only that the
  // requested path stays inside the one directory it's told to allow. A
  // missing/wrong PATH here is a one-time provisioning bug (see the
  // install step below); a fragile hardcoded rsync command line would be a
  // recurring one.
  const authorizedKeysLine = `command="${RRSYNC_PATH} -ro ${DATA_SERVER_HOME_DIR}/",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ${DATA_SERVER_TRUSTED_PUBLIC_KEY}\n`;

  // Deliberately not top-of-hour (0 0) — a small, arbitrary offset so this
  // doesn't line up with every other cron-driven thing that defaults to
  // midnight. Runs as root (docker access, plus the chown at the end)
  // rather than as DATA_SERVER_SSH_USER, which has no docker group
  // membership and shouldn't need one.
  const cronEntry = `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
17 3 * * * root ${DATA_SERVER_HOME_DIR}/refresh.sh >/dev/null 2>&1\n`;

  const runcmdSteps = [
    "systemctl enable docker",
    "systemctl start docker",
    `docker pull ${FREQTRADE_DOCKER_IMAGE}`,
    // --system + --no-create-home: the home dir already exists (write_files
    // below creates it, since config.json has to be there before this user
    // is even created) and useradd shouldn't touch its contents. A real
    // shell (NOT /usr/sbin/nologin, --system's own default) is required
    // despite this account never getting an interactive session: sshd runs
    // an authorized_keys forced command via the target user's own login
    // shell ("$SHELL -c '<command>'") — a nologin shell would refuse to
    // run rrsync at all, not just block interactive login. The forced
    // command itself, not the shell, is what keeps this restricted.
    `id -u ${DATA_SERVER_SSH_USER} >/dev/null 2>&1 || useradd --system --no-create-home --home-dir ${DATA_SERVER_HOME_DIR} --shell /bin/bash ${DATA_SERVER_SSH_USER}`,
    // rrsync ships with the rsync package, but WHERE and HOW varies by
    // distro/packaging — confirmed in production: Ubuntu 24.04's apt
    // package does NOT place a ready-to-run copy at
    // /usr/share/rsync/scripts/rrsync (the location this originally
    // assumed, an unverified guess based on other distros' layout); it
    // ships a gzipped copy under /usr/share/doc/rsync/scripts/rrsync.gz
    // instead, as documentation rather than an installed script. A plain
    // `chmod +x` on a path that doesn't exist fails silently in cloud-init
    // (a failed runcmd step doesn't abort the rest), which is exactly how
    // this got missed until a real rsync connection hit
    // "No such file or directory" on the SSH forced command. This checks
    // every known location this script has actually been found in,
    // decompressing if needed, and always installs to the fixed
    // RRSYNC_PATH above regardless of which one matched — authorized_keys
    // never has to guess, and this is now self-healing across whatever
    // Ubuntu does with rsync packaging next.
    [
      `[ -x ${RRSYNC_PATH} ] || for candidate in /usr/share/rsync/scripts/rrsync /usr/share/doc/rsync/scripts/rrsync /usr/share/doc/rsync/scripts/rrsync.gz; do`,
      `  if [ -f "$candidate" ]; then`,
      `    case "$candidate" in`,
      `      *.gz) gunzip -c "$candidate" > ${RRSYNC_PATH} ;;`,
      `      *) cp "$candidate" ${RRSYNC_PATH} ;;`,
      `    esac`,
      `    break`,
      `  fi`,
      `done`,
      `chmod +x ${RRSYNC_PATH} 2>>/var/log/freqdata-refresh.log || echo "rrsync install: no known source found" >> /var/log/freqdata-refresh.log`,
    ].join("\n"),
    `mkdir -p ${DATA_SERVER_HOME_DIR}/.ssh`,
    `chown -R ${DATA_SERVER_SSH_USER}:${DATA_SERVER_SSH_USER} ${DATA_SERVER_HOME_DIR}/.ssh`,
    `chmod 700 ${DATA_SERVER_HOME_DIR}/.ssh`,
    "systemctl enable cron",
    "systemctl restart cron",
    // Kicks off the very first, full backfill immediately rather than
    // waiting for tomorrow's 03:17 UTC slot — see this function's own doc
    // comment (point 3: "EENMALIGE VOLLEDIGE BACKFILL"). Backgrounded, not
    // awaited: a first run covering ~backfillDays days x every timeframe x
    // every pair can legitimately take hours, and cloud-init finishing
    // promptly matters more than blocking server-ready on it. Progress:
    // `ssh root@<ip> tail -f /var/log/freqdata-refresh.log`.
    `nohup ${DATA_SERVER_HOME_DIR}/refresh.sh > /dev/null 2>&1 &`,
  ];
  const runcmdYaml = runcmdSteps.map((step) => `  - ${JSON.stringify(step)}`).join("\n");

  return `#cloud-config
package_update: true
packages:
  - docker.io
  - cron
  - rsync
  - jq

write_files:
${writeFilesBlock([
  { path: `${DATA_SERVER_HOME_DIR}/user_data/config.json`, content: configJson },
  { path: `${DATA_SERVER_HOME_DIR}/refresh.sh`, content: refreshScript, permissions: "0755" },
  { path: `${DATA_SERVER_HOME_DIR}/.ssh/authorized_keys`, content: authorizedKeysLine, permissions: "0600" },
  { path: "/etc/cron.d/freqdata-refresh", content: cronEntry, permissions: "0644" },
])}

runcmd:
${runcmdYaml}
`;
}

// Mirrors app/api/train/cloud/reap/route.ts's own DOWNLOAD_DATA_QUEUE_TIMEOUT_MINUTES
// (kept as a separate read rather than a shared import since that route's
// copy governs the external reap cron, while this one only sizes the
// internal download-data timeout below) — carved out of the same budget,
// minus a safety margin, so a legitimately slow download self-reports
// FAILED, with the pairs it got through before running out of time (via
// TRAIN_LOG's tail — see fail() below), well before the external reap
// cron's blind kill at the full window. A hard-killed VM never runs its own
// EXIT trap, so without this, a slow download degrades all the way to
// reap's generic "no progress" message with zero diagnostic info, no
// matter how much we log — this makes the training script itself the one
// that reports first. Default (120 min) sized for an auto-select bot's
// wildcard ".*/USDT" download (see reap route's own doc comment on
// DOWNLOAD_DATA_QUEUE_TIMEOUT_MINUTES for the full reasoning) — every
// active USDT pair on the exchange, not just the ~30 a live/dry-run
// instance actually trades, downloaded fully sequentially per
// (pair, timeframe) since a 90-day/5m+15m range never fits in freqtrade's
// single-call "fast parallel" path.
const DOWNLOAD_DATA_QUEUE_TIMEOUT_MINUTES = Number(process.env.DOWNLOAD_DATA_QUEUE_TIMEOUT_MINUTES) || 120;
const DOWNLOAD_DATA_TIMEOUT_SECONDS = Math.max(60, (DOWNLOAD_DATA_QUEUE_TIMEOUT_MINUTES - 5) * 60);
// DOWNLOAD_DATA_TIMEOUT_SECONDS split evenly across DATA_SOURCE_EXCHANGES so
// trying the fallback after the primary fails still fits inside the same
// overall budget the reap cron expects, rather than potentially doubling
// the total wait.
const DOWNLOAD_DATA_ATTEMPT_TIMEOUT_SECONDS = Math.max(
  30,
  Math.floor(DOWNLOAD_DATA_TIMEOUT_SECONDS / DATA_SOURCE_EXCHANGES.length),
);

// How many of the exchange's top-liquid USDT markets VolumePairList hands
// to FreqAI when auto-select is on — wide enough for the AI to find real
// opportunities, small enough that feature engineering/backtesting for a
// single training run stays bounded. Also used by buildDataServerCloudInit
// below (via buildPairlistConfig(true, [])) so the permanent data server
// downloads exactly this many top-volume pairs — the same size a real
// auto-select bot's own VolumePairList would resolve to, not a separately
// maintained approximation of it.
export const AUTO_PAIRLIST_SIZE = 30;

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
// set the user explicitly chose — via StaticPairList. Shared by both
// cloud-init builders below so live trading and FreqAI training (which
// still resolves its pairlist through freqtrade's own `download-data`/
// `backtesting`, not a hardcoded --pairs list) always agree on what
// "the bot's pairs" means for a given bot.
function buildPairlistConfig(autoSelectCoins: boolean, pairWhitelist: string[]): PairlistConfig {
  if (autoSelectCoins) {
    return {
      pair_whitelist: [`.*/${STAKE_CURRENCY}`],
      pairlists: [
        {
          method: "VolumePairList",
          number_assets: AUTO_PAIRLIST_SIZE,
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

// Every config.json this app generates — live deploy AND training/
// backtesting — needs entry_pricing/exit_pricing: freqtrade's
// Exchange.validate_config (freqtrade/exchange/exchange.py) does a raw
// `config["exit_pricing"]` / `config["entry_pricing"]` dict subscript
// unconditionally in its own __init__, for every runmode (live, dry-run,
// AND backtesting — which is how FreqAI training actually runs, see
// buildFreqAITrainingArtifacts's own doc comment). Unlike most other
// config keys, these two have no schema-level default that freqtrade could
// silently fill in for a missing key (only their own nested `price_side`
// sub-field does) — omitting them entirely is a bare KeyError, not a
// graceful validation error. `price_side: "same"` + `use_order_book: true`
// matches freqtrade's own documented example config; order_book_top: 1
// reads the best bid/ask, which is the correct behavior for `use_order_book:
// true` — see validate_pricing's own check that the exchange supports
// fetchL2OrderBook (both OKX and Gate.io, this app's DATA_SOURCE_EXCHANGE(S),
// do).
const PRICE_DISCOVERY_CONFIG = {
  entry_pricing: { price_side: "same", use_order_book: true, order_book_top: 1 },
  exit_pricing: { price_side: "same", use_order_book: true, order_book_top: 1 },
};

// freqtrade's config_schema.py (SCHEMA_TRADE_REQUIRED and
// SCHEMA_BACKTEST_REQUIRED_FINAL — the latter applies to `backtesting`,
// which is how FreqAI training runs) both list max_open_trades as a
// required top-level config key, and — unlike stoploss/minimal_roi/
// timeframe, which freqtrade's StrategyResolver copies out of the
// strategy class into config before validation — it has no strategy-level
// equivalent in this app's generated Python (see lib/strategy-presets.ts)
// and no schema default, so it has to be set explicitly in every config
// this app generates. Shared so training/backtesting emulates the same
// concurrency the live/paper deploy actually runs with, rather than the
// two silently drifting apart.
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
  const pairlistConfig = buildPairlistConfig(autoSelectCoins, pairWhitelist);
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

// Escapes a value for safe embedding inside a double-quoted bash string
// literal (VAR="value"). Without this, a bot name or strategy containing
// `"`, `` ` ``, or `$` could break out of the assignment and inject
// arbitrary shell commands into a script that carries the account-wide
// Hetzner API token.
function shellEscapeDouble(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/`/g, "\\`").replace(/\$/g, "\\$");
}

interface TrainingCloudInitParams {
  botName: string;
  /** Only ever used for its static fee-table lookup below — see DATA_SOURCE_EXCHANGE's doc comment for why training's actual candle data never depends on this. May be null (see Bot.exchangeName in prisma/schema.prisma). */
  exchangeName: string | null;
  strategy: string;
  strategyCode: string;
  /** Every bot runs FreqAI — drives the training window, feature set, and downloaded history range. */
  freqaiConfig: FreqAIProfileConfig;
  /** Same auto/manual pairlist choice the live deploy gets — see buildPairlistConfig. */
  autoSelectCoins: boolean;
  pairWhitelist: string[];
  /** Same budget/risk settings the live deploy gets — backtesting (which is how FreqAI training runs) still exercises custom_stake_amount, so it needs a real custom_user_settings block too. */
  totalBudget: number;
  maxStakePercentage: number;
  /** Same snowball preference as the live deploy — kept consistent so a backtest previews the same sizing logic a real deploy would use. No tradableBalanceRatio here: this VM never receives real exchange credentials (see module doc below), so there's no live balance to protect. */
  autoCompound: boolean;
  /**
   * GET endpoint (/api/train/cloud/upload-url) the VM calls right before
   * uploading to mint a fresh signed Storage URL — minted just-in-time
   * rather than baked into cloud-init, since Supabase signed upload URLs
   * have a fixed ~2h expiry and training duration is unpredictable.
   */
  uploadUrlEndpoint: string;
  /** Full URL to POST /api/train/cloud/callback on this deployment. */
  callbackUrl: string;
  /** Full URL to POST /api/train/cloud/progress on this deployment — best-effort stage checkpoints, distinct from callbackUrl's terminal COMPLETED/FAILED report. */
  progressUrl: string;
  /** One-time bearer token identifying this specific TrainingJob to the callback route. */
  callbackToken: string;
  /** Needed so the VM can delete itself when done — see failsafe notes in lib/hetzner.ts callers. */
  hetznerApiToken: string;
  /** How much historical data to download. Defaults to a multiple of the profile's own training window, so there's always enough history to actually fill it. */
  timerangeDays?: number;
  /**
   * Reachable IP/hostname of the permanent Hetzner data server (see
   * buildDataServerCloudInit below) — set only when both this and
   * dataServerSshPrivateKey are present, and only ever used for auto-select
   * bots. When present, the classic DOWNLOADING_DATA download-data loop
   * below is skipped entirely in favor of rsyncing that server's own
   * freqtrade-downloaded data directory over SSH — see
   * lib/train-cloud.ts's own doc comment for why this replaced the earlier
   * Supabase-Storage-backed cache (day-partitioned signed URLs, a chunked
   * refresh job, per-task time budgets, queue shuffling — all of it) with
   * something closer to a boring, standard freqtrade setup: one always-on
   * box running `freqtrade download-data` on a plain cron, ephemeral
   * training VMs just copying its output over the private-network-adjacent
   * link within the same Hetzner datacenter.
   */
  dataServerHost?: string;
  /**
   * Private half of the dedicated ed25519 keypair the data server's
   * `datasync` user trusts (see buildDataServerCloudInit's own doc comment
   * for the matching public half and the rrsync command restriction) —
   * read from DATA_SERVER_SSH_PRIVATE_KEY (base64-encoded, see
   * normalizeBase64Key's own doc comment for why), base64-decoded onto
   * this VM's filesystem just long enough to authenticate the rsync pull,
   * never logged. Real trading credentials are still never placed on this
   * box — this key only ever unlocks read-only access to public market data.
   */
  dataServerSshPrivateKey?: string;
  /**
   * Hard ceiling on the whole run; a `timeout`-triggered kill still fires
   * the self-destruct trap. Must stay comfortably above
   * DOWNLOAD_DATA_TIMEOUT_SECONDS alone (2h by default) plus real room for
   * PULLING_IMAGE/TRAINING/UPLOADING after it, or this outer wrapper could
   * kill an otherwise-healthy, still-progressing run.
   */
  maxRuntimeHours?: number;
}

export interface TrainingArtifacts {
  configJson: string;
  strategyCode: string;
  trainScript: string;
  /** Pass-through of params.maxRuntimeHours (with its default already applied) — the outer bootstrap cloud-init needs it for the `timeout` wrapper around train.sh, even though it plays no part in building the artifacts themselves. */
  maxRuntimeHours: number;
}

// Builds the actual content of an ephemeral training VM's setup: a
// config.json, the strategy source, and a train.sh that installs Docker,
// downloads historical data, trains a FreqAI model via `backtesting`
// (freqtrade has no standalone "train" command — training happens as a
// side effect of backtesting with FreqAI enabled), uploads the single
// resulting .joblib to a pre-signed Supabase Storage URL, reports status
// back to our API, and unconditionally deletes the VM.
//
// Deliberately returns these as plain strings rather than a ready-to-use
// cloud-init document — see uploadTrainingBootstrap
// (lib/training-bootstrap.ts) and buildTrainingBootstrapCloudInit below.
// Earlier, this function returned the full `#cloud-config` document
// directly, with all three of these embedded verbatim via cloud-init's
// write_files. That worked fine until preloadedData (see its own doc
// comment below) started carrying a signed Storage URL per cached
// day-partition: a fully-backfilled auto-select bot's train.sh alone can
// reach several MB once every partition URL for every (pair, timeframe) is
// embedded in it — comfortably over Hetzner's own 32768-byte user_data
// limit (the exact 422 "Length must be between 0 and 32768" error this
// split exists to prevent). Supabase Storage has no such limit, so the
// caller (lib/train-cloud.ts) uploads these three there instead and hands
// the training VM a short bootstrap that curls them into place after boot.
//
// Deliberately does NOT take exchange API credentials: downloading history
// and backtesting only need public market data, so the user's real trading
// keys are never placed on this box. For that same reason, the actual
// candle data always comes from DATA_SOURCE_EXCHANGE (with
// DATA_SOURCE_EXCHANGE_FALLBACK retried on failure), never params.exchangeName
// (only still used for its static fee-table lookup, and may be null anyway)
// — see DATA_SOURCE_EXCHANGE's doc comment for why.
export function buildFreqAITrainingArtifacts(params: TrainingCloudInitParams): TrainingArtifacts {
  const {
    botName,
    exchangeName,
    strategy,
    strategyCode,
    freqaiConfig,
    autoSelectCoins,
    pairWhitelist,
    totalBudget,
    maxStakePercentage,
    autoCompound,
    uploadUrlEndpoint,
    callbackUrl,
    progressUrl,
    callbackToken,
    hetznerApiToken,
    // See computeTrainingTimerangeDays's own doc comment (lib/training-timerange.ts)
    // for why this is generously over-provisioned rather than a tight fit —
    // only actually used on the classic (non-data-server) download-data path
    // below; buildDataServerCloudInit computes its own backfill window the
    // same way, maxed across every strategy preset instead of just this bot's.
    timerangeDays = computeTrainingTimerangeDays(freqaiConfig),
    dataServerHost,
    dataServerSshPrivateKey,
    // Was 4h — raised alongside DOWNLOAD_DATA_QUEUE_TIMEOUT_MINUTES's default
    // (2h) so a download that legitimately uses its full allowance still
    // has real room left over for PULLING_IMAGE/TRAINING/UPLOADING
    // afterward, rather than this outer wrapper cutting off an otherwise-
    // healthy run right as the download step finishes.
    maxRuntimeHours = 6,
  } = params;

  assertSafePythonIdentifier(strategy, "strategy");

  const safeBotName = botName.toLowerCase().replace(/[^a-z0-9-]/g, "-");
  const hasDataServer = autoSelectCoins && !!dataServerHost && !!dataServerSshPrivateKey;
  // Always the normal (dynamic VolumePairList, for auto-select) config —
  // even on the data-server path. The rsync step below overwrites this
  // in-place on the VM (via jq, once it knows exactly which pairs the data
  // server actually has) rather than this function trying to predict that
  // pairlist itself — see rsyncDataScript's own comment for why.
  const pairlistConfig: PairlistConfig = buildPairlistConfig(autoSelectCoins, pairWhitelist);

  // download-data only fetches config["pairs"], which freqtrade defaults to
  // exchange.pair_whitelist when no --pairs override is given (see
  // configuration.py's _process_datacli_options). In manual/static mode that
  // whitelist is exactly whatever pairs the user picked to TRADE — it has no
  // reason to include DEFAULT_CORR_PAIRLIST's BTC/USDT unless the user
  // happened to pick it. Every strategy preset implements
  // feature_engineering_expand_all/_basic, so FreqAI really does try to
  // build correlation features from it — without this, training would swap
  // the schema error for a "missing candle data for BTC/USDT" one instead.
  // Passed via an explicit --pairs override below so this never affects
  // pair_whitelist/pairlists itself (i.e. never makes the bot actually
  // trade BTC/USDT it wasn't configured for) — just what gets downloaded.
  // Auto-select's pair_whitelist is already the regex ".*/USDT", which
  // freqtrade expands against the exchange's real markets the same way for
  // both config-implied and --pairs-supplied entries, so BTC/USDT is
  // already included there; the union+dedup below is a no-op in that case.
  const downloadDataPairs = Array.from(new Set([...pairlistConfig.pair_whitelist, ...DEFAULT_CORR_PAIRLIST]));

  const { timerangeString: timerange } = computeTrainingTimerange(freqaiConfig, timerangeDays);

  const trainingConfig = {
    max_open_trades: DEFAULT_MAX_OPEN_TRADES,
    stake_currency: STAKE_CURRENCY,
    stake_amount: "unlimited",
    // Same fee simulation value as the live deploy — FreqAI training runs
    // via `backtesting`, whose fee-aware profit/ROI numbers should reflect
    // the exchange the bot will actually be deployed to. Purely a lookup
    // into EXCHANGE_PRESETS' static fee table, not a network call, so this
    // is the one place the bot's REAL exchangeName still belongs even
    // though the actual candle data below comes from DATA_SOURCE_EXCHANGE.
    fee: lookupExchangeFee(exchangeName),
    dry_run: true,
    dry_run_wallet: totalBudget,
    custom_user_settings: {
      total_budget: totalBudget,
      max_stake_pct: maxStakePercentage,
      auto_compound: autoCompound,
    },
    trading_mode: "spot",
    ...PRICE_DISCOVERY_CONFIG,
    exchange: {
      // Starting value only — the training script itself rewrites this
      // in-place (via jq) before each download-data attempt, cycling
      // through DATA_SOURCE_EXCHANGES if the primary source fails. Never
      // the bot's own exchangeName; see DATA_SOURCE_EXCHANGE's doc comment.
      name: DATA_SOURCE_EXCHANGE,
      key: "",
      secret: "",
      ccxt_config: {},
      ccxt_async_config: {},
      pair_whitelist: pairlistConfig.pair_whitelist,
      pair_blacklist: [],
    },
    pairlists: pairlistConfig.pairlists,
    freqaimodel: freqaiConfig.freqaiModel,
    ...(freqaiConfig.positionAdjustment?.enabled && {
      position_adjustment_enable: true,
      max_entry_position_adjustment: freqaiConfig.positionAdjustment.maxEntryPositionAdjustment,
    }),
    freqai: {
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
    },
  };
  const configJson = JSON.stringify(trainingConfig, null, 2);

  // Runs instead of the classic download-data loop below when a permanent
  // data server is configured for this (auto-select-only) bot — see
  // hasDataServer above and dataServerHost's own doc comment. Copies that
  // server's own freqtrade-downloaded data directory (kept fresh by its
  // own daily cron — see buildDataServerCloudInit) straight over SSH, then
  // rewrites this VM's own config.json in place with exactly the pairlist
  // that server actually has data for (pairlist.json, maintained by that
  // same cron run) — a StaticPairList frozen to real, present-on-disk
  // pairs, for the same reason resolveCachedTrainingData's replaced
  // Supabase-backed equivalent used to freeze one: a point-in-time
  // backtest/training run has no business asking VolumePairList to
  // re-rank by live volume and possibly land on a pair with no local data
  // file. Unlike that old design, there is no format conversion here at
  // all — this server's download-data wrote freqtrade's own default
  // format (feather), same as the classic path below, so backtesting
  // needs no extra flag either way.
  //
  // -o StrictHostKeyChecking=no is a deliberate, narrow trade-off: this
  // VM has no prior opportunity to have learned the data server's host
  // key (it's freshly booted, and the data server's IP is just a plain
  // config value, not something to bundle a pinned host key alongside),
  // and the connection only ever carries public market data one way —
  // the private key alone is what's actually being trusted here, and it
  // authenticates the CLIENT, not the server. Worth revisiting if this
  // link ever carries anything sensitive.
  const rsyncDataScript = hasDataServer
    ? `mkdir -p /root/.ssh
# DATA_SERVER_SSH_PRIVATE_KEY is a base64 encoding of the full PEM key, not
# the raw PEM text — see normalizeBase64Key's own doc comment (lib/hetzner.ts)
# for the three separate ways a raw multi-line PEM got mangled in
# production by the time it reached this point via a Vercel env var (its
# own newlines are simply not something that survives that round-trip
# reliably). Base64 has no newlines to lose, so this is a plain decode, not
# another normalization pass.
DATASERVER_SSH_KEY_B64="${shellEscapeDouble(dataServerSshPrivateKey)}"
echo "$DATASERVER_SSH_KEY_B64" | base64 -d > /root/.ssh/id_dataserver 2>>"$TRAIN_LOG" \\
  || fail "failed to base64-decode DATA_SERVER_SSH_PRIVATE_KEY — check it was set with \`base64 -w0 id_dataserver\` (Linux) or \`base64 -i id_dataserver\` (macOS), pasted as a single line with no extra wrapping"
chmod 600 /root/.ssh/id_dataserver

# Fails fast with a clear, actionable message instead of the generic rsync
# "Permission denied" this decode step exists to get past — ssh-keygen -y is
# the same PEM parser OpenSSH itself uses, so this is a real pass/fail
# signal, not a guess. Only the file's own structural shape is logged
# (line/byte counts, and the BEGIN/END marker lines, which are identical
# boilerplate for every OpenSSH key and reveal nothing about this one) —
# never the key material itself.
echo "=== data-server SSH key: $(wc -l < /root/.ssh/id_dataserver) lines, $(wc -c < /root/.ssh/id_dataserver) bytes ===" | tee -a "$TRAIN_LOG"
echo "=== first line: $(head -n 1 /root/.ssh/id_dataserver) ===" | tee -a "$TRAIN_LOG"
echo "=== last line: $(tail -n 1 /root/.ssh/id_dataserver) ===" | tee -a "$TRAIN_LOG"
ssh-keygen -y -f /root/.ssh/id_dataserver -P '' > /dev/null 2>>"$TRAIN_LOG" \\
  || fail "DATA_SERVER_SSH_PRIVATE_KEY decoded but still doesn't parse as a valid SSH private key — the base64 value in Vercel may be truncated, corrupted, or encoding the wrong file"
echo "=== data-server SSH key parses OK ===" | tee -a "$TRAIN_LOG"

RSYNC_SSH='ssh -i /root/.ssh/id_dataserver -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ConnectTimeout=15 -o BatchMode=yes'

mkdir -p "user_data/data/${shellEscapeDouble(DATA_SOURCE_EXCHANGE)}"
echo "=== rsyncing market data from data server ${shellEscapeDouble(dataServerHost!)} ===" | tee -a "$TRAIN_LOG"
rsync -az -e "$RSYNC_SSH" \\
  "${DATA_SERVER_SSH_USER}@${shellEscapeDouble(dataServerHost!)}:user_data/data/${shellEscapeDouble(DATA_SOURCE_EXCHANGE)}/" \\
  "user_data/data/${shellEscapeDouble(DATA_SOURCE_EXCHANGE)}/" \\
  2>&1 | tee -a "$TRAIN_LOG" || fail "rsync of market data from data server failed"

rsync -az -e "$RSYNC_SSH" \\
  "${DATA_SERVER_SSH_USER}@${shellEscapeDouble(dataServerHost!)}:pairlist.json" \\
  "/tmp/pairlist.json" \\
  2>&1 | tee -a "$TRAIN_LOG" || fail "rsync of pairlist.json from data server failed"

[ -s /tmp/pairlist.json ] || fail "pairlist.json from data server is empty"
jq -e 'type == "array" and length > 0' /tmp/pairlist.json >/dev/null 2>&1 || fail "pairlist.json from data server is not a non-empty JSON array"

jq --slurpfile pairs /tmp/pairlist.json \\
  '.exchange.pair_whitelist = $pairs[0] | .pairlists = [{"method":"StaticPairList"}]' \\
  user_data/config.json > user_data/config.json.tmp \\
  && mv user_data/config.json.tmp user_data/config.json \\
  || fail "failed to freeze pairlist from data server into config.json"
echo "=== market data + pairlist synced from data server ===" | tee -a "$TRAIN_LOG"`
    : "";

  // Every value that came from user-editable bot fields is escaped before
  // being embedded in a bash double-quoted assignment (see shellEscapeDouble
  // doc comment above); everything downstream references these as "$VAR",
  // never interpolated inline into a command. strategyCode itself is NOT
  // embedded in this shell script at all — it goes through write_files
  // below, which is inert plain-text, so it needs no shell escaping.
  const trainScript = `#!/bin/bash
set -uo pipefail

CALLBACK_URL="${shellEscapeDouble(callbackUrl)}"
PROGRESS_URL="${shellEscapeDouble(progressUrl)}"
UPLOAD_URL_ENDPOINT="${shellEscapeDouble(uploadUrlEndpoint)}"
CALLBACK_TOKEN="${shellEscapeDouble(callbackToken)}"
HETZNER_API_TOKEN="${shellEscapeDouble(hetznerApiToken)}"
STRATEGY="${shellEscapeDouble(strategy)}"
FREQAI_MODEL="${shellEscapeDouble(freqaiConfig.freqaiModel)}"
TIMERANGE="${shellEscapeDouble(timerange)}"

REPORTED=0
FAIL_REASON=""
# Every docker/freqtrade command's own stdout+stderr goes here (see the
# "2>&1 | tee -a" on each one below) so fail() can attach the actual
# output — the specific reason "FreqAI training (via backtesting) failed"
# alone never explains (OOM, a bad strategy, a config error, ...) — to
# whatever it reports. Without this, self_destruct's fallback report was
# the ONLY thing ever reaching us: a bare "exited unexpectedly (exit code
# 1)" no matter which command actually failed or why.
TRAIN_LOG="/var/log/freqtrade-train.log"
: > "$TRAIN_LOG"

report_status() {
  local status="$1"
  local error_msg="\${2:-}"
  local payload
  payload=$(jq -n --arg status "$status" --arg err "$error_msg" \\
    '{status: $status, errorMessage: (if $err == "" then null else $err end)}')
  curl -fsS -m 30 -X POST "$CALLBACK_URL" \\
    -H "Authorization: Bearer $CALLBACK_TOKEN" \\
    -H "Content-Type: application/json" \\
    -d "$payload" || true
  REPORTED=1
}

# Best-effort real checkpoints — never allowed to fail or block the actual
# training run (hence "|| true" and no fail() on a bad response), since a
# missed progress ping is just a slightly stale progress bar, not a reason
# to abort a multi-hour training job. See GET /api/train/cloud/status for
# how these get turned into a percentage/ETA.
report_stage() {
  local stage="$1"
  local payload
  payload=$(jq -n --arg stage "$stage" '{stage: $stage}')
  curl -fsS -m 15 -X POST "$PROGRESS_URL" \\
    -H "Authorization: Bearer $CALLBACK_TOKEN" \\
    -H "Content-Type: application/json" \\
    -d "$payload" || true
}

# Fires on ANY script exit — success, a failed command, or a signal from the
# timeout wrapper below. This is the ONLY place that deletes the server,
# so self-destruct is guaranteed exactly once regardless of how the script
# ends. Layer 1 of 3 in the cost-safety design (see /api/train/cloud/callback
# and /api/train/cloud/reap for layers 2 and 3).
self_destruct() {
  local exit_code=$?
  if [ "$REPORTED" -eq 0 ]; then
    # FAIL_REASON (set by fail() below) carries both which command failed
    # AND the tail of its actual output — a bare exit code alone never
    # explained anything real (OOM, a bad strategy, a data/config error).
    # Only falls back to the generic message for a crash that never went
    # through fail() at all (an unset-variable error under "set -u", a
    # signal from the timeout wrapper, ...).
    local reason="\${FAIL_REASON:-Training script exited unexpectedly (exit code $exit_code)}"
    report_status "FAILED" "$reason"
  fi
  local server_id
  server_id=$(curl -fsS -m 10 -H "Metadata: true" http://169.254.169.254/hetzner/v1/metadata/instance-id || echo "")
  if [ -n "$server_id" ]; then
    curl -fsS -m 30 -X DELETE "https://api.hetzner.cloud/v1/servers/$server_id" \\
      -H "Authorization: Bearer $HETZNER_API_TOKEN" || true
  fi
}
trap self_destruct EXIT

fail() {
  local msg="$1"
  echo "TRAINING FAILED: $msg" >&2
  local log_tail
  log_tail=$(tail -c 1500 "$TRAIN_LOG" 2>/dev/null || echo "")
  if [ -n "$log_tail" ]; then
    FAIL_REASON="$msg | last output: $log_tail"
  else
    FAIL_REASON="$msg"
  fi
  exit 1
}

mkdir -p /opt/freqtrade/user_data/models
cd /opt/freqtrade || fail "could not cd into /opt/freqtrade"

report_stage "PULLING_IMAGE"
docker pull ${FREQTRADE_DOCKER_IMAGE} 2>&1 | tee -a "$TRAIN_LOG" || fail "could not pull freqtrade image"

report_stage "DOWNLOADING_DATA"
${
  hasDataServer
    ? rsyncDataScript
    : `# --timeframes (plural) is the only flag download-data actually accepts —
# ARGS_DOWNLOAD_DATA in freqtrade's own commands/arguments.py has no
# "timeframe" (singular) entry at all, unlike backtesting below. Passing
# every entry in include_timeframes (not just the base one) here also
# closes a separate gap: FreqAI's feature_engineering_expand_*() pulls
# candles for every include_timeframes entry, which were never downloaded
# for anything past the first one before this.
#
# Tries each of DATA_SOURCE_EXCHANGES in order — config.json's exchange.name
# is rewritten via jq before every attempt, never pair_whitelist/pairlists,
# so this can never make the bot actually trade on whichever source it
# happened to download candles from. Each attempt is capped at its own
# share of DOWNLOAD_DATA_TIMEOUT_SECONDS (see DOWNLOAD_DATA_ATTEMPT_TIMEOUT_SECONDS
# above) rather than the full budget each, so falling back after the
# primary source fails still fits the same overall window the reap cron
# expects instead of potentially doubling the total wait. download-data has
# no per-pair timeout of its own, and downloading a VolumePairList-driven
# ".*/USDT" wildcard — freqtrade's own documented way to support a dynamic
# pairlist in backtesting — really can mean every active USDT pair on the
# exchange, not just the top N a live/dry-run instance would ever actually
# pick. Every attempt (which source, whether it succeeded) is logged
# explicitly so a future failure shows exactly which data source(s) were
# tried, not just a generic "failed".
DOWNLOAD_OK=0
for data_source in ${DATA_SOURCE_EXCHANGES.map((ds) => `"${shellEscapeDouble(ds)}"`).join(" ")}; do
  echo "=== download-data: trying data source '$data_source' (timeout ${DOWNLOAD_DATA_ATTEMPT_TIMEOUT_SECONDS}s) ===" | tee -a "$TRAIN_LOG"
  jq --arg name "$data_source" '.exchange.name = $name' user_data/config.json > user_data/config.json.tmp \\
    && mv user_data/config.json.tmp user_data/config.json
  if timeout ${DOWNLOAD_DATA_ATTEMPT_TIMEOUT_SECONDS} docker run --rm -v /opt/freqtrade/user_data:/freqtrade/user_data ${FREQTRADE_DOCKER_IMAGE} \\
    download-data --config user_data/config.json --timerange "$TIMERANGE" \\
    --timeframes ${freqaiConfig.features.includeTimeframes.map((tf) => `"${shellEscapeDouble(tf)}"`).join(" ")} \\
    --pairs ${downloadDataPairs.map((p) => `"${shellEscapeDouble(p)}"`).join(" ")} \\
    2>&1 | tee -a "$TRAIN_LOG"; then
    echo "=== download-data succeeded via '$data_source' ===" | tee -a "$TRAIN_LOG"
    DOWNLOAD_OK=1
    break
  else
    echo "=== download-data failed via '$data_source' ===" | tee -a "$TRAIN_LOG"
  fi
done
[ "$DOWNLOAD_OK" -eq 1 ] || fail "historical data download failed against every data source (tried: ${DATA_SOURCE_EXCHANGES.join(", ")}) — see last output above for the last pairs reached"`
}

report_stage "TRAINING"
docker run --rm -v /opt/freqtrade/user_data:/freqtrade/user_data ${FREQTRADE_DOCKER_IMAGE} \\
  backtesting --config user_data/config.json --strategy "$STRATEGY" \\
  --freqaimodel "$FREQAI_MODEL" --timerange "$TIMERANGE" \\
  2>&1 | tee -a "$TRAIN_LOG" || fail "FreqAI training (via backtesting) failed"

MODEL_COUNT=$(find user_data/models -name '*.joblib' 2>/dev/null | wc -l)
if [ "$MODEL_COUNT" -ne 1 ]; then
  fail "expected exactly 1 .joblib model file, found $MODEL_COUNT"
fi
MODEL_FILE=$(find user_data/models -name '*.joblib')

report_stage "UPLOADING"
# Minted just before uploading rather than baked into cloud-init, so a long
# training run can never race a signed URL's fixed expiry window.
UPLOAD_URL=$(curl -fsS -m 30 "$UPLOAD_URL_ENDPOINT" \\
  -H "Authorization: Bearer $CALLBACK_TOKEN" | jq -r '.uploadUrl')
[ -n "$UPLOAD_URL" ] && [ "$UPLOAD_URL" != "null" ] || fail "could not obtain a signed upload URL"

curl -fsS -m 1800 -X PUT "$UPLOAD_URL" \\
  -H "Content-Type: application/octet-stream" \\
  --data-binary "@$MODEL_FILE" \\
  || fail "model upload to storage failed"

report_stage "DONE"
report_status "COMPLETED"
exit 0
`;

  return { configJson, strategyCode, trainScript, maxRuntimeHours };
}

interface TrainingBootstrapCloudInitParams {
  strategy: string;
  progressUrl: string;
  callbackToken: string;
  maxRuntimeHours: number;
  /** Signed Storage URLs from uploadTrainingBootstrap (lib/training-bootstrap.ts) — see that module's own doc comment for why these three artifacts live in Storage instead of inline write_files. */
  configUrl: string;
  strategyUrl: string;
  trainScriptUrl: string;
}

// The actual document handed to Hetzner's server-create API — deliberately
// tiny (well under the 32768-byte user_data limit regardless of how big a
// fully-cached auto-select bot's train.sh ends up being in Storage) since
// all it does is report the BOOTED checkpoint, install the same packages
// train.sh itself needs (docker.io so it can run; curl/jq so it can fetch
// its own preloaded-data partitions), then curl the three real artifacts
// into place and hand off to train.sh, which is where every other safety
// mechanism (self-destruct, status reporting, the outer timeout wrapper)
// already lived before this split and still does, entirely unchanged.
//
// A fetch failure here (an expired signed URL, a network blip right after
// boot) falls into the same failure category cloud-init itself already
// has — e.g. the docker.io package install failing — and gets caught the
// same existing way: no PULLING_IMAGE checkpoint ever follows BOOTED, which
// GET /api/train/cloud/reap already treats as a stuck job worth cleaning up
// (see that route's own doc comment). --retry gives each fetch a few
// chances before giving up rather than failing on the first transient
// error, which is the only accommodation this step needs.
export function buildTrainingBootstrapCloudInit(params: TrainingBootstrapCloudInitParams): string {
  const { strategy, progressUrl, callbackToken, maxRuntimeHours, configUrl, strategyUrl, trainScriptUrl } = params;

  // Runs in cloud-init's "init" stage, before package_update/packages and
  // before runcmd — the earliest point anything on this VM can phone home.
  // Investigated after two separate incidents where a job sat at stage
  // QUEUED (i.e. before even PULLING_IMAGE, the *next* checkpoint, which
  // only fires after packages are installed and train.sh has been fetched)
  // for its entire lifetime with zero information on whether the VM ever
  // booted at all. Best-effort like every other report_* call — `|| true`
  // so a failed curl here can never affect boot.
  const bootCheckpointCmd = `curl -fsS -m 15 -X POST "${shellEscapeDouble(progressUrl)}" -H "Authorization: Bearer ${shellEscapeDouble(callbackToken)}" -H "Content-Type: application/json" -d '{"stage":"BOOTED"}' || true`;

  const fetchFlags = "-fsS -m 30 --retry 3 --retry-delay 2";

  return `#cloud-config
bootcmd:
  - |
    ${bootCheckpointCmd}

package_update: true
packages:
  - docker.io
  - curl
  - jq

runcmd:
  - mkdir -p /opt/freqtrade/user_data/strategies
  - curl ${fetchFlags} -o /opt/freqtrade/user_data/config.json "${shellEscapeDouble(configUrl)}"
  - curl ${fetchFlags} -o /opt/freqtrade/user_data/strategies/${strategy}.py "${shellEscapeDouble(strategyUrl)}"
  - curl ${fetchFlags} -o /opt/train.sh "${shellEscapeDouble(trainScriptUrl)}"
  - chmod 0700 /opt/train.sh
  - systemctl enable docker
  - systemctl start docker
  - timeout --signal=TERM --kill-after=30s ${maxRuntimeHours}h /opt/train.sh
`;
}
