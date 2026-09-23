import { sql } from "drizzle-orm";
import { domainDemand } from "@buildinternet/releases-core/schema";
import type { AnyDb } from "../../db.js";

/**
 * Record a demand signal for an unresolved domain lookup (#1947). One row per
 * domain; `hit_count` accumulates and `last_seen_at` advances on repeat misses.
 * `domain` MUST already be normalized + validated by the caller (the by-domain
 * route runs `normalizeDomain` and rejects invalid hosts before the miss branch).
 * Upsert is a single ON CONFLICT — `domain` is the primary key.
 */
export async function recordDomainDemand(db: AnyDb, domain: string): Promise<void> {
  const now = Date.now();
  await db
    .insert(domainDemand)
    .values({ domain, firstSeenAt: now, lastSeenAt: now, hitCount: 1 })
    .onConflictDoUpdate({
      target: domainDemand.domain,
      set: {
        hitCount: sql`${domainDemand.hitCount} + 1`,
        lastSeenAt: now,
      },
    });
}
