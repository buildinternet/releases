/**
 * KV-backed daily spend circuit breaker for managed-agent sessions.
 *
 * Two scopes:
 *   - Per-org:  key `ma:spend:org:{orgId}:{YYYY-MM-DD}` — default cap $2.00/day
 *   - Global:   key `ma:spend:global:{YYYY-MM-DD}`       — default cap $15.00/day
 *
 * Both keys carry a 26h TTL so they self-clean without a manual reset.
 * Manual reset during an incident:
 *   wrangler kv:key delete --binding=LATEST_CACHE "ma:spend:global:2026-05-19"
 *
 * Counter writes use a read-modify-write pattern (KV has no atomic increment).
 * A race between two concurrent `runSession` finally blocks can lose one
 * update at worst — acceptable for an order-of-magnitude cost cap. The counter
 * undershoots rather than overshoots, so the gate fires a bit late but never
 * allows more than ~2× the cap through the race window.
 *
 * Issue #1055. Part of #1051.
 */

import { logEvent } from "@releases/lib/log-event.js";

// 26 hours — slightly longer than a calendar day so a counter written at
// 23:59 UTC on day N doesn't expire before midnight UTC on day N+1.
const TTL_SECONDS = 26 * 3600;

/** Default per-org cap: $2.00 / day */
const DEFAULT_ORG_CAP_CENTS = 200;
/** Default global cap: $15.00 / day */
const DEFAULT_GLOBAL_CAP_CENTS = 1500;

export type SpendCapResult =
  | { blocked: false }
  | { blocked: true; scope: "org" | "global"; currentCents: number; capCents: number };

/**
 * Read-modify-write increment for a KV spend counter. Uses a 0-second cache
 * TTL on the read to bypass any edge cache so we see the freshest value.
 *
 * Non-atomic — two concurrent callers can both read the same base value and
 * each write `base + delta`, effectively losing one update. Acceptable for a
 * cost cap where the goal is order-of-magnitude protection, not accounting
 * precision.
 */
export async function incrementKvSpend(
  kv: KVNamespace,
  key: string,
  cents: number,
  ttlSeconds: number,
): Promise<void> {
  const raw = await kv.get(key);
  const current = raw !== null ? parseInt(raw, 10) : 0;
  const newValue = current + cents;
  // expirationTtl must be at least 60 seconds per the KV API.
  await kv.put(key, String(newValue), { expirationTtl: Math.max(ttlSeconds, 60) });
}

/**
 * Pre-flight spend gate. Returns blocked=true when either the per-org or the
 * global daily spend counter has already reached its cap.
 *
 * Fail-open: if the KV read throws, we log a warning and return blocked=false
 * so a KV blip doesn't halt all managed-agent sessions.
 */
export async function checkSpendCap(
  kv: KVNamespace,
  orgId: string | undefined,
  env: { MA_DAILY_SPEND_CAP_ORG_CENTS?: string; MA_DAILY_SPEND_CAP_GLOBAL_CENTS?: string },
): Promise<SpendCapResult> {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const orgCap = env.MA_DAILY_SPEND_CAP_ORG_CENTS
    ? parseInt(env.MA_DAILY_SPEND_CAP_ORG_CENTS, 10)
    : DEFAULT_ORG_CAP_CENTS;
  const globalCap = env.MA_DAILY_SPEND_CAP_GLOBAL_CENTS
    ? parseInt(env.MA_DAILY_SPEND_CAP_GLOBAL_CENTS, 10)
    : DEFAULT_GLOBAL_CAP_CENTS;

  try {
    const globalKey = `ma:spend:global:${date}`;
    const orgKey = orgId ? `ma:spend:org:${orgId}:${date}` : null;

    const [globalRaw, orgRaw] = await Promise.all([
      kv.get(globalKey),
      orgKey ? kv.get(orgKey) : Promise.resolve(null),
    ]);

    const globalCents = globalRaw !== null ? parseInt(globalRaw, 10) : 0;
    const orgCents = orgRaw !== null ? parseInt(orgRaw, 10) : 0;

    // Check org cap first (tighter) so the logged scope is accurate.
    if (orgId && orgCents >= orgCap) {
      return { blocked: true, scope: "org", currentCents: orgCents, capCents: orgCap };
    }
    if (globalCents >= globalCap) {
      return { blocked: true, scope: "global", currentCents: globalCents, capCents: globalCap };
    }

    return { blocked: false };
  } catch (err) {
    logEvent("warn", {
      component: "discovery",
      event: "spend-cap-check-failed",
      orgId,
      err: err instanceof Error ? err : new Error(String(err)),
    });
    return { blocked: false };
  }
}

/**
 * Increment both the global and per-org spend counters after a session
 * completes. Only writes when `estimatedUsd > 0` — cancelled/zero-cost paths
 * don't pollute the counter.
 *
 * Wrapped in try/catch so a KV failure never propagates out of the finally block.
 */
export async function recordSessionSpend(
  kv: KVNamespace,
  estimatedUsd: number,
  orgId: string | undefined,
): Promise<void> {
  if (estimatedUsd <= 0) return;

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  const cents = Math.round(estimatedUsd * 100);

  const writes: Promise<void>[] = [];

  const globalKey = `ma:spend:global:${date}`;
  writes.push(
    incrementKvSpend(kv, globalKey, cents, TTL_SECONDS).then(async () => {
      // Re-read the new value for logging (best-effort).
      try {
        const newRaw = await kv.get(globalKey);
        const newCents = newRaw !== null ? parseInt(newRaw, 10) : cents;
        logEvent("info", {
          component: "discovery",
          event: "spend-counter-incremented",
          scope: "global",
          key: globalKey,
          addedCents: cents,
          newCents,
        });
      } catch {
        // Logging the new value is best-effort; the write already succeeded.
        logEvent("info", {
          component: "discovery",
          event: "spend-counter-incremented",
          scope: "global",
          key: globalKey,
          addedCents: cents,
        });
      }
    }),
  );

  if (orgId) {
    const orgKey = `ma:spend:org:${orgId}:${date}`;
    writes.push(
      incrementKvSpend(kv, orgKey, cents, TTL_SECONDS).then(async () => {
        try {
          const newRaw = await kv.get(orgKey);
          const newCents = newRaw !== null ? parseInt(newRaw, 10) : cents;
          logEvent("info", {
            component: "discovery",
            event: "spend-counter-incremented",
            scope: "org",
            key: orgKey,
            addedCents: cents,
            newCents,
          });
        } catch {
          logEvent("info", {
            component: "discovery",
            event: "spend-counter-incremented",
            scope: "org",
            key: orgKey,
            addedCents: cents,
          });
        }
      }),
    );
  }

  try {
    await Promise.all(writes);
  } catch (err) {
    logEvent("warn", {
      component: "discovery",
      event: "spend-counter-write-failed",
      orgId,
      addedCents: cents,
      err: err instanceof Error ? err : new Error(String(err)),
    });
  }
}
