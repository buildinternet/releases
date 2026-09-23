/**
 * Fetch-completion source write, extracted so a future D1 persister can call
 * it in-process (#1946 phase 4, task 5).
 *
 * This is the narrow write `updateSourceAfterFetch` performs today via a
 * PATCH: counter resets + the same fire-and-forget playbook regen that
 * `patchSourceHandler` triggers on every source PATCH (`routes/sources.ts`,
 * `regeneratePlaybook`). It is NOT a general PATCH — the route's other
 * branches (re-parenting/tier-change actor notify, vectorize re-embed, …) key
 * on fields this write never touches, so they are intentionally absent here.
 * The PATCH route itself is not refactored to call this — its body is
 * dominated by validation/guards irrelevant to this caller.
 */
import { eq } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../db.js";
import { regeneratePlaybook } from "../playbook-regen.js";

export interface CompleteSourceFetchOptions {
  /** When provided, the playbook regen is handed off instead of awaited inline (e.g. `ExecutionContext#waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/**
 * Reset a source's fetch-completion counters (`lastFetchedAt`,
 * `changeDetectedAt`, `consecutiveErrors`, `consecutiveNoChange`,
 * `nextFetchAfter`) and regenerate its org's playbook, mirroring what a PATCH
 * with this field set does today. Playbook regen is skipped for orgless
 * sources, matching the PATCH route's `if (src.orgId)` guard.
 */
export async function completeSourceFetch(
  db: D1Db,
  src: { id: string; orgId: string | null },
  opts?: CompleteSourceFetchOptions,
): Promise<void> {
  await db
    .update(sources)
    .set({
      lastFetchedAt: new Date().toISOString(),
      changeDetectedAt: null,
      consecutiveErrors: 0,
      consecutiveNoChange: 0,
      nextFetchAfter: null,
    })
    .where(eq(sources.id, src.id));

  if (src.orgId) {
    const regen = regeneratePlaybook(db, src.orgId).catch(() => {});
    if (opts?.waitUntil) {
      opts.waitUntil(regen);
    } else {
      await regen;
    }
  }
}
