/**
 * Owner-minted publish tokens (#2373). A publish token is an ordinary `relk_`
 * row in `api_tokens` with `principal_type = 'user'`, `principal_id = <userId>`,
 * `scopes = ["publish"]`, and `source_id` set. It may only POST that one
 * source's `releases/batch` route, and only while its owner still holds a
 * verified ownership claim on the source's org.
 */
import { and, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { apiTokens, orgClaims, organizations, sources } from "@buildinternet/releases-core/schema";
import {
  PUBLISH_SCOPE,
  generateApiToken,
  hashSecret,
} from "@buildinternet/releases-core/api-token";
import { newApiTokenId } from "@buildinternet/releases-core/id";
import type { PublishToken } from "@buildinternet/releases-api-types";
import type { D1Db } from "../db.js";

/** Active (non-revoked) publish tokens one user may hold per source. */
export const MAX_PUBLISH_TOKENS_PER_SOURCE = 5;

export type PublishBindingFailure =
  | "source_missing"
  | "source_deleted"
  | "org_deleted"
  | "claim_missing";

export type PublishBindingCheck =
  | { ok: true; sourceId: string; orgId: string }
  | { ok: false; reason: PublishBindingFailure };

/**
 * Does `userId` currently hold the right to publish to `sourceId`? True only
 * when the source exists and is not soft-deleted, its org is not soft-deleted,
 * and the user holds a `verified` claim on that org. A verified claim has no
 * clock-based expiry (its `expires_at` is the pending-proof deadline only), so
 * "lapsed" means the row is gone or no longer `verified`.
 */
export async function checkPublishBinding(
  db: D1Db,
  sourceId: string,
  userId: string,
): Promise<PublishBindingCheck> {
  const row = await db
    .select({
      id: sources.id,
      orgId: sources.orgId,
      sourceDeletedAt: sources.deletedAt,
      orgDeletedAt: organizations.deletedAt,
      claimId: sql<string | null>`(
        SELECT ${orgClaims.id} FROM ${orgClaims}
        WHERE ${orgClaims.orgId} = ${sources.orgId}
          AND ${orgClaims.userId} = ${userId}
          AND ${orgClaims.status} = 'verified'
        LIMIT 1
      )`,
    })
    .from(sources)
    .leftJoin(organizations, eq(organizations.id, sources.orgId))
    .where(eq(sources.id, sourceId))
    .get();
  if (!row) return { ok: false, reason: "source_missing" };
  if (row.sourceDeletedAt) return { ok: false, reason: "source_deleted" };
  // A missing org row (left join miss) is treated like a deleted one.
  if (row.orgDeletedAt || row.orgId == null) return { ok: false, reason: "org_deleted" };
  if (!row.claimId) return { ok: false, reason: "claim_missing" };
  return { ok: true, sourceId: row.id, orgId: row.orgId };
}

function activePublishCount(userId: string, sourceId: string) {
  return sql`(
    SELECT COUNT(*) FROM api_tokens
    WHERE principal_type = 'user'
      AND principal_id = ${userId}
      AND source_id = ${sourceId}
      AND revoked_at IS NULL
      AND active = 1
  )`;
}

export type MintPublishTokenResult =
  | {
      ok: true;
      token: string;
      id: string;
      sourceId: string;
      name: string;
      createdAt: string;
    }
  | { ok: false; reason: "limit" | "claim_missing" };

/**
 * Mint a publish token in ONE capped statement: the INSERT only lands when the
 * user holds fewer than {@link MAX_PUBLISH_TOKENS_PER_SOURCE} active tokens for
 * the source AND still holds a verified claim on `orgId`, so two concurrent
 * mints can't overshoot the cap and a claim revoked mid-request can't mint.
 * The plaintext token is returned once; only its hash is stored.
 */
export async function mintPublishTokenCapped(
  db: D1Db,
  input: { userId: string; sourceId: string; orgId: string; name: string },
): Promise<MintPublishTokenResult> {
  const { token, lookupId, secret } = generateApiToken();
  const tokenHash = await hashSecret(secret);
  const id = newApiTokenId();
  const createdAt = new Date().toISOString();
  const scopes = JSON.stringify([PUBLISH_SCOPE]);
  const inserted = await db.all<{ id: string }>(sql`
    INSERT INTO api_tokens
      (id, lookup_id, token_hash, name, scopes, principal_type, principal_id,
       active, created_at, created_by, source_id)
    SELECT ${id}, ${lookupId}, ${tokenHash}, ${input.name}, ${scopes}, 'user', ${input.userId},
      1, ${createdAt}, ${input.userId}, ${input.sourceId}
    WHERE ${activePublishCount(input.userId, input.sourceId)} < ${MAX_PUBLISH_TOKENS_PER_SOURCE}
      AND EXISTS (
        SELECT 1 FROM org_claims
        WHERE org_id = ${input.orgId} AND user_id = ${input.userId} AND status = 'verified'
      )
    RETURNING id
  `);
  if (inserted.length > 0) {
    return { ok: true, token, id, sourceId: input.sourceId, name: input.name, createdAt };
  }
  // Nothing inserted: disambiguate the cap from a claim that lapsed between
  // the handler's pre-check and this statement.
  const [countRow] = await db.all<{ n: number }>(
    sql`SELECT ${activePublishCount(input.userId, input.sourceId)} AS n`,
  );
  return {
    ok: false,
    reason: Number(countRow?.n ?? 0) >= MAX_PUBLISH_TOKENS_PER_SOURCE ? "limit" : "claim_missing",
  };
}

const ownedPublishToken = (userId: string) =>
  and(
    eq(apiTokens.principalType, "user"),
    eq(apiTokens.principalId, userId),
    isNotNull(apiTokens.sourceId),
  );

/** The caller's publish tokens (active and revoked), newest first. No secrets. */
export async function listPublishTokens(db: D1Db, userId: string): Promise<PublishToken[]> {
  const rows = await db
    .select({
      id: apiTokens.id,
      name: apiTokens.name,
      sourceId: apiTokens.sourceId,
      sourceSlug: sources.slug,
      orgSlug: organizations.slug,
      createdAt: apiTokens.createdAt,
      lastUsedAt: apiTokens.lastUsedAt,
      revokedAt: apiTokens.revokedAt,
    })
    .from(apiTokens)
    .leftJoin(sources, eq(sources.id, apiTokens.sourceId))
    .leftJoin(organizations, eq(organizations.id, sources.orgId))
    .where(ownedPublishToken(userId))
    .orderBy(desc(apiTokens.createdAt))
    .all();
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    sourceId: r.sourceId ?? "",
    sourceSlug: r.sourceSlug ?? null,
    orgSlug: r.orgSlug ?? null,
    createdAt: r.createdAt,
    lastUsedAt: r.lastUsedAt ?? null,
    revokedAt: r.revokedAt ?? null,
  }));
}

/**
 * Revoke one of the caller's publish tokens. Returns null when the id isn't a
 * publish token the caller owns (the route answers 404 — no existence oracle).
 * Idempotent: revoking an already-revoked token keeps its original timestamp.
 */
export async function revokePublishToken(
  db: D1Db,
  userId: string,
  id: string,
): Promise<{ id: string; sourceId: string; revokedAt: string; alreadyRevoked: boolean } | null> {
  const existing = await db
    .select({ id: apiTokens.id, sourceId: apiTokens.sourceId, revokedAt: apiTokens.revokedAt })
    .from(apiTokens)
    .where(and(eq(apiTokens.id, id), ownedPublishToken(userId)))
    .get();
  if (!existing || !existing.sourceId) return null;
  if (existing.revokedAt) {
    return {
      id: existing.id,
      sourceId: existing.sourceId,
      revokedAt: existing.revokedAt,
      alreadyRevoked: true,
    };
  }
  const revokedAt = new Date().toISOString();
  await db
    .update(apiTokens)
    .set({ active: false, revokedAt })
    .where(and(eq(apiTokens.id, id), ownedPublishToken(userId), isNull(apiTokens.revokedAt)));
  return { id: existing.id, sourceId: existing.sourceId, revokedAt, alreadyRevoked: false };
}
