import { Hono } from "hono";
import { and, asc, desc, eq, isNull, ne, notInArray, sql, gte, lte, type SQL } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  FETCH_LOG_STATUSES,
  type FetchLogStatus,
  fetchLog,
  sources,
  organizations,
  usageLog,
} from "@buildinternet/releases-core/schema";
import type { Env } from "../index.js";
import { getStatusHub, parseEnumParam, parseSortDir } from "../utils.js";
import { nullsLastOrderBy } from "../queries/shared.js";
import { encodeCursor, decodeCursor } from "./fetch-log-cursor.js";
import {
  describeFetchPlan,
  computeFetchState,
  computeSweepHealth,
} from "@releases/adapters/fetch-plan";
import { getSourceMeta } from "@releases/adapters/source-meta";
import { describeWorkflowStages } from "@releases/adapters/workflow-stages";
import { respondError } from "../lib/error-response.js";
import { NotFoundError, ValidationError } from "@releases/lib/releases-error";
import {
  ACTIVITY_BUCKETS,
  ACTIVITY_CACHE_TTL_SECONDS,
  type ActivityBucket,
  type ActivityResponse,
  assembleActivityBuckets,
  buildActivityCacheKey,
  parseExcludeStatuses,
  resolveActivityWindow,
  sqlBucketExpr,
} from "./fetch-activity.js";
import { withLatestCache } from "../lib/latest-cache.js";

export const statusRoutes = new Hono<Env>();

statusRoutes.get("/status/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  return getStatusHub(c.env).fetch(c.req.raw);
});

const FETCH_LOG_SORT_FIELDS = ["createdAt", "durationMs"] as const;

// Window for correlating usage_log rows to a fetch run (usage_log has no
// fetchLogId — only sourceId + createdAt). Tunable.
const AI_PASS_WINDOW_MS = 5 * 60_000;
const SPARKLINE_N = 10;

statusRoutes.get("/status/fetch-log", async (c) => {
  const db = createDb(c.env.DB);
  const rawLimit = parseInt(c.req.query("limit") ?? "25", 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 25, 1), 100);
  const after = c.req.query("after");
  const before = c.req.query("before");
  const org = c.req.query("org");
  const statusParam = c.req.query("status");
  const status = (FETCH_LOG_STATUSES as readonly string[]).includes(statusParam ?? "")
    ? (statusParam as FetchLogStatus)
    : undefined;
  const sort = parseEnumParam(c.req.query("sort"), FETCH_LOG_SORT_FIELDS, "createdAt");
  const dir = parseSortDir(c.req.query("dir"));

  // Cursor pagination is only wired for the default (createdAt desc) sort —
  // any other sort pulls a single window capped at `limit` and omits
  // `nextCursor`, because re-ranking across pages (e.g. slowest fetches) is
  // rarely paged through and the cursor shape would have to carry the sort
  // key.
  const useCursor = sort === "createdAt" && dir === "desc";
  const cursorToken = useCursor ? c.req.query("cursor") : undefined;
  const cursor = cursorToken ? decodeCursor(cursorToken) : null;

  // Scope predicates — apply to both counts and the page.
  const scope = [];
  if (after) scope.push(gte(fetchLog.createdAt, after));
  if (before) scope.push(lte(fetchLog.createdAt, before));
  if (org) scope.push(eq(organizations.slug, org));
  // Activity-chart drill-down wants "signal only" (everything except
  // no_change). Comma-separated list of statuses to drop from both the page
  // and the statusCounts rollup.
  const excludeStatuses = parseExcludeStatuses(c.req.query("excludeStatus"));
  if (excludeStatuses.length > 0) {
    scope.push(
      excludeStatuses.length === 1
        ? ne(fetchLog.status, excludeStatuses[0]!)
        : notInArray(fetchLog.status, excludeStatuses),
    );
  }

  // Page predicates add status and cursor.
  const pagePredicates = [...scope];
  if (status) pagePredicates.push(eq(fetchLog.status, status));
  if (cursor) {
    pagePredicates.push(
      sql`(${fetchLog.createdAt}, ${fetchLog.id}) < (${cursor.createdAt}, ${cursor.id})`,
    );
  }

  const dirFn = dir === "asc" ? asc : desc;
  const orderBy: SQL[] =
    sort === "durationMs"
      ? [...nullsLastOrderBy(fetchLog.durationMs, dir), desc(fetchLog.createdAt), desc(fetchLog.id)]
      : [dirFn(fetchLog.createdAt), dirFn(fetchLog.id)];

  const rows = await db
    .select({
      id: fetchLog.id,
      sourceId: fetchLog.sourceId,
      sessionId: fetchLog.sessionId,
      sourceName: sources.name,
      sourceSlug: sources.slug,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      releasesFound: fetchLog.releasesFound,
      releasesInserted: fetchLog.releasesInserted,
      durationMs: fetchLog.durationMs,
      status: fetchLog.status,
      error: fetchLog.error,
      rawContent: fetchLog.rawContent,
      createdAt: fetchLog.createdAt,
    })
    .from(fetchLog)
    .leftJoin(sources, sql`${fetchLog.sourceId} = ${sources.id}`)
    .leftJoin(organizations, sql`${sources.orgId} = ${organizations.id}`)
    .where(pagePredicates.length > 0 ? and(...pagePredicates) : undefined)
    .orderBy(...orderBy)
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const last = entries[entries.length - 1];
  const nextCursor =
    useCursor && hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  // Count query runs only on the first page (no cursor). The grouped
  // rollup gives us both the per-status counts and the scope-wide total.
  let totalCount: number | undefined;
  let statusCounts: Record<FetchLogStatus, number> | undefined;
  if (!cursor) {
    const grouped = await db
      .select({ status: fetchLog.status, n: sql<number>`count(*)` })
      .from(fetchLog)
      .leftJoin(sources, sql`${fetchLog.sourceId} = ${sources.id}`)
      .leftJoin(organizations, sql`${sources.orgId} = ${organizations.id}`)
      .where(scope.length > 0 ? and(...scope) : undefined)
      .groupBy(fetchLog.status);

    statusCounts = Object.fromEntries(FETCH_LOG_STATUSES.map((s) => [s, 0])) as Record<
      FetchLogStatus,
      number
    >;
    totalCount = 0;
    for (const row of grouped) {
      const n = Number(row.n);
      totalCount += n;
      statusCounts[row.status as FetchLogStatus] = n;
    }
  }

  return c.json({ entries, nextCursor, totalCount, statusCounts });
});

/**
 * Time-bucketed fetch_log rollup for the admin Status activity chart.
 * Admin-internal (Bearer via /api/proxy) — not part of the published wire
 * protocol. Returns continuous buckets (zeros filled) with per-status counts,
 * releasesInserted, and a small topOrgs facepile (non–no_change only).
 *
 * Performance notes:
 * - Status rollup hits `idx_fetch_log_created` and skips source/org joins when
 *   not filtering by org (the common path).
 * - Facepile query is signal-only (`status != no_change`) and avoids a
 *   correlated `org_accounts` subquery (avatar_url is enough for OrgAvatar).
 * - Both queries run in parallel; the assembled payload is KV-cached for 60s
 *   via LATEST_CACHE (`withLatestCache`). Workers Cache can't store Bearer
 *   responses (cacheControl forces no-store on Authorization), so KV is the
 *   only shared layer that helps here.
 *
 * Query: after?, before?, bucket=hour|day, org?
 */
statusRoutes.get("/status/fetch-activity", async (c) => {
  const org = c.req.query("org") || undefined;
  const rawBucket = c.req.query("bucket");
  const requestedBucket = (ACTIVITY_BUCKETS as readonly string[]).includes(rawBucket ?? "")
    ? (rawBucket as ActivityBucket)
    : null;

  const window = resolveActivityWindow({
    after: c.req.query("after"),
    before: c.req.query("before"),
    bucket: requestedBucket,
  });

  const cacheKey = buildActivityCacheKey({
    bucket: window.bucket,
    after: window.after,
    before: window.before,
    org,
  });

  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }

  const { data, hit } = await withLatestCache<ActivityResponse>(
    c.env.LATEST_CACHE,
    cacheKey,
    waitUntil,
    () => computeFetchActivity(c.env.DB, window, org),
    ACTIVITY_CACHE_TTL_SECONDS,
  );

  c.header("X-Cache", hit ? "HIT" : "MISS");
  return c.json(data);
});

async function computeFetchActivity(
  d1: Parameters<typeof createDb>[0],
  window: { after: string; before: string; bucket: ActivityBucket },
  org: string | undefined,
): Promise<ActivityResponse> {
  const db = createDb(d1);
  const bucketSql = sqlBucketExpr(window.bucket);
  const timeScope: SQL[] = [
    gte(fetchLog.createdAt, window.after),
    lte(fetchLog.createdAt, window.before),
  ];

  // Status counts: no joins unless filtering by org — keeps the hot path on
  // idx_fetch_log_created alone.
  const statusQuery = org
    ? db
        .select({
          bucket: sql<string>`${bucketSql}`.mapWith(String),
          status: fetchLog.status,
          n: sql<number>`count(*)`.mapWith(Number),
          inserts: sql<number>`coalesce(sum(${fetchLog.releasesInserted}), 0)`.mapWith(Number),
        })
        .from(fetchLog)
        .innerJoin(sources, eq(fetchLog.sourceId, sources.id))
        .innerJoin(organizations, eq(sources.orgId, organizations.id))
        .where(and(...timeScope, eq(organizations.slug, org)))
        .groupBy(bucketSql, fetchLog.status)
    : db
        .select({
          bucket: sql<string>`${bucketSql}`.mapWith(String),
          status: fetchLog.status,
          n: sql<number>`count(*)`.mapWith(Number),
          inserts: sql<number>`coalesce(sum(${fetchLog.releasesInserted}), 0)`.mapWith(Number),
        })
        .from(fetchLog)
        .where(and(...timeScope))
        .groupBy(bucketSql, fetchLog.status);

  // Facepile: signal-only. avatar_url only (no org_accounts correlated subq).
  const orgScope: SQL[] = [...timeScope, ne(fetchLog.status, "no_change")];
  if (org) orgScope.push(eq(organizations.slug, org));

  const orgQuery = db
    .select({
      bucket: sql<string>`${bucketSql}`.mapWith(String),
      orgSlug: organizations.slug,
      orgName: organizations.name,
      avatarUrl: organizations.avatarUrl,
      n: sql<number>`count(*)`.mapWith(Number),
    })
    .from(fetchLog)
    .innerJoin(sources, eq(fetchLog.sourceId, sources.id))
    .innerJoin(organizations, eq(sources.orgId, organizations.id))
    .where(and(...orgScope))
    .groupBy(bucketSql, organizations.id);

  const [statusRows, orgRows] = await Promise.all([statusQuery, orgQuery]);

  return {
    bucket: window.bucket,
    after: window.after,
    before: window.before,
    buckets: assembleActivityBuckets({
      after: window.after,
      before: window.before,
      bucket: window.bucket,
      statusRows,
      orgRows,
    }),
  };
}

// Dev-only operator view: per-source fetch strategy, interval, and live timing
// state for an org. Reachable only through the flag-gated /api/proxy and the
// dev-gated Fetch Log tab (NODE_ENV check on the page). Mirrors the plain-route
// shape of /status/fetch-log — not part of the published api-types wire protocol.
statusRoutes.get("/status/fetch-plan", async (c) => {
  const db = createDb(c.env.DB);
  const org = c.req.query("org");
  if (!org) {
    return respondError(
      c,
      new ValidationError("org query param is required", { code: "bad_request" }),
    );
  }

  const [orgRow] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(eq(organizations.slug, org))
    .limit(1);
  if (!orgRow) return c.json({ sources: [] });

  // Exclude soft-deleted (tombstoned) sources (#666) so the panel matches normal
  // read-path behavior; hidden sources are kept — they still carry fetch config.
  const rows = await db
    .select()
    .from(sources)
    .where(and(eq(sources.orgId, orgRow.id), isNull(sources.deletedAt)))
    .orderBy(asc(sources.name));

  const now = new Date();
  const result = rows.map((s) => {
    const plan = describeFetchPlan(s);
    const meta = getSourceMeta(s);
    return {
      id: s.id,
      slug: s.slug,
      name: s.name,
      type: s.type,
      fetchPriority: s.fetchPriority ?? "normal",
      plan,
      state: computeFetchState(s, plan, now),
      sweep: computeSweepHealth(s, plan, now),
      sourceActor: meta.sourceActor ?? null,
    };
  });
  return c.json({ sources: result });
});

// Dev-only: per-source ingestion-pipeline topology + derived run state for the
// Fetch Log workflow drawer. Same /api/proxy + dev-gating as /status/fetch-plan;
// not part of the published api-types wire protocol.
statusRoutes.get("/status/source-workflow", async (c) => {
  const db = createDb(c.env.DB);
  const sourceId = c.req.query("sourceId");
  if (!sourceId) {
    return respondError(c, new ValidationError("sourceId is required", { code: "bad_request" }));
  }

  const [sourceRows, recent] = await Promise.all([
    db
      .select()
      .from(sources)
      .where(and(eq(sources.id, sourceId), isNull(sources.deletedAt)))
      .limit(1),
    db
      .select({
        status: fetchLog.status,
        releasesFound: fetchLog.releasesFound,
        releasesInserted: fetchLog.releasesInserted,
        durationMs: fetchLog.durationMs,
        error: fetchLog.error,
        createdAt: fetchLog.createdAt,
      })
      .from(fetchLog)
      .where(eq(fetchLog.sourceId, sourceId))
      .orderBy(desc(fetchLog.createdAt), desc(fetchLog.id))
      .limit(SPARKLINE_N),
  ]);
  const source = sourceRows[0];
  if (!source) return respondError(c, new NotFoundError());

  const now = new Date();
  const plan = describeFetchPlan(source);
  const state = computeFetchState(source, plan, now);
  const sweep = computeSweepHealth(source, plan, now);
  const stages = describeWorkflowStages(source);

  const lastRun = recent[0] ?? null;
  const sparkline = recent.map((r) => r.status).reverse(); // oldest→newest

  let aiPasses: {
    operation: string;
    count: number;
    inputTokens: number;
    outputTokens: number;
  }[] = [];
  const lastRunMs = lastRun ? Date.parse(lastRun.createdAt) : NaN;
  if (lastRun && Number.isFinite(lastRunMs)) {
    const lo = new Date(lastRunMs - AI_PASS_WINDOW_MS).toISOString();
    const hi = new Date(lastRunMs + AI_PASS_WINDOW_MS).toISOString();
    const rows = await db
      .select({
        operation: usageLog.operation,
        count: sql<number>`count(*)`,
        inputTokens: sql<number>`coalesce(sum(${usageLog.inputTokens}), 0)`,
        outputTokens: sql<number>`coalesce(sum(${usageLog.outputTokens}), 0)`,
      })
      .from(usageLog)
      .where(
        and(
          eq(usageLog.sourceId, sourceId),
          gte(usageLog.createdAt, lo),
          lte(usageLog.createdAt, hi),
        ),
      )
      .groupBy(usageLog.operation)
      .orderBy(asc(usageLog.operation));
    aiPasses = rows.map((r) => ({
      operation: r.operation,
      count: Number(r.count),
      inputTokens: Number(r.inputTokens),
      outputTokens: Number(r.outputTokens),
    }));
  }

  return c.json({
    source: {
      id: source.id,
      slug: source.slug,
      name: source.name,
      type: source.type,
      strategyLabel: plan.strategyLabel,
    },
    plan,
    state,
    sweep,
    stages,
    lastRun,
    aiPasses,
    sparkline,
  });
});

statusRoutes.get("/status/usage", async (c) => {
  const db = createDb(c.env.DB);
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({
      model: usageLog.model,
      totalInput: sql<number>`sum(${usageLog.inputTokens})`,
      totalOutput: sql<number>`sum(${usageLog.outputTokens})`,
    })
    .from(usageLog)
    .where(gte(usageLog.createdAt, todayStart.toISOString()))
    .groupBy(usageLog.model);

  return c.json(rows);
});

statusRoutes.post("/status/event", async (c) => {
  const event = await c.req.json();
  await getStatusHub(c.env).fetch(
    new Request("https://do/event", {
      method: "POST",
      body: JSON.stringify(event),
      headers: { "Content-Type": "application/json" },
    }),
  );
  return c.json({ ok: true });
});
