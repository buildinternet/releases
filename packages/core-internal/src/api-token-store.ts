/**
 * Worker-shared verification for opaque `relk_…` API tokens. Lives in
 * core-internal (not pure `core`) because it reads D1 via drizzle. Consumed by
 * the API worker (via token-store.ts re-export) and the MCP worker directly, so
 * both share one verification path.
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { apiTokens } from "@buildinternet/releases-core/schema";
import {
  constantTimeEqual,
  DUMMY_TOKEN_HASH,
  hashSecret,
  parseApiToken,
  parseStoredScopes,
} from "@buildinternet/releases-core/api-token";

/** Loose drizzle handle — D1 in workers, bun:sqlite in tests. */
type AnyDb = DrizzleD1Database<any>;

export type TokenVerifyResult = { ok: true; tokenId: string; scopes: string[] } | { ok: false };

/** How long after a successful auth before we rewrite last_used_at again. */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Validate a presented `relk_…` token against the DB. Runs a constant-time hash
 * comparison on every path (including not-found / malformed) so timing and the
 * returned shape are uniform — no enumeration oracle. Returns scopes on success.
 */
export async function verifyApiToken(
  db: AnyDb,
  raw: string,
  now: Date = new Date(),
): Promise<TokenVerifyResult> {
  const parsed = parseApiToken(raw);
  // Always hash so timing doesn't branch on parse success.
  const presentedHash = await hashSecret(parsed?.secret ?? "");

  if (!parsed) {
    constantTimeEqual(presentedHash, DUMMY_TOKEN_HASH);
    return { ok: false };
  }

  const row = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.lookupId, parsed.lookupId))
    .get();

  if (!row) {
    constantTimeEqual(presentedHash, DUMMY_TOKEN_HASH);
    return { ok: false };
  }

  if (!constantTimeEqual(presentedHash, row.tokenHash)) return { ok: false };
  if (!row.active) return { ok: false };
  // Revoked tokens never validate — independent of `active` so a future code
  // path that records a revocation without flipping `active` can't be bypassed.
  if (row.revokedAt) return { ok: false };
  if (row.expiresAt && row.expiresAt <= now.toISOString()) return { ok: false };

  // A minted token always carries at least one scope (mint/PATCH enforce it),
  // so empty/unparseable scopes signal a corrupted row — deny rather than admit
  // a powerless-but-authenticated identity (which would still bypass rate limits).
  const scopes = parseStoredScopes(row.scopes);
  if (scopes.length === 0) return { ok: false };
  return { ok: true, tokenId: row.id, scopes };
}

/**
 * Record last-used, throttled: only rewrites if the previous value is null or
 * older than the throttle window. Single conditional UPDATE — safe to call
 * fire-and-forget via waitUntil on the hot path.
 */
export async function touchLastUsed(
  db: AnyDb,
  tokenId: string,
  now: Date = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - LAST_USED_THROTTLE_MS).toISOString();
  await db
    .update(apiTokens)
    .set({ lastUsedAt: now.toISOString() })
    .where(
      and(
        eq(apiTokens.id, tokenId),
        or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, cutoff)),
      ),
    );
}
