/**
 * KV-backed negative-result cache for /v1/lookups. Reuses the existing
 * LATEST_CACHE namespace (binding name unchanged) with a `lookup:` key
 * prefix to avoid collision with the latest-feed cache (`latest:`) and
 * the alert-dedup keys (`alert:`).
 *
 * TTLs:
 *   - not_found: 24h (most repos that 404 today will 404 tomorrow)
 *   - empty:     6h  (empty repos are more likely to gain content soon)
 */

export type LookupNegStatus = "not_found" | "empty";

export interface LookupNegEntry {
  status: LookupNegStatus;
  checkedAt: string;
}

const TTL_SECONDS: Record<LookupNegStatus, number> = {
  not_found: 24 * 60 * 60,
  empty: 6 * 60 * 60,
};

function key(provider: string, coordinate: string): string {
  return `lookup:${provider.toLowerCase()}:${coordinate.toLowerCase()}`;
}

export async function readNegCache(
  kv: KVNamespace,
  provider: string,
  coordinate: string,
): Promise<LookupNegEntry | null> {
  const raw = await kv.get(key(provider, coordinate));
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<LookupNegEntry>;
    if (parsed.status !== "not_found" && parsed.status !== "empty") return null;
    if (typeof parsed.checkedAt !== "string") return null;
    return { status: parsed.status, checkedAt: parsed.checkedAt };
  } catch {
    return null;
  }
}

export async function writeNegCache(
  kv: KVNamespace,
  provider: string,
  coordinate: string,
  status: LookupNegStatus,
): Promise<void> {
  const entry: LookupNegEntry = { status, checkedAt: new Date().toISOString() };
  await kv.put(key(provider, coordinate), JSON.stringify(entry), {
    expirationTtl: TTL_SECONDS[status],
  });
}
