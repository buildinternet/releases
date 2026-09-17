/**
 * Shared SourceActor arming (#2286). Every producer that should leave a source
 * on a live poll alarm (admin fetch, enable/unpause, firecrawl disable, the
 * hourly heartbeat, the fleet re-arm sweep) goes through these helpers so the
 * force/mirror/retry policy can't drift between call sites.
 *
 * Fail-open on a missing binding (local dev) and on a throwing DO RPC — the
 * hourly heartbeat retries, so a dropped arm must not fail the caller's fetch.
 */

import { logEvent } from "@releases/lib/log-event";
import { withDoRetry } from "@releases/lib/do-retry";

/** Bounded concurrency for fleet seeding — polite on the DO control plane. */
export const SOURCE_ACTOR_ENSURE_CONCURRENCY = 20;

interface SourceActorScheduleStub {
  ensureScheduled(sourceId: string, opts?: { force?: boolean }): Promise<unknown>;
}

export interface SourceActorScheduleNs {
  getByName(id: string): SourceActorScheduleStub;
}

export interface SeedSourceActorsResult {
  seeded: number;
  errors: number;
  errorDetail: Array<{ orgSlug: string; error: string }>;
}

/**
 * Arm one source's actor. `force` pulls a pending alarm in (admin fetch / explicit
 * re-arm) so a leftover timer that never fires cannot no-op forever.
 */
export async function ensureSourceActorScheduled(
  actor: SourceActorScheduleNs | undefined,
  sourceId: string,
  opts: { force?: boolean; via?: string } = {},
): Promise<boolean> {
  if (!actor) return false;
  try {
    await withDoRetry(() =>
      actor.getByName(sourceId).ensureScheduled(sourceId, { force: opts.force }),
    );
    return true;
  } catch (err) {
    logEvent("warn", {
      component: "source-actor",
      event: "ensure-scheduled-failed",
      sourceId,
      via: opts.via,
      err: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Seed many actors in bounded waves. Per-source failures are non-fatal. */
export async function seedSourceActors(
  actor: SourceActorScheduleNs,
  sources: ReadonlyArray<{ id: string; orgId?: string | null }>,
  opts: { force?: boolean } = {},
): Promise<SeedSourceActorsResult> {
  let seeded = 0;
  let errors = 0;
  const errorDetail: Array<{ orgSlug: string; error: string }> = [];

  for (let i = 0; i < sources.length; i += SOURCE_ACTOR_ENSURE_CONCURRENCY) {
    const batch = sources.slice(i, i + SOURCE_ACTOR_ENSURE_CONCURRENCY);
    // oxlint-disable-next-line no-await-in-loop -- bounded waves; each wave runs in parallel
    await Promise.all(
      batch.map((s) =>
        withDoRetry(() => actor.getByName(s.id).ensureScheduled(s.id, { force: opts.force }))
          .then(() => {
            seeded += 1;
          })
          .catch((err: unknown) => {
            errors += 1;
            errorDetail.push({
              orgSlug: s.orgId ?? "unknown",
              error: `ensure ${s.id}: ${err instanceof Error ? err.message : String(err)}`,
            });
            logEvent("warn", {
              component: "source-actor",
              event: "source-actor-ensure-failed",
              sourceId: s.id,
              err: err instanceof Error ? err.message : String(err),
            });
          }),
      ),
    );
  }

  return { seeded, errors, errorDetail };
}
