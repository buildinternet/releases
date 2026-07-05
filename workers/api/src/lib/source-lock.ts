/**
 * Per-source scrape-lock helpers (#1780 Box 1 / #1814), relocated from
 * `workers/discovery/src/source-lock.ts` with the deterministic-update
 * dispatch (#1946). Semantics unchanged: the lock lives on the source's own
 * `SourceActor` DO, where the check→claim and check→delete are atomic.
 *
 * Binding absent: fail-open (lock disabled, warn once). SourceActor RPC errors
 * during acquire: fail-closed — surfaces a conflict so dispatch is blocked
 * rather than starting an update run without a lease. Ingest dedups on URL
 * regardless; the lock is a dedup/cost guard, not a data-integrity gate.
 */

import { logEvent } from "@releases/lib/log-event";

/**
 * Structural stub for the two lock RPCs. The SourceActor class lives in this
 * worker, but typing the namespace against the class would drag the DO's full
 * import graph into every dispatch call site; the runtime enforces the real
 * contract.
 */
interface SourceActorLockStub {
  tryAcquireScrapeLock(
    sourceId: string,
    sessionId: string,
  ): Promise<{ acquired: boolean; sessionId: string }>;
  releaseScrapeLock(sourceId: string, sessionId: string): Promise<void>;
}

export interface SourceLockEnv {
  SOURCE_ACTOR?: DurableObjectNamespace;
}

function lockStub(env: SourceLockEnv, sourceId: string): SourceActorLockStub | null {
  const ns = env.SOURCE_ACTOR;
  if (!ns) return null;
  return ns.get(ns.idFromName(sourceId)) as unknown as SourceActorLockStub;
}

/**
 * Warn once per isolate when the binding is missing. In prod/staging it is
 * always bound, so an absent binding is a real misconfig worth surfacing —
 * but only once, so a hot path can't flood the logs.
 */
let warnedMissingBinding = false;
function warnMissingBinding(op: string): void {
  if (warnedMissingBinding) return;
  warnedMissingBinding = true;
  logEvent("warn", {
    component: "source-lock",
    event: "source-lock-binding-missing",
    op,
    detail: "SOURCE_ACTOR unbound — per-source update dedup lock disabled (failing open)",
  });
}

/**
 * Atomically claim the per-source lease for every id under `sessionId`. Returns
 * the sources that were already locked (empty ⇒ all acquired, dispatch may
 * proceed). On a partial acquire — some free, some contended — the leases we
 * did take are released before returning, so a rejected batch leaves nothing
 * held. Fail-open on an absent binding; a throwing actor is reported as a
 * conflict (fail-closed) so a broken DO can't mint duplicate runs.
 */
export async function tryAcquireSourceLocks(
  env: SourceLockEnv,
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
          component: "source-lock",
          event: "source-lock-acquire-failed",
          sourceId: id,
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
        conflicts.push({ id, sessionId: "__lock_unavailable__" });
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
  env: SourceLockEnv,
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
          component: "source-lock",
          event: "source-lock-release-failed",
          sourceId: id,
          sessionId,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
