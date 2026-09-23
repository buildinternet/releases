/**
 * Helpers for GET /v1/status/fetch-activity — time-bucketed fetch_log rollups
 * for the admin Status activity chart. Pure helpers live here so unit tests
 * don't need a D1 binding; the HTTP handler stays in status.ts.
 */
import { sql, type SQL } from "drizzle-orm";
import {
  FETCH_LOG_STATUSES,
  type FetchLogStatus,
  fetchLog,
} from "@buildinternet/releases-core/schema";

export const ACTIVITY_BUCKETS = ["hour", "day"] as const;
export type ActivityBucket = (typeof ACTIVITY_BUCKETS)[number];

/** Facepile cap per bucket — matches collection day headers / MemberFacepile. */
export const TOP_ORGS_PER_BUCKET = 4;

/** Hard cap on emitted buckets so a pathological range can't fan out. */
export const MAX_ACTIVITY_BUCKETS = 400;

/**
 * KV read-through TTL for the activity chart. Short enough that a Status page
 * left open still feels current; long enough that range-toggling / tab switches
 * collapse onto one D1 scan per window. Reuses LATEST_CACHE (shared admin/read
 * KV) via {@link withLatestCache} — Workers Cache can't store Bearer responses.
 */
export const ACTIVITY_CACHE_TTL_SECONDS = 60;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const KEY_PREFIX = "fetch-activity:v1";

export type ActivityStatusCounts = Record<FetchLogStatus, number>;

export interface ActivityTopOrg {
  slug: string;
  name: string;
  avatarUrl: string | null;
  /** Optional — chart falls back to avatarUrl / initials when null. */
  githubHandle: string | null;
  count: number;
}

export interface ActivityBucketRow {
  /** Bucket start, ISO-8601 UTC. */
  t: string;
  success: number;
  error: number;
  no_change: number;
  dry_run: number;
  blocked: number;
  crawl_timeout: number;
  skipped: number;
  /** Sum of all status counts (incl. no_change) — dual-axis total-fetches line. */
  total: number;
  releasesInserted: number;
  topOrgs: ActivityTopOrg[];
  /** Distinct orgs with at least one non–no_change fetch in the bucket. */
  orgCount: number;
}

export interface ActivityResponse {
  bucket: ActivityBucket;
  after: string;
  before: string;
  buckets: ActivityBucketRow[];
}

export function emptyStatusCounts(): ActivityStatusCounts {
  return Object.fromEntries(FETCH_LOG_STATUSES.map((s) => [s, 0])) as ActivityStatusCounts;
}

export function buildEmptyActivityBucket(t: string): ActivityBucketRow {
  return {
    t,
    ...emptyStatusCounts(),
    total: 0,
    releasesInserted: 0,
    topOrgs: [],
    orgCount: 0,
  };
}

/** Floor an ISO timestamp to the start of its hour/day bucket (UTC). */
export function floorToBucket(iso: string, bucket: ActivityBucket): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) {
    throw new RangeError(`Invalid ISO timestamp: ${iso}`);
  }
  if (bucket === "day") {
    d.setUTCHours(0, 0, 0, 0);
  } else {
    d.setUTCMinutes(0, 0, 0);
  }
  return d.toISOString();
}

export function bucketStepMs(bucket: ActivityBucket): number {
  return bucket === "day" ? DAY_MS : HOUR_MS;
}

/**
 * SQLite expression that floors `fetch_log.created_at` (ISO text) to a
 * bucket key matching {@link floorToBucket}. Uses `substr` rather than
 * `strftime` so values with fractional seconds / trailing `Z` stay stable.
 */
export function sqlBucketExpr(bucket: ActivityBucket): SQL<string> {
  if (bucket === "day") {
    return sql<string>`substr(${fetchLog.createdAt}, 1, 10) || 'T00:00:00.000Z'`;
  }
  return sql<string>`substr(${fetchLog.createdAt}, 1, 13) || ':00:00.000Z'`;
}

/**
 * Resolve the effective [after, before] window and bucket size. When the
 * caller omits `after` (Status "All Time"), default to a 30-day lookback so
 * we never scan the whole table. Oversized hour ranges coerce to day.
 */
export function resolveActivityWindow(opts: {
  after: string | null | undefined;
  before: string | null | undefined;
  bucket: ActivityBucket | null | undefined;
  nowMs?: number;
}): { after: string; before: string; bucket: ActivityBucket } {
  const nowMs = opts.nowMs ?? Date.now();
  let before =
    opts.before && Number.isFinite(Date.parse(opts.before))
      ? new Date(opts.before).toISOString()
      : new Date(nowMs).toISOString();

  let after: string;
  if (opts.after && Number.isFinite(Date.parse(opts.after))) {
    after = new Date(opts.after).toISOString();
  } else {
    // Default lookback when Status "All Time" has no lower bound.
    after = new Date(nowMs - 30 * DAY_MS).toISOString();
  }

  if (Date.parse(after) > Date.parse(before)) {
    const tmp = after;
    after = before;
    before = tmp;
  }

  let bucket: ActivityBucket = opts.bucket ?? "hour";
  const spanMs = Date.parse(before) - Date.parse(after);

  const hourCount = Math.floor(spanMs / HOUR_MS) + 1;
  if (bucket === "hour" && hourCount > MAX_ACTIVITY_BUCKETS) {
    bucket = "day";
  }
  const step = bucketStepMs(bucket);
  const count = Math.floor(spanMs / step) + 1;
  if (count > MAX_ACTIVITY_BUCKETS) {
    after = new Date(Date.parse(before) - (MAX_ACTIVITY_BUCKETS - 1) * step).toISOString();
  }

  return { after, before, bucket };
}

/**
 * KV key for a resolved window. Floors bounds to the bucket so client
 * millisecond noise doesn't fork the cache.
 */
export function buildActivityCacheKey(opts: {
  bucket: ActivityBucket;
  after: string;
  before: string;
  org?: string | null;
}): string {
  const after = floorToBucket(opts.after, opts.bucket);
  // before is exclusive-ish upper bound from the client ("now"); floor keeps
  // keys stable within the current hour/day.
  const before = floorToBucket(opts.before, opts.bucket);
  const org = opts.org?.trim() || "";
  return `${KEY_PREFIX}:${opts.bucket}:${after}:${before}:${org}`;
}

/**
 * Emit a continuous series of empty buckets covering [after, before], then
 * overlay counts from the SQL rollup. Continuous axes keep the chart from
 * collapsing sparse windows.
 */
export function fillActivityBuckets(
  after: string,
  before: string,
  bucket: ActivityBucket,
  populated: Map<string, ActivityBucketRow>,
): ActivityBucketRow[] {
  const step = bucketStepMs(bucket);
  let t = Date.parse(floorToBucket(after, bucket));
  const end = Date.parse(before);
  const out: ActivityBucketRow[] = [];
  let guard = 0;
  while (t <= end && guard < MAX_ACTIVITY_BUCKETS) {
    const floored = floorToBucket(new Date(t).toISOString(), bucket);
    out.push(populated.get(floored) ?? buildEmptyActivityBucket(floored));
    t += step;
    guard += 1;
  }
  return out;
}

/** Parse `excludeStatus=no_change,dry_run` into a validated status list. */
export function parseExcludeStatuses(raw: string | null | undefined): FetchLogStatus[] {
  if (!raw) return [];
  const set = new Set<FetchLogStatus>();
  for (const part of raw.split(",")) {
    const s = part.trim();
    if ((FETCH_LOG_STATUSES as readonly string[]).includes(s)) {
      set.add(s as FetchLogStatus);
    }
  }
  return [...set];
}

/** Normalize a SQL-produced bucket key to the same form as floorToBucket. */
export function floorBucketKey(raw: string, bucket: ActivityBucket): string {
  try {
    return floorToBucket(raw, bucket);
  } catch {
    return raw;
  }
}

/**
 * Fold status-count + org-contribution SQL rows into continuous buckets.
 * Pure — unit-testable without D1.
 */
export function assembleActivityBuckets(opts: {
  after: string;
  before: string;
  bucket: ActivityBucket;
  statusRows: Array<{ bucket: string; status: string; n: number; inserts: number }>;
  orgRows: Array<{
    bucket: string;
    orgSlug: string | null;
    orgName: string | null;
    avatarUrl: string | null;
    n: number;
  }>;
}): ActivityBucketRow[] {
  const map = new Map<string, ActivityBucketRow>();

  for (const row of opts.statusRows) {
    const key = floorBucketKey(String(row.bucket), opts.bucket);
    let entry = map.get(key);
    if (!entry) {
      entry = buildEmptyActivityBucket(key);
      map.set(key, entry);
    }
    const status = row.status as FetchLogStatus;
    const n = Number(row.n) || 0;
    const inserts = Number(row.inserts) || 0;
    if (status in entry) {
      entry[status] = n;
    }
    entry.total += n;
    entry.releasesInserted += inserts;
  }

  type OrgAcc = {
    slug: string;
    name: string;
    avatarUrl: string | null;
    count: number;
  };
  const orgsByBucket = new Map<string, Map<string, OrgAcc>>();
  for (const row of opts.orgRows) {
    if (!row.orgSlug) continue;
    const key = floorBucketKey(String(row.bucket), opts.bucket);
    let bucketMap = orgsByBucket.get(key);
    if (!bucketMap) {
      bucketMap = new Map();
      orgsByBucket.set(key, bucketMap);
    }
    const n = Number(row.n) || 0;
    bucketMap.set(row.orgSlug, {
      slug: row.orgSlug,
      name: row.orgName ?? row.orgSlug,
      avatarUrl: row.avatarUrl ?? null,
      count: n,
    });
  }

  for (const [key, bucketMap] of orgsByBucket) {
    let entry = map.get(key);
    if (!entry) {
      entry = buildEmptyActivityBucket(key);
      map.set(key, entry);
    }
    const ranked = [...bucketMap.values()].toSorted(
      (a, b) => b.count - a.count || a.slug.localeCompare(b.slug),
    );
    entry.orgCount = ranked.length;
    entry.topOrgs = ranked.slice(0, TOP_ORGS_PER_BUCKET).map((o) => ({
      slug: o.slug,
      name: o.name,
      avatarUrl: o.avatarUrl,
      githubHandle: null,
      count: o.count,
    }));
  }

  return fillActivityBuckets(opts.after, opts.before, opts.bucket, map);
}
