import crypto from "crypto";

// Generic hashed-bearer-token helpers for a server-to-server caller that
// has no Supabase user session — a deployed bot's own freqtrade instance
// (POST /api/bots/[id]/status) identifies itself this way. Only the sha256
// hash is ever persisted; the raw token exists only in memory here and
// inside that bot's cloud-init user-data (see lib/hetzner.ts).

export function generateCallbackToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

export function hashCallbackToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export function extractBearerToken(authHeader: string | null): string | null {
  if (!authHeader) return null;
  const match = authHeader.match(/^Bearer (.+)$/);
  return match ? match[1] : null;
}

// For the few call sites that look a record up by id first and must then
// compare a presented token's hash against one specific stored hash (rather
// than doing a hash-keyed DB lookup) — a manual `===` on hex strings would
// short-circuit at the first differing character.
export function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "hex");
  const bufB = Buffer.from(b, "hex");
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}
