/**
 * Delivery-health bookkeeping for the Firecrawl webhook receiver.
 *
 * Two signals let the staleness scan tell "the receiver is rejecting every
 * delivery" apart from "these pages are just quiet" (the 2026-09-15 → 10-04
 * outage looked identical to a quiet fleet for three weeks):
 *
 * - `metadata.firecrawl.lastDeliveryAt` — stamped on EVERY authenticated
 *   delivery for a known, enabled source, including ones the cost gate skips
 *   (`status: same`, non-meaningful `changed`). `lastFetchedAt` only moves when
 *   the ingest workflow runs, so it can't separate a quiet page from a dead pipe.
 * - A throttled KV marker of recent auth rejections, read by the scan only when
 *   deliveries have stopped fleet-wide, so the digest can say whether the
 *   handler itself is rejecting (wrong/missing token, unbound secret) or nothing
 *   is reaching it at all (route gated or removed upstream of the handler).
 */
import { eq, sql } from "drizzle-orm";
import { sources } from "@buildinternet/releases-core/schema";

export type FirecrawlAuthRejectReason = "missing" | "mismatch" | "secret-unbound";

export type FirecrawlAuthRejection = {
  /** First rejection in the current streak (the marker expires after a quiet TTL). */
  firstAt: string;
  /** Most recent recorded rejection (throttled — accurate to REJECTION_WRITE_INTERVAL_MS). */
  lastAt: string;
  reason: FirecrawlAuthRejectReason;
};

const REJECTION_KEY = "firecrawl:webhook:auth-rejected";
/** A streak ends after this long with no rejections. Real deliveries come daily. */
const REJECTION_TTL_SECONDS = 72 * 3600;
/**
 * At most one KV write per interval. Real Firecrawl batches arrive ~40 at once,
 * and anyone can POST to the receiver, so an unthrottled write per rejection
 * would let unauthenticated traffic drive KV write volume.
 */
const REJECTION_WRITE_INTERVAL_MS = 15 * 60_000;

type KV = Pick<KVNamespace, "get" | "put">;

/** Best-effort: never throws — a KV blip must not change the 401 response. */
export async function recordFirecrawlAuthRejection(
  kv: KV | undefined,
  reason: FirecrawlAuthRejectReason,
  now: Date = new Date(),
): Promise<void> {
  if (!kv) return;
  try {
    const prev = await readFirecrawlAuthRejection(kv);
    if (
      prev &&
      prev.reason === reason &&
      now.getTime() - Date.parse(prev.lastAt) < REJECTION_WRITE_INTERVAL_MS
    ) {
      return;
    }
    const next: FirecrawlAuthRejection = {
      firstAt: prev?.firstAt ?? now.toISOString(),
      lastAt: now.toISOString(),
      reason,
    };
    await kv.put(REJECTION_KEY, JSON.stringify(next), { expirationTtl: REJECTION_TTL_SECONDS });
  } catch {
    // Diagnostics only.
  }
}

export async function readFirecrawlAuthRejection(
  kv: Pick<KVNamespace, "get"> | undefined,
): Promise<FirecrawlAuthRejection | null> {
  if (!kv) return null;
  try {
    const raw = await kv.get(REJECTION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FirecrawlAuthRejection>;
    if (!parsed.firstAt || !parsed.lastAt || !parsed.reason) return null;
    return parsed as FirecrawlAuthRejection;
  } catch {
    return null;
  }
}

/**
 * Stamp `metadata.firecrawl.lastDeliveryAt` with a single `json_set`, so it
 * can't clobber a concurrent write to any other metadata key. The receiver
 * only calls this after confirming `metadata.firecrawl` exists and is enabled.
 */
export async function stampFirecrawlDelivery(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle D1 / bun-sqlite handles share this surface
  db: any,
  sourceId: string,
  now: Date = new Date(),
): Promise<void> {
  await db
    .update(sources)
    .set({
      metadata: sql`json_set(${sources.metadata}, '$.firecrawl.lastDeliveryAt', ${now.toISOString()})`,
    })
    .where(eq(sources.id, sourceId));
}
