/**
 * Per-source MA-delegation lock helpers (#1780 Box 1 / #1814).
 *
 * These replace the KV `ma:active:src:{sourceId}` mutex (formerly read/written
 * against `LATEST_CACHE`) with the api worker's `SourceActor` DO, reached via the
 * cross-script `SOURCE_ACTOR` binding. The lock lifecycle is unchanged — check
 * before minting a session, acquire immediately after the session id is minted,
 * conditionally release in the session's completion `finally` — only the storage
 * moved from KV to the owning DO, where the check→delete release is atomic.
 *
 * Fail-open by design: the lock is a dedup/cost guard, not a data-integrity gate
 * (ingest dedups on `UNIQUE(source_id, url)` regardless). A transient DO error or
 * an absent binding therefore treats the source as unlocked rather than blocking
 * — at worst one duplicate session (bounded by the daily spend cap), never a
 * pipeline-wide halt. Failures are logged loudly so a silently-disabled lock is
 * visible in Axiom.
 */

import { logEvent } from "@releases/lib/log-event";
import type { Env, SourceActorLockStub } from "./types.js";

function lockStub(env: Env, sourceId: string): SourceActorLockStub | null {
  const ns = env.SOURCE_ACTOR;
  if (!ns) return null;
  return ns.get(ns.idFromName(sourceId)) as unknown as SourceActorLockStub;
}

/**
 * Return the sources that already hold a live MA-session lease (empty when all
 * are free). Callers reject the whole delegation when this is non-empty, matching
 * the old KV all-or-nothing check.
 */
export async function checkSourceLocks(
  env: Env,
  sourceIds: readonly string[],
): Promise<Array<{ id: string; sessionId: string }>> {
  if (!env.SOURCE_ACTOR) return [];
  const results = await Promise.all(
    sourceIds.map(async (id) => {
      try {
        const held = await lockStub(env, id)!.checkScrapeLock(id);
        return held ? { id, sessionId: held.sessionId } : null;
      } catch (err) {
        logEvent("error", {
          component: "discovery",
          event: "source-lock-check-failed",
          sourceId: id,
          err: err instanceof Error ? err.message : String(err),
        });
        return null; // fail-open: treat as unlocked
      }
    }),
  );
  return results.filter((x): x is { id: string; sessionId: string } => x !== null);
}

/** Acquire the lease for every id under `sessionId` (best-effort per source). */
export async function acquireSourceLocks(
  env: Env,
  sourceIds: readonly string[],
  sessionId: string,
): Promise<void> {
  if (!env.SOURCE_ACTOR) return;
  await Promise.all(
    sourceIds.map(async (id) => {
      try {
        await lockStub(env, id)!.acquireScrapeLock(id, sessionId);
      } catch (err) {
        logEvent("warn", {
          component: "discovery",
          event: "source-lock-acquire-failed",
          sourceId: id,
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}

/**
 * Conditionally release the lease for every id — a no-op for any source whose
 * lease has already been re-claimed by a newer session (the DO enforces the
 * owner check atomically). Best-effort; the 15-min lease is the backstop.
 */
export async function releaseSourceLocks(
  env: Env,
  sourceIds: readonly string[],
  sessionId: string,
): Promise<void> {
  if (!env.SOURCE_ACTOR) return;
  await Promise.all(
    sourceIds.map(async (id) => {
      try {
        await lockStub(env, id)!.releaseScrapeLock(id, sessionId);
      } catch (err) {
        logEvent("warn", {
          component: "discovery",
          event: "source-lock-release-failed",
          sourceId: id,
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
