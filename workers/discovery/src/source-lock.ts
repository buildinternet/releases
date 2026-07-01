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
 * Warn once per isolate when the cross-script binding is missing. In prod/staging
 * it is always bound, so an absent binding is a real misconfig worth surfacing —
 * but only once, so a hot path can't flood the logs (the module-level flag resets
 * per isolate, which is the natural rate limit here).
 */
let warnedMissingBinding = false;
function warnMissingBinding(op: string): void {
  if (warnedMissingBinding) return;
  warnedMissingBinding = true;
  logEvent("warn", {
    component: "discovery",
    event: "source-lock-binding-missing",
    op,
    detail: "SOURCE_ACTOR unbound — per-source MA dedup lock disabled (failing open)",
  });
}

/**
 * Atomically claim the per-source lease for every id under `sessionId`. Returns
 * the sources that were already locked (empty ⇒ all acquired, delegation may
 * proceed). On a partial acquire — some free, some contended — the leases we did
 * take are released before returning, so a rejected batch leaves nothing held.
 *
 * Callers must acquire BEFORE minting a session and reject when the result is
 * non-empty, so a losing race never starts a duplicate session. Fail-open: a
 * throwing or absent actor treats the source as free (acquired) — the lock is a
 * dedup/cost guard, not a data-integrity gate (ingest dedups on
 * `UNIQUE(source_id, url)`); one duplicate session (bounded by the daily spend
 * cap) beats halting all ingestion on a transient DO error.
 */
export async function tryAcquireSourceLocks(
  env: Env,
  sourceIds: readonly string[],
  sessionId: string,
): Promise<Array<{ id: string; sessionId: string }>> {
  if (!env.SOURCE_ACTOR) {
    warnMissingBinding("acquire");
    return [];
  }
  const acquired: string[] = [];
  const conflicts: Array<{ id: string; sessionId: string }> = [];
  await Promise.all(
    sourceIds.map(async (id) => {
      try {
        const res = await lockStub(env, id)!.tryAcquireScrapeLock(id, sessionId);
        if (res.acquired) acquired.push(id);
        else conflicts.push({ id, sessionId: res.sessionId });
      } catch (err) {
        logEvent("error", {
          component: "discovery",
          event: "source-lock-acquire-failed",
          sourceId: id,
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
        acquired.push(id); // fail-open: treat as acquired
      }
    }),
  );
  if (conflicts.length > 0) {
    // Roll back the leases we took so a rejected batch holds nothing.
    await releaseSourceLocks(env, acquired, sessionId);
    return conflicts;
  }
  return [];
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
  if (!env.SOURCE_ACTOR) {
    warnMissingBinding("release");
    return;
  }
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
