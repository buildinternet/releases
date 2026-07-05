// Mount point for /v1/workflows/* job/workflow trigger endpoints.
import { Hono } from "hono";
import { and, count, desc, eq, gte, inArray, isNull, or, sql } from "drizzle-orm";
import { computeContentSize } from "@buildinternet/releases-core/tokens";
import { contentHash } from "@releases/adapters/content-hash";
import { normalizeMediaUrl } from "@releases/rendering/media-url.js";
import {
  runMediaBackfill,
  MEDIA_BACKFILL_DEFAULT_LIMIT,
  MEDIA_BACKFILL_MAX_LIMIT,
  runGifTranscodeBackfill,
  GIF_BACKFILL_DEFAULT_LIMIT,
  GIF_BACKFILL_MAX_LIMIT,
  runVideoBackfill,
  VIDEO_BACKFILL_DEFAULT_LIMIT,
  VIDEO_BACKFILL_MAX_LIMIT,
  runJunkMediaPurge,
  JUNK_PURGE_DEFAULT_LIMIT,
  JUNK_PURGE_MAX_LIMIT,
} from "../lib/media-backfill.js";
import {
  enrichFeedItem,
  buildEnrichDeps,
  parsePositiveInt,
  type EnrichResult,
} from "../cron/feed-enrich.js";
import { sendEmail } from "../lib/email.js";
import { sendEmailSample } from "../lib/email-samples.js";
import type { CronReportStatus } from "../lib/cron-report.js";
import { createDb, type AnyDb } from "../db.js";
import {
  organizations,
  organizationsPublic,
  products,
  productsActive,
  releases,
  sources,
  sourcesVisible,
  sourceChangelogFiles,
  sourceChangelogChunks,
  sourceRawSnapshots,
  collections,
  collectionMembers,
} from "@buildinternet/releases-core/schema";
import { summarizeEligibilityConds } from "@releases/core-internal/eligibility";
import {
  daysAgoIso,
  etDayKey,
  addDaysToDateKey,
  isDateKey,
} from "@buildinternet/releases-core/dates";
import { sourceMatchByIdOrSlug, isSourceId } from "../utils.js";
import { getAnthropicKey, resolveGatewayOpts } from "../lib/anthropic.js";
import { embedAndUpsertReleases, type EmbedReleaseInput } from "@releases/search/embed-releases.js";
import {
  embedAndUpsertEntities,
  type EmbedEntityInput,
  type EntityKind,
} from "@releases/search/embed-entities.js";
import { embedAndUpsertChangelogFile } from "@releases/search/embed-changelog-pipeline.js";
import {
  applyOnDiff,
  setChunkVectorIds,
  ingestRawReleases,
  embedReleasesForSource,
} from "../cron/poll-fetch.js";
import { buildEmbedConfig } from "@releases/search/embed-config.js";
import { logEvent } from "@releases/lib/log-event";
import { flag, FLAGS } from "@releases/lib/flags";
import type { VectorizeIndex } from "@releases/search/vector-search.js";
import type { Env } from "../index.js";
import { clusterAndPersistCascades, DECIDED_BY_CHANGESETS } from "../lib/cluster-cascades.js";
import { clusterChangesets } from "@releases/core-internal/changesets-cluster";
import { releaseCoverage } from "@releases/db/schema-coverage.js";
import { IN_ARRAY_CHUNK_SIZE } from "../lib/d1-limits.js";
import {
  mergeEnrichmentMarker,
  hasStoredMedia,
  selectEnrichCandidates,
  BATCH_ENRICH_DEFAULT_LIMIT,
  BATCH_ENRICH_MAX_LIMIT,
} from "../lib/enrich-apply.js";
import type { Source } from "@buildinternet/releases-core/schema";
import type { RawRelease } from "@releases/adapters/types.js";
import { getSourceMeta, htmlToMarkdown } from "@releases/adapters/feed.js";
import { createFirecrawlClient } from "@releases/adapters/firecrawl.js";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { getSecret } from "@releases/lib/secrets";
import { FirecrawlError } from "@releases/lib/errors";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { extractChangelogAllWindows } from "../lib/firecrawl-extract.js";
import { logUsage } from "../lib/usage-log.js";
import {
  runSourceBackfill,
  effectiveBackfillWindows,
  firecrawlCapGuidance,
  type BackfillBodyVia,
  type SourceBackfillDeps,
  type SourceBackfillExtractResult,
  type SourceBackfillReport,
} from "../lib/source-backfill.js";
import { loadRawSnapshot } from "../lib/raw-snapshot.js";
import { generateCollectionSummariesForDay } from "../cron/collection-summaries.js";
import { resolveCollectionSummaryModel } from "../lib/text-model.js";
import { parseJsonBody } from "../lib/json-body.js";
import { workflowInstanceStatus, workflowInstanceTerminate } from "../lib/workflow-instance.js";
import { respondError } from "../lib/error-response.js";
import {
  ValidationError,
  NotFoundError,
  ConflictError,
  RateLimitedError,
  UpstreamError,
  ServiceUnavailableError,
  InternalError,
} from "@releases/lib/releases-error";
import { startDeterministicUpdate } from "../lib/update-dispatch.js";
import type { MediaBackfillKind } from "../workflows/media-backfill.js";
import type { Context } from "hono";

export const workflowsRoutes = new Hono<Env>();

async function replyWorkflowStatus(
  c: Context<Env>,
  binding: Workflow | undefined,
  unavailableMessage: string,
  component: string,
) {
  const instanceId = c.req.param("instanceId") ?? "";
  const result = await workflowInstanceStatus(binding, instanceId);
  if (!result.ok) {
    if (result.code === "unavailable") {
      return respondError(c, new ServiceUnavailableError(unavailableMessage));
    }
    if (result.code === "not_found") {
      return respondError(
        c,
        new NotFoundError(result.message, { code: "instance_not_found", details: { instanceId } }),
      );
    }
    logEvent("error", {
      component,
      event: "lookup-failed",
      instanceId,
      err: result.message,
    });
    return respondError(c, new InternalError(result.message));
  }
  return c.json({ instanceId, ...result.status });
}

async function replyWorkflowTerminate(
  c: Context<Env>,
  binding: Workflow | undefined,
  unavailableMessage: string,
  component: string,
) {
  const instanceId = c.req.param("instanceId") ?? "";
  const result = await workflowInstanceTerminate(binding, instanceId);
  if (!result.ok) {
    if (result.code === "unavailable") {
      return respondError(c, new ServiceUnavailableError(unavailableMessage));
    }
    if (result.code === "not_found") {
      return respondError(
        c,
        new NotFoundError(result.message, { code: "instance_not_found", details: { instanceId } }),
      );
    }
    logEvent("error", {
      component,
      event: "terminate-failed",
      instanceId,
      err: result.message,
    });
    return respondError(c, new InternalError(result.message));
  }
  return c.json({ instanceId, terminated: true });
}

async function dispatchMediaBackfillWorkflow(
  c: Context<Env>,
  kind: MediaBackfillKind,
  component: string,
  logFields: Record<string, unknown>,
  params: {
    sourceId?: string;
    releaseId?: string;
    all?: boolean;
    batchLimit?: number;
    dryRun?: boolean;
    maxBatches?: number;
  },
) {
  const binding = c.env.MEDIA_BACKFILL_WORKFLOW;
  if (!binding) return null;
  const scheduledTime = Date.now();
  const instance = await binding.create({
    id: `media-backfill-${kind}-admin-${scheduledTime}`,
    params: { kind, ...params },
  });
  const instanceId: string = (instance as unknown as { id: string }).id;
  const body = {
    instanceId,
    statusUrl: `${c.env.ADMIN_BASE_URL ?? ""}/v1/workflows/media-backfill/status/${instanceId}`,
  };
  logEvent("info", { component, event: "workflow-trigger", instanceId, ...logFields });
  return body;
}

type TestBody = {
  /** Fabricated status for the sample cron report. */
  status?: CronReportStatus;
  /** Cron name to impersonate in the report. */
  cronName?: string;
  /** If true, skip the cron-report wrapper and send a bare test email. */
  plain?: boolean;
  /** Subject override when `plain: true`. */
  subject?: string;
  /** Body override when `plain: true`. */
  body?: string;
};

const VALID_STATUSES = new Set<CronReportStatus>([
  "done",
  "degraded",
  "dispatch_failed",
  "aborted",
]);

workflowsRoutes.post("/workflows/notifications-test", async (c) => {
  const body = await parseJsonBody<TestBody>(c);

  const target = c.env.EMAIL_NOTIFY_TO;
  if (!target) {
    return respondError(c, new ServiceUnavailableError("EMAIL_NOTIFY_TO not configured"));
  }

  if (body.plain) {
    const result = await sendEmail(c.env, {
      subject: body.subject ?? "[test] releases notifications",
      text:
        body.body ??
        "Test email from the releases API. If you got this, the send_email binding is wired correctly.",
      to: target,
    });
    return c.json({ ok: result.sent, result }, result.sent ? 200 : 202);
  }

  // Cron-report samples now live in the shared email catalog; status/cronName
  // body fields are accepted for CLI compatibility but the rendered sample is
  // fixed. Use POST /v1/admin/emails/test for the full template matrix.
  void (body.status && VALID_STATUSES.has(body.status) ? body.status : "done");
  void body.cronName;

  const result = await sendEmailSample(c.env, "operator.cron-report", target);
  return c.json(
    {
      ok: result.sent,
      result,
      type: "operator.cron-report",
    },
    result.sent ? 200 : 202,
  );
});

// ── Embed backfill helpers ────────────────────────────────────────────────────

/** Max rows processed per endpoint call. The CLI loops until `remaining === 0`. */
const EMBED_BATCH_CAP = 50;

/**
 * Cast: workers-types `VectorizeIndex` declares a stricter metadata value
 * type than the runtime-agnostic interface in `@releases/search/vector-search.ts`.
 * Identical at runtime; only diverges by type-system variance.
 */
function asSharedIndex(index: unknown): VectorizeIndex {
  return index as VectorizeIndex;
}

function clampLimit(n: unknown): number {
  const parsed = typeof n === "number" ? n : typeof n === "string" ? parseInt(n, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return EMBED_BATCH_CAP;
  return Math.min(parsed, EMBED_BATCH_CAP);
}

// SQL fragment that mirrors the JS `needsWork(r)` predicate: a file
// qualifies if it has zero chunks (never embedded) or any chunk with
// `vector_id IS NULL` (embed crashed mid-upsert). Pushed into HAVING so
// LIMIT only sees files that actually need work — without it, LIMIT can
// return all-embedded files and starve the drain. See #624.
const NEEDS_WORK_HAVING = sql`COUNT(${sourceChangelogChunks.id}) = 0 OR SUM(CASE WHEN ${sourceChangelogChunks.vectorId} IS NULL THEN 1 ELSE 0 END) > 0`;

// ── POST /workflows/embed-releases ───────────────────────────────────────────

interface EmbedReleasesBody {
  since?: string;
  limit?: number;
  dryRun?: boolean;
}

workflowsRoutes.post("/workflows/embed-releases", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<EmbedReleasesBody>(c);
  const limit = clampLimit(body.limit);
  const since = body.since;
  const dryRun = body.dryRun === true;

  // Join releases → sources for org/product/category metadata.
  const conditions = [
    isNull(releases.embeddedAt),
    isNull(sources.deletedAt),
    or(eq(sources.isHidden, false), isNull(sources.isHidden)),
    or(isNull(releases.suppressed), eq(releases.suppressed, false)),
  ];
  if (since) conditions.push(gte(releases.publishedAt, since));

  // Remaining = backlog under the same predicate. Ran in parallel with the
  // row fetch so a cold D1 hit doesn't serialize two round-trips.
  const [rows, [{ n: remainingBefore }]] = await Promise.all([
    db
      .select({
        id: releases.id,
        title: releases.title,
        content: releases.content,
        summary: releases.summary,
        version: releases.version,
        publishedAt: releases.publishedAt,
        sourceId: releases.sourceId,
        type: releases.type,
        orgId: sources.orgId,
        productId: sources.productId,
        category: organizations.category,
      })
      .from(releases)
      .leftJoin(sources, eq(releases.sourceId, sources.id))
      .leftJoin(organizations, eq(sources.orgId, organizations.id))
      .where(and(...conditions))
      .limit(limit),
    db
      .select({ n: count() })
      .from(releases)
      .leftJoin(sources, eq(releases.sourceId, sources.id))
      .where(and(...conditions)),
  ]);

  if (rows.length === 0 || dryRun) {
    return c.json({
      processed: rows.length,
      succeeded: 0,
      failed: 0,
      remaining: dryRun ? remainingBefore : 0,
      dryRun,
    });
  }

  const embedConfig = await buildEmbedConfig(c.env);
  if (!embedConfig) {
    return respondError(
      c,
      new ServiceUnavailableError("Embedding provider not configured", {
        code: "embed_unavailable",
      }),
    );
  }
  let persistedIds: string[] = [];

  const inputs: EmbedReleaseInput[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    content: r.content,
    summary: r.summary,
    version: r.version,
    publishedAt: r.publishedAt,
    sourceId: r.sourceId,
    orgId: r.orgId,
    productId: r.productId,
    category: r.category,
    type: r.type,
  }));

  await embedAndUpsertReleases({
    releases: inputs,
    vectorIndex: asSharedIndex(c.env.RELEASES_INDEX),
    embedConfig,
    onPersisted: async (ids) => {
      persistedIds = ids;
      const now = new Date().toISOString();
      // D1 has a ~100 param limit per statement; chunk conservatively.
      for (let i = 0; i < ids.length; i += 50) {
        const slice = ids.slice(i, i + 50);
        // oxlint-disable-next-line no-await-in-loop -- D1 chunked update (100 bind param limit)
        await db.update(releases).set({ embeddedAt: now }).where(inArray(releases.id, slice));
      }
    },
  });

  const remaining = Math.max(remainingBefore - persistedIds.length, 0);
  return c.json({
    processed: rows.length,
    succeeded: persistedIds.length,
    failed: rows.length - persistedIds.length,
    remaining,
  });
});

// ── POST /workflows/embed-entities ───────────────────────────────────────────

function urlHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

interface EmbedEntitiesBody {
  kind?: EntityKind;
  limit?: number;
  dryRun?: boolean;
}

workflowsRoutes.post("/workflows/embed-entities", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<EmbedEntitiesBody>(c);
  const limit = clampLimit(body.limit);
  const dryRun = body.dryRun === true;
  const kindFilter: EntityKind | undefined = body.kind;

  // Pull from orgs, products, sources (respecting the optional `kind` filter).
  // Inputs are built to a uniform shape so `embedAndUpsertEntities` can handle
  // them in one batch — all three share ENTITIES_INDEX.
  const entities: EmbedEntityInput[] = [];

  async function fetchUnembedded(kind: EntityKind, n: number): Promise<void> {
    if (n <= 0) return;
    if (kind === "org") {
      const rows = await db
        .select()
        .from(organizations)
        .where(
          and(
            isNull(organizations.embeddedAt),
            sql`EXISTS (
              SELECT 1 FROM sources_visible sv
              WHERE sv.org_id = ${organizations.id}
            )`,
          ),
        )
        .limit(n);
      for (const r of rows) {
        // For orgs, `orgId` points at themselves so scope=org filters match.
        entities.push({
          id: r.id,
          kind,
          name: r.name,
          description: r.description,
          category: r.category,
          domain: r.domain,
          orgId: r.id,
        });
      }
      return;
    }
    if (kind === "product") {
      const rows = await db
        .select()
        .from(products)
        .where(
          and(
            isNull(products.embeddedAt),
            sql`EXISTS (
              SELECT 1 FROM sources_visible sv
              WHERE sv.product_id = ${products.id}
            )`,
          ),
        )
        .limit(n);
      for (const r of rows) {
        entities.push({
          id: r.id,
          kind,
          name: r.name,
          description: r.description,
          category: r.category,
          domain: null,
          orgId: r.orgId,
        });
      }
      return;
    }
    if (kind === "source") {
      const rows = await db
        .select()
        .from(sourcesVisible)
        .where(isNull(sourcesVisible.embeddedAt))
        .limit(n);
      for (const r of rows) {
        entities.push({
          id: r.id,
          kind,
          name: r.name,
          description: null,
          category: null,
          domain: urlHost(r.url),
          orgId: r.orgId,
        });
      }
      return;
    }
    // collection — include visible member names (orgs and products) so the
    // embedded text covers the topical coverage of the collection, not just
    // its description. Products are joined through productsActive so
    // soft-deleted products don't leak; orgs go through organizationsPublic.
    const cols = await db
      .select()
      .from(collections)
      .where(sql`${collections.embeddedAt} IS NULL`)
      .limit(n);
    if (cols.length === 0) return;
    const colIds = cols.map((col) => col.id);
    const [orgMemberRows, productMemberRows] = await Promise.all([
      db
        .select({
          collectionId: collectionMembers.collectionId,
          name: organizationsPublic.name,
          position: collectionMembers.position,
        })
        .from(collectionMembers)
        .innerJoin(organizationsPublic, sql`${organizationsPublic.id} = ${collectionMembers.orgId}`)
        .where(inArray(collectionMembers.collectionId, colIds)),
      db
        .select({
          collectionId: collectionMembers.collectionId,
          // Concatenate "Product · Org" so the embedded text carries the
          // parent-org signal — a topical query for the org's name still
          // matches a collection that only pins one product.
          name: sql<string>`${productsActive.name} || ' · ' || ${organizationsPublic.name}`,
          position: collectionMembers.position,
        })
        .from(collectionMembers)
        .innerJoin(productsActive, sql`${productsActive.id} = ${collectionMembers.productId}`)
        .innerJoin(organizationsPublic, sql`${organizationsPublic.id} = ${productsActive.orgId}`)
        .where(inArray(collectionMembers.collectionId, colIds)),
    ]);
    const namesByCollection = new Map<string, string[]>();
    // Sort the combined list by position so the embed input stays stable
    // across runs regardless of which kinds the collection mixes.
    const grouped = [...orgMemberRows, ...productMemberRows].toSorted(
      (a, b) => a.position - b.position,
    );
    for (const m of grouped) {
      const arr = namesByCollection.get(m.collectionId) ?? [];
      arr.push(m.name);
      namesByCollection.set(m.collectionId, arr);
    }
    for (const col of cols) {
      entities.push({
        id: col.id,
        kind: "collection",
        name: col.name,
        description: col.description,
        memberNames: namesByCollection.get(col.id) ?? [],
      });
    }
  }

  async function countUnembeddedKind(kind: EntityKind): Promise<number> {
    // Mirror fetchUnembedded's visibility filters so the "remaining" count only
    // includes rows that will actually be embedded (a hidden/source-less entity
    // is never fetched, so it must not inflate the backlog forever).
    if (kind === "org") {
      const [{ n }] = await db
        .select({ n: count() })
        .from(organizations)
        .where(
          and(
            isNull(organizations.embeddedAt),
            sql`EXISTS (SELECT 1 FROM sources_visible sv WHERE sv.org_id = ${organizations.id})`,
          ),
        );
      return n;
    }
    if (kind === "product") {
      const [{ n }] = await db
        .select({ n: count() })
        .from(products)
        .where(
          and(
            isNull(products.embeddedAt),
            sql`EXISTS (SELECT 1 FROM sources_visible sv WHERE sv.product_id = ${products.id})`,
          ),
        );
      return n;
    }
    if (kind === "source") {
      const [{ n }] = await db
        .select({ n: count() })
        .from(sourcesVisible)
        .where(isNull(sourcesVisible.embeddedAt));
      return n;
    }
    const [{ n }] = await db
      .select({ n: count() })
      .from(collections)
      .where(sql`${collections.embeddedAt} IS NULL`);
    return n;
  }

  if (kindFilter) {
    await fetchUnembedded(kindFilter, limit);
  } else {
    // Round-robin-ish: give each kind up to limit/4, then refill from what's
    // left. Keeps backfill balanced across tables. Collections are typically
    // tiny (<100 rows) so the quota mostly goes to org/product/source.
    const quarter = Math.max(1, Math.floor(limit / 4));
    await fetchUnembedded("org", quarter);
    await fetchUnembedded("product", quarter);
    await fetchUnembedded("collection", quarter);
    await fetchUnembedded("source", limit - entities.length);
  }

  const remainingBefore = kindFilter
    ? await countUnembeddedKind(kindFilter)
    : (
        await Promise.all([
          countUnembeddedKind("org"),
          countUnembeddedKind("product"),
          countUnembeddedKind("source"),
          countUnembeddedKind("collection"),
        ])
      ).reduce((a, b) => a + b, 0);

  if (entities.length === 0 || dryRun) {
    return c.json({
      processed: entities.length,
      succeeded: 0,
      failed: 0,
      remaining: dryRun ? remainingBefore : 0,
      dryRun,
    });
  }

  const embedConfig = await buildEmbedConfig(c.env);
  if (!embedConfig) {
    return respondError(
      c,
      new ServiceUnavailableError("Embedding provider not configured", {
        code: "embed_unavailable",
      }),
    );
  }
  let persistedIds: string[] = [];

  await embedAndUpsertEntities({
    entities,
    vectorIndex: asSharedIndex(c.env.ENTITIES_INDEX),
    embedConfig,
    onPersisted: async (ids) => {
      persistedIds = ids;
      const now = new Date().toISOString();
      // Partition ids by kind from the in-memory batch so we issue one
      // UPDATE per table rather than guessing from the id prefix.
      const kindById = new Map(entities.map((e) => [e.id, e.kind]));
      const partitions: Record<EntityKind, string[]> = {
        org: [],
        product: [],
        source: [],
        collection: [],
      };
      for (const id of ids) {
        const kind = kindById.get(id);
        if (kind) partitions[kind].push(id);
      }
      if (partitions.org.length > 0) {
        await db
          .update(organizations)
          .set({ embeddedAt: now })
          .where(inArray(organizations.id, partitions.org));
      }
      if (partitions.product.length > 0) {
        await db
          .update(products)
          .set({ embeddedAt: now })
          .where(inArray(products.id, partitions.product));
      }
      if (partitions.source.length > 0) {
        await db
          .update(sources)
          .set({ embeddedAt: now })
          .where(inArray(sources.id, partitions.source));
      }
      if (partitions.collection.length > 0) {
        await db
          .update(collections)
          .set({ embeddedAt: now })
          .where(inArray(collections.id, partitions.collection));
      }
    },
  });

  const remaining = Math.max(remainingBefore - persistedIds.length, 0);
  return c.json({
    processed: entities.length,
    succeeded: persistedIds.length,
    failed: entities.length - persistedIds.length,
    remaining,
  });
});

// ── POST /workflows/embed-changelogs ─────────────────────────────────────────

interface EmbedChangelogsBody {
  sourceSlug?: string;
  limit?: number;
  dryRun?: boolean;
}

workflowsRoutes.post("/workflows/embed-changelogs", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<EmbedChangelogsBody>(c);
  const limit = clampLimit(body.limit);
  const dryRun = body.dryRun === true;

  // Find changelog files that have unembedded chunks (vector_id IS NULL) OR
  // have no chunk rows at all (fresh file, never chunked). We process whole
  // files at a time — the embed-changelog-pipeline needs the full content to
  // diff against existing chunks.
  const fileConditions = [] as ReturnType<typeof eq>[];
  if (body.sourceSlug) {
    const [src] = await db.select().from(sources).where(eq(sources.slug, body.sourceSlug)).limit(1);
    if (!src) {
      return respondError(c, new NotFoundError(`source not found: ${body.sourceSlug}`));
    }
    fileConditions.push(eq(sourceChangelogFiles.sourceId, src.id));
  }

  // A file needs work if ANY of its chunks have `vector_id IS NULL`, or if
  // it has zero chunks (never been embedded). The predicate runs in SQL
  // via HAVING (NEEDS_WORK_HAVING) so LIMIT only counts qualifying files.
  const whereClause = fileConditions.length > 0 ? and(...fileConditions) : undefined;
  const baseSelect = {
    file: sourceChangelogFiles,
    nullChunks: sql<number>`SUM(CASE WHEN ${sourceChangelogChunks.vectorId} IS NULL THEN 1 ELSE 0 END)`,
    totalChunks: sql<number>`COUNT(${sourceChangelogChunks.id})`,
  };
  const todo = await db
    .select(baseSelect)
    .from(sourceChangelogFiles)
    .leftJoin(
      sourceChangelogChunks,
      eq(sourceChangelogChunks.sourceChangelogFileId, sourceChangelogFiles.id),
    )
    .where(whereClause)
    .groupBy(sourceChangelogFiles.id)
    .having(NEEDS_WORK_HAVING)
    .limit(limit);

  // Remaining: total files that still need work (same predicate, no LIMIT).
  const allFileRows = await db
    .select(baseSelect)
    .from(sourceChangelogFiles)
    .leftJoin(
      sourceChangelogChunks,
      eq(sourceChangelogChunks.sourceChangelogFileId, sourceChangelogFiles.id),
    )
    .where(whereClause)
    .groupBy(sourceChangelogFiles.id)
    .having(NEEDS_WORK_HAVING);

  const remainingBefore = allFileRows.length;

  if (todo.length === 0 || dryRun) {
    return c.json({
      processed: todo.length,
      succeeded: 0,
      failed: 0,
      remaining: remainingBefore,
      dryRun,
    });
  }

  const embedConfig = await buildEmbedConfig(c.env);
  if (!embedConfig) {
    return respondError(
      c,
      new ServiceUnavailableError("Embedding provider not configured", {
        code: "embed_unavailable",
      }),
    );
  }
  let succeeded = 0;
  let failed = 0;

  for (const row of todo) {
    const file = row.file;
    // oxlint-disable-next-line no-await-in-loop -- sequential per-file embed; each file's chunk state feeds embedAndUpsertChangelogFile
    const existingChunks = await db
      .select({
        id: sourceChangelogChunks.id,
        offset: sourceChangelogChunks.offset,
        contentHash: sourceChangelogChunks.contentHash,
        vectorId: sourceChangelogChunks.vectorId,
      })
      .from(sourceChangelogChunks)
      .where(eq(sourceChangelogChunks.sourceChangelogFileId, file.id));

    // Use throwOnError so a Vectorize-side failure (chunks left at
    // vectorId=null) reports as `failed`. The backfill route exists
    // specifically to set vectorIds, so "D1 staged but vectors never
    // committed" should not count as a success.
    try {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-file embed to avoid flooding the embedding provider
      await embedAndUpsertChangelogFile({
        file: {
          id: file.id,
          sourceId: file.sourceId,
          content: file.content,
          contentHash: file.contentHash,
        },
        existingChunks,
        vectorIndex: asSharedIndex(c.env.CHANGELOG_CHUNKS_INDEX),
        embedConfig,
        throwOnError: true,
        onDiff: async ({ diff }) => {
          await applyOnDiff(db, {
            fileId: file.id,
            sourceId: file.sourceId,
            diff,
          });
        },
        onVectorsCommitted: async ({ committed }) => {
          await setChunkVectorIds(db, {
            fileId: file.id,
            now: new Date().toISOString(),
            embedded: committed,
          });
        },
      });
      succeeded += 1;
    } catch {
      failed += 1;
    }
  }

  return c.json({
    processed: todo.length,
    succeeded,
    failed,
    remaining: Math.max(remainingBefore - succeeded, 0),
  });
});

// ── Discovery triggers ────────────────────────────────────────────────────────
//
// Kick off onboard / update sessions on the discovery worker. Session reads go
// through `/v1/sessions/:id` — no separate status endpoint here.

async function proxyToDiscovery(c: Context<Env>, path: string, body: string): Promise<Response> {
  if (!c.env.DISCOVERY_WORKER) {
    return respondError(c, new ServiceUnavailableError("Discovery worker not configured"));
  }
  // Service bindings require a full URL; the host is ignored.
  return c.env.DISCOVERY_WORKER.fetch(
    new Request(`https://discovery${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: c.req.header("Authorization") ?? "",
      },
      body,
    }),
  );
}

// ── POST /workflows/cluster-changesets ───────────────────────────────────────
// Backfill changesets-cascade coverage links for releases that pre-date the
// ingest-time clusterer or arrived split across batches. Scoped by source or
// org to keep blast radius small; `dryRun` reports what *would* link without
// writing. Releases already on the coverage side are excluded — auto-decisions
// never overwrite an existing link (the writer uses onConflictDoNothing).

interface ClusterChangesetsBody {
  sourceId?: string;
  orgId?: string;
  /** Lookback window in days. Default 90, max 365. */
  sinceDays?: number;
  /** Max releases to load per call. Default 500, max 2000. */
  limit?: number;
  dryRun?: boolean;
  /**
   * Delete existing `system:changesets` coverage rows in scope before
   * re-clustering. Use when refining the clusterer to recover releases
   * that were previously demoted by older logic; manual coverage links
   * (decided_by != system:changesets) are untouched.
   */
  unlinkFirst?: boolean;
}

const CLUSTER_CHANGESETS_LIMIT_DEFAULT = 500;
const CLUSTER_CHANGESETS_LIMIT_MAX = 2000;
const CLUSTER_CHANGESETS_SINCE_DEFAULT = 90;
const CLUSTER_CHANGESETS_SINCE_MAX = 365;

function coerceInt(value: unknown, fallback: number): number {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

workflowsRoutes.post("/workflows/cluster-changesets", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<ClusterChangesetsBody>(c);

  if (!body.sourceId && !body.orgId) {
    return respondError(
      c,
      new ValidationError("Provide sourceId or orgId to scope the backfill", {
        code: "bad_request",
      }),
    );
  }

  // Body is untyped JSON — coerce numerics and fall back to defaults on
  // missing or non-finite input so a malformed payload can't yield NaN
  // through to daysAgoIso(...) or .limit(...). Null/undefined and blank
  // strings count as "missing" and take the fallback rather than
  // coercing to 0 (which would otherwise clamp to the floor of 1).
  const sinceDays = Math.min(
    Math.max(coerceInt(body.sinceDays, CLUSTER_CHANGESETS_SINCE_DEFAULT), 1),
    CLUSTER_CHANGESETS_SINCE_MAX,
  );
  const limit = Math.min(
    Math.max(coerceInt(body.limit, CLUSTER_CHANGESETS_LIMIT_DEFAULT), 1),
    CLUSTER_CHANGESETS_LIMIT_MAX,
  );
  const since = daysAgoIso(sinceDays);
  const dryRun = body.dryRun === true;
  const unlinkFirst = body.unlinkFirst === true && !dryRun;

  // Optional: clear prior `system:changesets` decisions in scope so the
  // re-cluster pass operates on a clean slate. Used after clusterer logic
  // changes to recover releases incorrectly demoted by older runs. Manual
  // links (decided_by != system:changesets) are untouched.
  let unlinkedRows = 0;
  if (unlinkFirst) {
    // Select the release IDs in scope, then delete system:changesets
    // coverage rows that point at any of them. Two-step (vs. one DELETE
    // with subquery) so the same code works against the bun:sqlite test
    // shim, which only exercises basic drizzle ops.
    const scopeConditions = [gte(releases.publishedAt, since)];
    if (body.sourceId) scopeConditions.push(eq(releases.sourceId, body.sourceId));
    const scopedIdRows = body.orgId
      ? await db
          .select({ id: releases.id })
          .from(releases)
          .leftJoin(sources, eq(releases.sourceId, sources.id))
          .where(and(...scopeConditions, eq(sources.orgId, body.orgId)))
      : await db
          .select({ id: releases.id })
          .from(releases)
          .where(and(...scopeConditions));
    const scopedIds = scopedIdRows.map((r) => r.id);
    if (scopedIds.length > 0) {
      for (let i = 0; i < scopedIds.length; i += IN_ARRAY_CHUNK_SIZE) {
        const chunk = scopedIds.slice(i, i + IN_ARRAY_CHUNK_SIZE);
        // oxlint-disable-next-line no-await-in-loop -- D1 bind-param chunked delete
        const deleted = await db
          .delete(releaseCoverage)
          .where(
            and(
              eq(releaseCoverage.decidedBy, DECIDED_BY_CHANGESETS),
              inArray(releaseCoverage.coverageId, chunk),
            ),
          )
          .returning({ id: releaseCoverage.coverageId });
        unlinkedRows += deleted.length;
      }
    }
    logEvent("info", {
      component: "workflows-cluster-changesets",
      event: "unlinked-prior",
      sourceId: body.sourceId,
      orgId: body.orgId,
      unlinkedRows,
    });
  }

  // Exclude releases already linked as coverage — their cluster decision
  // is settled. Canonical-side rows stay eligible so newly-arrived siblings
  // can be attached to existing clusters. Anti-join via `LEFT JOIN ... IS
  // NULL` because SQLite doesn't rewrite `NOT IN (subquery)` to an anti-join.
  const conditions = [gte(releases.publishedAt, since), sql`${releaseCoverage.coverageId} IS NULL`];
  if (body.sourceId) conditions.push(eq(releases.sourceId, body.sourceId));
  if (body.orgId) conditions.push(eq(sources.orgId, body.orgId));

  const rows = await db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      version: releases.version,
      content: releases.content,
    })
    .from(releases)
    .leftJoin(sources, eq(releases.sourceId, sources.id))
    .leftJoin(releaseCoverage, eq(releaseCoverage.coverageId, releases.id))
    .where(and(...conditions))
    .orderBy(desc(releases.publishedAt))
    .limit(limit);

  // Group by source — cascades are scoped to a single source.
  const bySource = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = bySource.get(r.sourceId) ?? [];
    list.push(r);
    bySource.set(r.sourceId, list);
  }

  let totalClusters = 0;
  let coverage = 0;
  const allHashes: string[] = [];

  for (const [sourceId, sourceRows] of bySource) {
    if (sourceRows.length < 2) continue;
    if (dryRun) {
      // Re-use the pure clusterer directly for dry-run accounting so we
      // don't touch the table.
      const clusters = clusterChangesets(
        sourceRows.map((r) => ({ id: r.id, version: r.version, content: r.content })),
      );
      totalClusters += clusters.length;
      coverage += clusters.reduce((n, cl) => n + cl.coverageIds.length, 0);
      for (const cl of clusters) allHashes.push(cl.hash);
      continue;
    }
    // oxlint-disable-next-line no-await-in-loop -- per-source serialization keeps memory bounded; cluster work is tiny per call
    const result = await clusterAndPersistCascades(
      db,
      sourceRows.map((r) => ({ id: r.id, version: r.version, content: r.content })),
      { component: "workflows-cluster-changesets", sourceId },
    );
    totalClusters += result.clusters;
    coverage += result.coverageIds.size;
    allHashes.push(...result.hashes);
  }

  return c.json({
    processed: rows.length,
    sources: bySource.size,
    clusters: totalClusters,
    coverage,
    hashes: allHashes,
    dryRun,
    unlinkFirst,
    unlinkedRows,
    sinceDays,
  });
});

// ── POST /workflows/batch-summarize ──────────────────────────────────────────
//
// Admin trigger for the BatchSummarizeWorkflow. Runs unconditionally (caller
// made a deliberate decision); the cron path self-gates via BATCH_SUMMARIZE_ENABLED.
//
// Body: { sinceDays?, orgs?, maxCostUsd? }  (all optional)
// Returns: { instanceId, statusUrl }

interface BatchSummarizeBody {
  sinceDays?: number;
  orgs?: string[];
  maxCostUsd?: number;
}

workflowsRoutes.post("/workflows/batch-summarize", async (c) => {
  const body = await parseJsonBody<BatchSummarizeBody>(c);

  if (!c.env.BATCH_SUMMARIZE_WORKFLOW) {
    return respondError(
      c,
      new ServiceUnavailableError("BATCH_SUMMARIZE_WORKFLOW binding not configured"),
    );
  }

  const scheduledTime = Date.now();
  const params = {
    scheduledTime,
    trigger: "admin" as const,
    sinceDays: typeof body.sinceDays === "number" && body.sinceDays > 0 ? body.sinceDays : 1,
    orgs: Array.isArray(body.orgs) && body.orgs.length > 0 ? body.orgs : undefined,
    maxCostUsd:
      typeof body.maxCostUsd === "number" && body.maxCostUsd > 0 ? body.maxCostUsd : undefined,
  };

  const instance = await c.env.BATCH_SUMMARIZE_WORKFLOW.create({
    id: `batch-summarize-admin-${scheduledTime}`,
    params,
  });

  const instanceId: string = (instance as unknown as { id: string }).id;

  logEvent("info", {
    component: "batch-summarize",
    event: "admin-trigger",
    instanceId,
    sinceDays: params.sinceDays,
    orgs: params.orgs,
    maxCostUsd: params.maxCostUsd,
  });

  return c.json({
    instanceId,
    statusUrl: `${c.env.ADMIN_BASE_URL ?? ""}/v1/workflows/batch-summarize/status/${instanceId}`,
  });
});

// ── GET /workflows/batch-summarize/status/:instanceId ────────────────────────
//
// Resolves the `statusUrl` returned by the POST trigger above. Thin pass-through
// to Cloudflare's `WorkflowInstance.status()` so operators can poll workflow
// state without dashboard access.

// Cloudflare Workflows doesn't export a NotFoundError class; `binding.get()`
// throws a generic Error with "not found" / "does not exist" in the message
// when the instance ID is unknown. Anything else from `get()` or `status()`
// (network blip, runtime failure) should surface as 500, not 404.
const WORKFLOW_NOT_FOUND_RE = /not\s*found|does\s+not\s+exist/i;

workflowsRoutes.get("/workflows/batch-summarize/status/:instanceId", async (c) => {
  const binding = c.env.BATCH_SUMMARIZE_WORKFLOW;
  if (!binding) {
    return respondError(
      c,
      new ServiceUnavailableError("BATCH_SUMMARIZE_WORKFLOW binding not configured"),
    );
  }
  const instanceId = c.req.param("instanceId");
  try {
    const instance = await binding.get(instanceId);
    const status = await instance.status();
    return c.json({ instanceId, ...status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (WORKFLOW_NOT_FOUND_RE.test(message)) {
      return respondError(c, new NotFoundError(message, { code: "instance_not_found" }));
    }
    logEvent("error", {
      component: "workflows-batch-summarize-status",
      event: "lookup-failed",
      instanceId,
      err: err instanceof Error ? err : String(err),
    });
    return respondError(c, new InternalError(message));
  }
});

// ── POST /workflows/overview-regen ───────────────────────────────────────────
//
// Admin manual trigger for the OverviewRegenWorkflow. Runs unconditionally
// (no flag gate) so operators can smoke-test staging where the flag is off;
// the workflow itself gates the cron path.
//
// Body: { orgs?, dryRun?, maxOrgs?, force? }  (all optional)
// `force` re-generates the listed orgs even with no new releases (a re-run
// after a generation fix) and REQUIRES a non-empty `orgs` list.
// Returns: { instanceId, statusUrl }

interface OverviewRegenBody {
  orgs?: string[];
  dryRun?: boolean;
  maxOrgs?: number;
  force?: boolean;
}

workflowsRoutes.post("/workflows/overview-regen", async (c) => {
  const body = await parseJsonBody<OverviewRegenBody>(c);

  if (!c.env.OVERVIEW_REGEN_WORKFLOW) {
    return respondError(
      c,
      new ServiceUnavailableError("OVERVIEW_REGEN_WORKFLOW binding not configured"),
    );
  }

  let validOrgs: string[] | undefined;
  if (body.orgs !== undefined) {
    if (!Array.isArray(body.orgs)) {
      return respondError(
        c,
        new ValidationError("`orgs` must be an array of strings", { code: "bad_request" }),
      );
    }
    validOrgs = body.orgs
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    if (validOrgs.length === 0) {
      return respondError(
        c,
        new ValidationError("`orgs` must contain at least one non-empty string", {
          code: "bad_request",
        }),
      );
    }
  }

  // `force` lifts the "≥1 new release" eligibility guard, so it must be scoped
  // to an explicit org list — never allowed to fan out across every org.
  const force = body.force === true;
  if (force && (!validOrgs || validOrgs.length === 0)) {
    return respondError(
      c,
      new ValidationError("`force` requires a non-empty `orgs` list", { code: "bad_request" }),
    );
  }

  const scheduledTime = Date.now();
  const params = {
    scheduledTime,
    trigger: "admin" as const,
    orgs: validOrgs,
    dryRun: body.dryRun === true,
    maxOrgs: typeof body.maxOrgs === "number" && body.maxOrgs > 0 ? body.maxOrgs : undefined,
    force,
  };

  const instance = await c.env.OVERVIEW_REGEN_WORKFLOW.create({
    id: `overview-regen-admin-${scheduledTime}`,
    params,
  });
  const instanceId: string = (instance as unknown as { id: string }).id;

  logEvent("info", {
    component: "overview-regen",
    event: "admin-trigger",
    instanceId,
    orgs: params.orgs,
    dryRun: params.dryRun,
    maxOrgs: params.maxOrgs,
    force: params.force,
  });

  return c.json({
    instanceId,
    statusUrl: `${c.env.ADMIN_BASE_URL ?? ""}/v1/workflows/overview-regen/status/${instanceId}`,
  });
});

// ── GET /workflows/overview-regen/status/:instanceId ─────────────────────────
//
// Thin pass-through to Cloudflare's `WorkflowInstance.status()` (same shape as
// the other workflow status endpoints).

workflowsRoutes.get("/workflows/overview-regen/status/:instanceId", async (c) => {
  const binding = c.env.OVERVIEW_REGEN_WORKFLOW;
  if (!binding) {
    return respondError(
      c,
      new ServiceUnavailableError("OVERVIEW_REGEN_WORKFLOW binding not configured"),
    );
  }
  const instanceId = c.req.param("instanceId");
  try {
    const instance = await binding.get(instanceId);
    const status = await instance.status();
    return c.json({ instanceId, ...status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (WORKFLOW_NOT_FOUND_RE.test(message)) {
      return respondError(c, new NotFoundError(message, { code: "instance_not_found" }));
    }
    logEvent("error", {
      component: "workflows-overview-regen-status",
      event: "lookup-failed",
      instanceId,
      err: err instanceof Error ? err : String(err),
    });
    return respondError(c, new InternalError(message));
  }
});

workflowsRoutes.post("/workflows/discover", async (c) => {
  const body = await c.req.text();
  const res = await proxyToDiscovery(c, "/onboard", body);
  return new Response(res.body, { status: res.status, headers: res.headers });
});

// Deterministic update runs no longer proxy to discovery (#1946): dispatch is
// the shared `startDeterministicUpdate` gate (kill switch → spend cap →
// per-source lock) and execution is the DETERMINISTIC_UPDATE workflow in this
// worker. The wire contract is unchanged: 202 {sessionId, status: "running",
// sourceIdentifiers}, 400 validation, 409 + Retry-After on lock contention,
// 429 spend cap, 503 kill switch / unbound workflow. Admin scope is enforced
// by the /workflows namespace middleware (route-namespaces.ts).
workflowsRoutes.post("/workflows/update", async (c) => {
  let body: {
    company?: string;
    sourceIdentifiers?: string[];
    /** @deprecated legacy alias for sourceIdentifiers */
    sourceSlugs?: string[];
    orgId?: string;
    correlationId?: string;
  };
  try {
    body = await c.req.json();
  } catch {
    return respondError(c, new ValidationError("Invalid JSON body", { code: "invalid_json" }));
  }

  const identifiers = body.sourceIdentifiers ?? body.sourceSlugs;
  const result = await startDeterministicUpdate(c.env, {
    company: body.company as string,
    sourceIdentifiers: identifiers as string[],
    orgId: body.orgId,
    correlationId: body.correlationId,
  });

  if (!result.ok) {
    switch (result.reason) {
      case "invalid":
        return respondError(c, new ValidationError(result.message));
      case "locked": {
        const retryAfter = result.retryAfterSeconds ?? 900;
        const res = respondError(
          c,
          new ConflictError(result.message, {
            details: { retryAfterSeconds: retryAfter },
          }),
        );
        res.headers.set("Retry-After", String(retryAfter));
        return res;
      }
      case "spend_cap":
        return respondError(c, new RateLimitedError(result.message));
      case "kill_switch":
      case "unavailable":
        return respondError(c, new ServiceUnavailableError(result.message));
    }
  }

  return c.json(
    { sessionId: result.sessionId, status: "running", sourceIdentifiers: identifiers },
    202,
  );
});

// ── POST /workflows/enrich-feed-content ──────────────────────────────────────
//
// Operator-triggered backfill: re-enrich already-stored thin releases for a
// given source. Resolves thin un-enriched candidates, enriches up to `limit`,
// updates rows (nulling summary/titleGenerated/titleShort/embeddedAt), then
// calls generateContentForReleases for the richer body.
//
// Body: { sourceId?, sourceSlug?, limit?, dryRun? }
// Returns: { source, scanned, enriched, skipped, failed, dryRun }

interface EnrichBackfillOpts {
  limit: number;
  dryRun: boolean;
  thinChars: number;
}

interface EnrichBackfillDeps {
  enrichFn: (item: { url: string; title: string; summary: string }) => Promise<EnrichResult>;
  regenerate: (ids: string[]) => Promise<void>;
}

export interface EnrichBackfillReport {
  scanned: number;
  enriched: number;
  skipped: number;
  dryRun: boolean;
}

export async function runEnrichBackfill(
  db: ReturnType<typeof createDb>,
  sourceId: string,
  opts: EnrichBackfillOpts,
  deps: EnrichBackfillDeps,
): Promise<EnrichBackfillReport> {
  // Thin releases that haven't been successfully enriched (shared with the async
  // BatchEnrichWorkflow so the candidate filter stays in one place).
  const candidates = await selectEnrichCandidates(db, {
    sourceIds: [sourceId],
    limit: opts.limit,
    thinChars: opts.thinChars,
  });

  const report: EnrichBackfillReport = {
    scanned: candidates.length,
    enriched: 0,
    skipped: 0,
    dryRun: opts.dryRun,
  };
  if (opts.dryRun) return report;

  const enrichedIds: string[] = [];
  for (const row of candidates) {
    const attemptedAt = new Date().toISOString();
    // oxlint-disable-next-line no-await-in-loop -- bounded by `limit`
    const res = await deps.enrichFn({ url: row.url!, title: row.title, summary: row.content });
    if (res.status !== "enriched" || !res.content) {
      report.skipped++;
      // oxlint-disable-next-line no-await-in-loop
      await db
        .update(releases)
        .set({ metadata: mergeEnrichmentMarker(row.metadata, { attemptedAt, succeeded: false }) })
        .where(eq(releases.id, row.id));
      continue;
    }
    const size = computeContentSize(res.content);
    // Only backfill media from the article when the release has none — never
    // clobber existing feed / curated images.
    const mediaJson =
      !hasStoredMedia(row.media) && res.media && res.media.length > 0
        ? JSON.stringify(
            // oxlint-disable-next-line no-map-spread
            res.media.map((m) => ({ ...m, url: normalizeMediaUrl(m.url) })),
          )
        : undefined;
    // oxlint-disable-next-line no-await-in-loop
    await db
      .update(releases)
      .set({
        content: res.content,
        contentChars: size.contentChars,
        contentTokens: size.contentTokens,
        contentHash: contentHash({
          title: row.title,
          version: row.version ?? undefined,
          publishedAt: row.publishedAt ? new Date(row.publishedAt) : undefined,
          content: res.content,
        }),
        ...(mediaJson !== undefined ? { media: mediaJson } : {}),
        metadata: mergeEnrichmentMarker(row.metadata, {
          attemptedAt,
          succeeded: true,
          via: res.via,
        }),
        // Force summary + embedding refresh on the richer body.
        summary: null,
        titleGenerated: null,
        titleShort: null,
        embeddedAt: null,
      })
      .where(eq(releases.id, row.id));
    report.enriched++;
    enrichedIds.push(row.id);
  }

  if (enrichedIds.length > 0) await deps.regenerate(enrichedIds);
  return report;
}

interface EnrichFeedContentBody {
  sourceId?: string;
  sourceSlug?: string;
  limit?: number;
  dryRun?: boolean;
}

workflowsRoutes.post("/workflows/enrich-feed-content", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<EnrichFeedContentBody>(c);

  const ident = body.sourceId?.trim() || body.sourceSlug?.trim();
  if (!ident) {
    return respondError(
      c,
      new ValidationError("Provide `sourceId` or `sourceSlug`", { code: "bad_request" }),
    );
  }
  // Bare slugs are ambiguous across orgs post-#690 (per-org slug uniqueness), so
  // require a typed `src_…` ID. Resolve a slug via the org-scoped detail route or
  // /v1/lookups/source-by-slug first.
  if (!isSourceId(ident)) {
    return respondError(
      c,
      new ValidationError(
        "Pass a typed source ID (src_…). Bare slugs are ambiguous across orgs — resolve via /v1/orgs/{orgSlug}/sources/{sourceSlug} or /v1/lookups/source-by-slug first.",
        { code: "bare_slug_rejected" },
      ),
    );
  }
  const [src] = await db
    .select({ id: sources.id, slug: sources.slug, name: sources.name, orgId: sources.orgId })
    .from(sources)
    .where(sourceMatchByIdOrSlug(ident));
  if (!src) return respondError(c, new NotFoundError("Source not found"));

  const rawLimit = Number(body.limit ?? 25);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(Math.floor(rawLimit), 1), 200) : 25;
  const dryRun = body.dryRun !== false; // default to a dry run for safety
  const thinChars = parsePositiveInt(c.env.FEED_THIN_CHARS, 600);

  const deps = await buildEnrichDeps(c.env, thinChars, db);
  if (!deps)
    return respondError(c, new ServiceUnavailableError("ANTHROPIC_API_KEY not configured"));

  const report = await runEnrichBackfill(
    db,
    src.id,
    { limit, dryRun, thinChars },
    {
      enrichFn: (item) => enrichFeedItem(item, deps),
      // Lazy import: poll-and-fetch.ts pulls `cloudflare:workers`, which only
      // resolves in the Workers runtime. A static import would break tooling that
      // loads the route module under plain Bun (the OpenAPI coverage check).
      // Structural cast: src is a partial {id,slug,name,orgId}; generateContentForReleases
      // only reads isHidden/orgId so the partial is safe at runtime; db and c.env are
      // cast to satisfy the typed workflow-env shape difference.
      regenerate: async (ids) => {
        const { generateContentForReleases } = await import("../workflows/poll-and-fetch.js");
        await generateContentForReleases(db as never, c.env as never, src as never, ids);
      },
    },
  );

  return c.json({ source: { id: src.id, slug: src.slug }, ...report });
});

// ── POST /workflows/generate-content ─────────────────────────────────────────
//
// Operator-triggered AI content generation: run a source's releases through the
// live summarizer lane (`generateContentForReleases` → resolveSummarizeModel) to
// populate title_generated / title_short / summary. Two modes:
//   - fill (default): only releases that have no generated content yet.
//   - regenerate: ALL eligible releases, clearing existing generated fields first
//     (the primitive's UPDATE is `title_generated IS NULL`-guarded, i.e. fill-only,
//     so a regenerate has to NULL them so they get repopulated).
//
// Unlike the cron/ingest path this is decoupled from a fetch — it generates
// content for releases that already exist. Respects the same eligibility gate as
// the cron (org `auto_generate_content` + per-source `metadata.summarize`), so a
// non-opted org yields zero candidates. Synchronous; cap via `limit`.
//
// Body: { sourceId? | sourceSlug?, releaseIds?, regenerate?, ignoreAutoGate?, limit?, dryRun? }
// Returns: { source, scanned, generated, regenerate, dryRun }

interface GenerateContentBody {
  sourceId?: string;
  sourceSlug?: string;
  releaseIds?: string[];
  regenerate?: boolean;
  ignoreAutoGate?: boolean;
  limit?: number;
  dryRun?: boolean;
}

/** Per-invocation row cap — the route's `limit` clamp and the post-fetch
 *  auto-fill in routes/sources.ts (#1579) share this bound. */
export const GENERATE_CONTENT_MAX_LIMIT = 100;

export interface GenerateContentOpts {
  /** Restrict to these specific release ids (still source- + eligibility-scoped). */
  releaseIds?: string[];
  /** Clear + re-summarize rows that already have generated content. */
  regenerate: boolean;
  /** Drop the org `auto_generate_content` opt-in (force generation). The
   *  per-source `metadata.summarize=false` opt-out is still honored. Default false. */
  ignoreAutoGate?: boolean;
  limit: number;
  dryRun: boolean;
}

export interface GenerateContentReport {
  /** Candidate releases selected (and, when not a dry run, handed to `generate`). */
  scanned: number;
  /** Candidates carrying generated content after the run (0 on dry runs). */
  generated: number;
  regenerate: boolean;
  dryRun: boolean;
}

export interface GenerateContentDeps {
  /** Summarize the given release ids and return how many got generated content —
   *  the route wraps `generateContentForReleases`, which reports that count. */
  generate: (ids: string[]) => Promise<number>;
}

/**
 * Testable core of POST /workflows/generate-content. Selection mirrors
 * `generateContentForReleases`'s own SELECT (org opt-in, per-source opt-out,
 * skip coverage-side rows) so the dry-run count matches what will actually be
 * summarized. The summarizer is injected so unit tests run without AI.
 */
export async function runGenerateContent(
  db: AnyDb,
  source: { id: string },
  opts: GenerateContentOpts,
  deps: GenerateContentDeps,
): Promise<GenerateContentReport> {
  // Same eligibility gate generateContentForReleases applies internally, so the
  // dry-run count matches what it will actually summarize.
  const conds = [
    eq(releases.sourceId, source.id),
    ...summarizeEligibilityConds({ ignoreAutoGate: opts.ignoreAutoGate }),
  ];
  if (opts.releaseIds && opts.releaseIds.length > 0) {
    conds.push(inArray(releases.id, opts.releaseIds));
  }
  // Fill mode only targets rows missing generated content; regenerate takes all.
  if (!opts.regenerate) conds.push(sql`${releases.titleGenerated} IS NULL`);

  const candidates: { id: string }[] = await db
    .select({ id: releases.id })
    .from(releases)
    .innerJoin(sources, eq(sources.id, releases.sourceId))
    .innerJoin(organizations, eq(organizations.id, sources.orgId))
    .leftJoin(releaseCoverage, eq(releaseCoverage.coverageId, releases.id))
    .where(and(...conds))
    .limit(opts.limit);

  const ids = candidates.map((r) => r.id);
  const report: GenerateContentReport = {
    scanned: ids.length,
    generated: 0,
    regenerate: opts.regenerate,
    dryRun: opts.dryRun,
  };
  if (opts.dryRun || ids.length === 0) return report;

  // Regenerate: clear generated fields so the fill-only primitive repopulates them.
  if (opts.regenerate) {
    for (let i = 0; i < ids.length; i += IN_ARRAY_CHUNK_SIZE) {
      const chunk = ids.slice(i, i + IN_ARRAY_CHUNK_SIZE);
      // eslint-disable-next-line no-await-in-loop -- chunked under the D1 bind cap
      await db
        .update(releases)
        .set({ titleGenerated: null, titleShort: null, summary: null })
        .where(inArray(releases.id, chunk));
    }
  }

  // generateContentForReleases reports how many rows it populated (skipping
  // boilerplate / body-cap / errors), so no post-count query is needed.
  report.generated = await deps.generate(ids);
  return report;
}

/**
 * Standard `deps.generate` for `runGenerateContent`: the live summarizer lane,
 * chunked under MAX_AUTOGEN_ROWS_PER_FIRE (20) — generateContentForReleases
 * bails on a larger batch, same as BatchEnrichWorkflow. Shared by the route
 * below and the post-fetch auto-fill in routes/sources.ts (#1579) so
 * generate-content stays the only write path for the generated fields.
 */
export function buildGenerateContentDeps(
  db: AnyDb,
  env: Env["Bindings"],
  src: { id: string; slug: string; name: string; orgId: string; isHidden: boolean | null },
  opts: { ignoreAutoGate?: boolean } = {},
): GenerateContentDeps {
  return {
    // Lazy import: poll-and-fetch.ts pulls `cloudflare:workers`, which only
    // resolves in the Workers runtime. A static import would break tooling that
    // loads the route module under plain Bun (the OpenAPI coverage check).
    // Structural cast: src may be a partial {id,slug,name,orgId,isHidden};
    // generateContentForReleases only reads isHidden/slug/id so the partial is
    // safe at runtime; db and env are cast to satisfy the typed workflow-env
    // shape difference.
    generate: async (ids) => {
      const { generateContentForReleases } = await import("../workflows/poll-and-fetch.js");
      const GEN_CHUNK = 20;
      let total = 0;
      for (let off = 0; off < ids.length; off += GEN_CHUNK) {
        // eslint-disable-next-line no-await-in-loop -- sequential keeps inference cost bounded
        total += await generateContentForReleases(
          db as never,
          env as never,
          src as never,
          ids.slice(off, off + GEN_CHUNK),
          { ignoreAutoGenerateGate: opts.ignoreAutoGate },
        );
      }
      return total;
    },
  };
}

workflowsRoutes.post("/workflows/generate-content", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<GenerateContentBody>(c);

  const ident = body.sourceId?.trim() || body.sourceSlug?.trim();
  if (!ident) {
    return respondError(
      c,
      new ValidationError("Provide `sourceId` or `sourceSlug`", { code: "bad_request" }),
    );
  }
  // Bare slugs are ambiguous across orgs post-#690 — require a typed `src_…` ID.
  if (!isSourceId(ident)) {
    return respondError(
      c,
      new ValidationError(
        "Pass a typed source ID (src_…). Bare slugs are ambiguous across orgs — resolve via /v1/orgs/{orgSlug}/sources/{sourceSlug} or /v1/lookups/source-by-slug first.",
        { code: "bare_slug_rejected" },
      ),
    );
  }

  const [src] = await db
    .select({
      id: sources.id,
      slug: sources.slug,
      name: sources.name,
      orgId: sources.orgId,
      isHidden: sources.isHidden,
    })
    .from(sources)
    .where(sourceMatchByIdOrSlug(ident));
  if (!src) return respondError(c, new NotFoundError("Source not found"));

  const releaseIds = Array.isArray(body.releaseIds)
    ? body.releaseIds.filter((x): x is string => typeof x === "string" && x.length > 0)
    : undefined;
  const rawLimit = Number(body.limit ?? 25);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), GENERATE_CONTENT_MAX_LIMIT)
    : 25;
  const regenerate = body.regenerate === true;
  const ignoreAutoGate = body.ignoreAutoGate === true;
  const dryRun = body.dryRun !== false; // default to a dry run for safety

  const report = await runGenerateContent(
    db,
    { id: src.id },
    { releaseIds, regenerate, ignoreAutoGate, limit, dryRun },
    buildGenerateContentDeps(db, c.env, src, { ignoreAutoGate }),
  );

  return c.json({ source: { id: src.id, slug: src.slug }, ...report });
});

// ── POST /workflows/batch-enrich ─────────────────────────────────────────────
//
// Async, batched sibling of /workflows/enrich-feed-content for the render-heavy
// / JS-shell summary-only sources that the synchronous route can't finish before
// a client disconnect (#1296). Dispatches a durable BatchEnrichWorkflow: per-item
// Browser-Rendering fetch (→ R2) then ONE Anthropic Message Batch for extraction.
// Backfill-only; the steady-state forward path stays synchronous.
//
// Body: { sourceIds: string[] (typed src_…), limit?, dryRun?, maxCostUsd? }
// Returns: 202 { instanceId, async, statusUrl }

interface BatchEnrichBody {
  sourceIds?: unknown;
  limit?: number;
  dryRun?: boolean;
  maxCostUsd?: number;
}

workflowsRoutes.post("/workflows/batch-enrich", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<BatchEnrichBody>(c);

  const sourceIds = Array.isArray(body.sourceIds)
    ? body.sourceIds.map((s) => String(s).trim()).filter(Boolean)
    : [];
  if (sourceIds.length === 0) {
    return respondError(
      c,
      new ValidationError("Provide a non-empty `sourceIds` array of typed source IDs (src_…)", {
        code: "bad_request",
      }),
    );
  }
  // Bare slugs are ambiguous across orgs (per-org slug uniqueness) — require typed IDs.
  const bareSlug = sourceIds.find((id) => !isSourceId(id));
  if (bareSlug) {
    return respondError(
      c,
      new ValidationError(
        `'${bareSlug}' is not a typed source ID. Pass src_… ids; resolve slugs via /v1/lookups/source-by-slug first.`,
        { code: "bare_slug_rejected" },
      ),
    );
  }

  const existing = await db
    .select({ id: sources.id })
    .from(sources)
    .where(inArray(sources.id, sourceIds));
  const found = new Set(existing.map((r) => r.id));
  const missing = sourceIds.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return respondError(c, new NotFoundError(`Source(s) not found: ${missing.join(", ")}`));
  }

  if (!c.env.BATCH_ENRICH_WORKFLOW) {
    return respondError(
      c,
      new ServiceUnavailableError("BATCH_ENRICH_WORKFLOW binding not configured"),
    );
  }

  const rawLimit = Number(body.limit ?? BATCH_ENRICH_DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), BATCH_ENRICH_MAX_LIMIT)
    : BATCH_ENRICH_DEFAULT_LIMIT;
  const dryRun = body.dryRun !== false; // default to a dry run for safety
  const maxCostUsd =
    typeof body.maxCostUsd === "number" && body.maxCostUsd > 0 ? body.maxCostUsd : undefined;

  const scheduledTime = Date.now();
  const instance = await c.env.BATCH_ENRICH_WORKFLOW.create({
    id: `batch-enrich-${scheduledTime}`,
    params: { sourceIds, limit, dryRun, ...(maxCostUsd !== undefined ? { maxCostUsd } : {}) },
  });
  const instanceId: string = (instance as unknown as { id: string }).id;

  logEvent("info", {
    component: "batch-enrich",
    event: "workflow-dispatch",
    sourceIds,
    instanceId,
    limit,
    dryRun,
  });

  return c.json(
    {
      instanceId,
      async: true,
      statusUrl: `${c.env.ADMIN_BASE_URL ?? ""}/v1/workflows/batch-enrich/status/${instanceId}`,
    },
    202,
  );
});

// ── GET /workflows/batch-enrich/status/:instanceId ───────────────────────────
workflowsRoutes.get("/workflows/batch-enrich/status/:instanceId", async (c) => {
  if (!c.env.BATCH_ENRICH_WORKFLOW) {
    return respondError(
      c,
      new ServiceUnavailableError("BATCH_ENRICH_WORKFLOW binding not configured"),
    );
  }
  const instanceId = c.req.param("instanceId");
  try {
    const instance = await c.env.BATCH_ENRICH_WORKFLOW.get(instanceId);
    const status = await instance.status();
    return c.json({ instanceId, ...status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (WORKFLOW_NOT_FOUND_RE.test(message)) {
      return respondError(c, new NotFoundError(message, { code: "instance_not_found" }));
    }
    logEvent("error", {
      component: "workflows-batch-enrich-status",
      event: "lookup-failed",
      instanceId,
      err: err instanceof Error ? err : String(err),
    });
    return respondError(c, new InternalError(message));
  }
});

// ── POST /workflows/backfill-media ───────────────────────────────────────────
//
// Operator-triggered R2 backfill for releases stored before ingest-time R2
// mirroring was active (or while the `MEDIA` bucket binding was unbound), so
// their `media` still points at third-party URLs with no `r2Key`. The standard ingest upsert
// backfills `media` only for stored-empty rows and never overwrites populated
// media (RELEASE_URL_UPSERT), so re-fetching a source can NOT re-mirror media
// that already has URLs — this route is the only path that R2-stamps them.
//
// It re-runs the exact ingest mirror (`processMediaForR2`: junk filter →
// content-type/size gate → R2 put → registry insert → stamp `r2Key`) and writes
// the stamped media JSON back. Bounded per call; `remaining` reports how many
// rows still need backfill so the operator can loop. `dryRun` (default) reports
// the pending count without writing. Idempotent: a mirrored row has `r2Key` and
// drops out of the candidate filter.
//
// Body: { sourceId?, all?, limit?, dryRun? }

interface BackfillMediaBody {
  sourceId?: string;
  all?: boolean;
  limit?: number;
  dryRun?: boolean;
}

workflowsRoutes.post("/workflows/backfill-media", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<BackfillMediaBody>(c);

  const bucket = c.env.MEDIA;
  if (!bucket) {
    return respondError(c, new ServiceUnavailableError("MEDIA bucket not bound"));
  }

  // Scope to a typed source ID, or require an explicit `all: true` to sweep every
  // source — so a dropped/typo'd `sourceId` can't silently backfill everything.
  const ident = body.sourceId?.trim();
  if (!ident && body.all !== true) {
    return respondError(
      c,
      new ValidationError("Provide a typed `sourceId` (src_…) or `all: true`", {
        code: "bad_request",
      }),
    );
  }
  if (ident && !isSourceId(ident)) {
    return respondError(
      c,
      new ValidationError(
        "Pass a typed source ID (src_…). Resolve a slug via /v1/orgs/{orgSlug}/sources/{sourceSlug} first.",
        { code: "bare_slug_rejected" },
      ),
    );
  }

  const rawLimit = Number(body.limit ?? MEDIA_BACKFILL_DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), MEDIA_BACKFILL_MAX_LIMIT)
    : MEDIA_BACKFILL_DEFAULT_LIMIT;
  const dryRun = body.dryRun !== false; // default to a dry run for safety

  if (!dryRun) {
    const dispatch = await dispatchMediaBackfillWorkflow(
      c,
      "media",
      "backfill-media",
      { sourceId: ident ?? null, all: body.all === true },
      {
        sourceId: ident || undefined,
        all: body.all === true,
        batchLimit: limit,
        dryRun: false,
      },
    );
    if (dispatch) return c.json(dispatch);
  }

  const report = await runMediaBackfill(db, bucket, {
    sourceId: ident || undefined,
    limit,
    dryRun,
  });

  logEvent("info", {
    component: "backfill-media",
    event: "done",
    sourceId: ident ?? null,
    all: body.all === true,
    ...report,
  });
  return c.json({ scope: ident ?? "all", ...report });
});

// ── POST /workflows/purge-junk-media ─────────────────────────────────────────
//
// Strip decorative-chrome media (WordPress emoji sprites, "Review in Cubic" /
// "Open in Stage" CI badges, avatars, favicons, `data:` URIs) from existing
// releases' stored `media[]`. The cleanup companion to the ingest-time
// `filterJunkMedia` pre-filter, for rows ingested before a marker existed.
// Unlike `backfill-media`, it rewrites a row whenever filtering removes an item
// (an all-junk media list is cleared to `[]`), so it runs inline (no fetches).
// Idempotent; bounded per call; `remaining` lets the operator loop. `dryRun`
// (default) reports what would be removed without writing.
//
// Body: { sourceId?, all?, limit?, dryRun? }

interface PurgeJunkMediaBody {
  sourceId?: string;
  all?: boolean;
  limit?: number;
  dryRun?: boolean;
}

workflowsRoutes.post("/workflows/purge-junk-media", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<PurgeJunkMediaBody>(c);

  // Scope to a typed source ID, or require an explicit `all: true` to sweep
  // every source — so a dropped/typo'd `sourceId` can't silently purge across
  // the whole registry.
  const ident = body.sourceId?.trim();
  if (!ident && body.all !== true) {
    return respondError(
      c,
      new ValidationError("Provide a typed `sourceId` (src_…) or `all: true`", {
        code: "bad_request",
      }),
    );
  }
  if (ident && !isSourceId(ident)) {
    return respondError(
      c,
      new ValidationError(
        "Pass a typed source ID (src_…). Resolve a slug via /v1/orgs/{orgSlug}/sources/{sourceSlug} first.",
        { code: "bare_slug_rejected" },
      ),
    );
  }

  const rawLimit = Number(body.limit ?? JUNK_PURGE_DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), JUNK_PURGE_MAX_LIMIT)
    : JUNK_PURGE_DEFAULT_LIMIT;
  const dryRun = body.dryRun !== false; // default to a dry run for safety

  const report = await runJunkMediaPurge(db, { sourceId: ident || undefined, limit, dryRun });

  logEvent("info", {
    component: "purge-junk-media",
    event: "done",
    sourceId: ident ?? null,
    all: body.all === true,
    ...report,
  });
  return c.json({ scope: ident ?? "all", ...report });
});

// ── POST /workflows/backfill-gif-mp4 ─────────────────────────────────────────
//
// Operator-triggered GIF→MP4 transcode backfill (#1368). Streams already-ingested
// animated GIFs through the Media Transformations binding and re-stamps their
// media `r2Key` to the stored `releases/<hash>.mp4`, so historical rows match new
// ingests. Requires both the R2 bucket (`MEDIA`) and the transform binding
// (`MEDIA_TRANSFORM`). Bounded per call; `remaining` lets the operator loop.
// `dryRun` (default) reports the pending count without transcoding or writing.
//
// Body: { sourceId?, all?, limit?, dryRun? }

interface BackfillGifBody {
  sourceId?: string;
  all?: boolean;
  limit?: number;
  dryRun?: boolean;
}

workflowsRoutes.post("/workflows/backfill-gif-mp4", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<BackfillGifBody>(c);

  const bucket = c.env.MEDIA;
  const mediaTransform = c.env.MEDIA_TRANSFORM;
  if (!bucket || !mediaTransform) {
    return respondError(
      c,
      new ServiceUnavailableError(
        !bucket ? "MEDIA bucket not bound" : "MEDIA_TRANSFORM binding not bound",
      ),
    );
  }

  // Scope to a typed source ID, or require an explicit `all: true` to sweep every
  // source — so a dropped/typo'd `sourceId` can't silently transcode everything.
  const ident = body.sourceId?.trim();
  if (!ident && body.all !== true) {
    return respondError(
      c,
      new ValidationError("Provide a typed `sourceId` (src_…) or `all: true`", {
        code: "bad_request",
      }),
    );
  }
  if (ident && !isSourceId(ident)) {
    return respondError(
      c,
      new ValidationError(
        "Pass a typed source ID (src_…). Resolve a slug via /v1/orgs/{orgSlug}/sources/{sourceSlug} first.",
        { code: "bare_slug_rejected" },
      ),
    );
  }

  const rawLimit = Number(body.limit ?? GIF_BACKFILL_DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), GIF_BACKFILL_MAX_LIMIT)
    : GIF_BACKFILL_DEFAULT_LIMIT;
  const dryRun = body.dryRun !== false; // default to a dry run for safety

  if (!dryRun) {
    const dispatch = await dispatchMediaBackfillWorkflow(
      c,
      "gif",
      "backfill-gif-mp4",
      { sourceId: ident ?? null, all: body.all === true },
      {
        sourceId: ident || undefined,
        all: body.all === true,
        batchLimit: limit,
        dryRun: false,
      },
    );
    if (dispatch) return c.json(dispatch);
  }

  const report = await runGifTranscodeBackfill(db, bucket, mediaTransform, {
    sourceId: ident || undefined,
    limit,
    dryRun,
  });

  logEvent("info", {
    component: "backfill-gif-mp4",
    event: "done",
    sourceId: ident ?? null,
    all: body.all === true,
    ...report,
  });
  return c.json({ scope: ident ?? "all", ...report });
});

// ── POST /workflows/backfill-video ───────────────────────────────────────────
//
// Operator-triggered retrofit of the inline hosted-video card (#1549) onto
// releases ingested before that ingest hook existed. The card renders in web
// purely from a `media[]` item with `type:"video"` + `linkUrl` — it does NOT
// scan markdown at render time — and that item is written ONLY at ingest for new
// releases (poll-fetch `isNewRelease` gate). So existing releases that link out
// to a Wistia/Loom/Vimeo/YouTube video never got the card; this route adds it.
//
// Built on the same primitives as the manual media edit (Part 1) and
// `backfill-media`: for each candidate it re-runs `detectInlineVideos`
// (detect → oEmbed poster/title/watch-URL), mirrors the poster via
// `processMediaForR2`, and APPENDS the resulting `type:"video"` item(s) to the
// existing `media[]` (preserving the row id + hero image + all other items).
// Idempotent — a video already present (matched by `linkUrl`) is skipped, so
// re-running adds nothing. Scope a single release with `releaseId` (rel_…) or a
// whole source with `sourceId` (src_…); `all: true` sweeps every source.
// `dryRun` (default) reports the candidate count without writing. No feature
// flag: admin-gated, idempotent, fail-open (an unresolvable embed is a no-op).
//
// Body: { releaseId?, sourceId?, all?, limit?, dryRun? }

interface BackfillVideoBody {
  releaseId?: string;
  sourceId?: string;
  all?: boolean;
  limit?: number;
  dryRun?: boolean;
}

workflowsRoutes.post("/workflows/backfill-video", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<BackfillVideoBody>(c);

  const bucket = c.env.MEDIA;
  if (!bucket) {
    return respondError(c, new ServiceUnavailableError("MEDIA bucket not bound"));
  }

  const releaseId = body.releaseId?.trim();
  const sourceId = body.sourceId?.trim();

  // Require an explicit scope — a single release, a single source, or `all` —
  // so a dropped/typo'd id can't silently sweep the whole table.
  if (!releaseId && !sourceId && body.all !== true) {
    return respondError(
      c,
      new ValidationError(
        "Provide a typed `releaseId` (rel_…), a typed `sourceId` (src_…), or `all: true`",
        { code: "bad_request" },
      ),
    );
  }
  if (releaseId && !releaseId.startsWith("rel_")) {
    return respondError(
      c,
      new ValidationError("Pass a typed release ID (rel_…)", { code: "bad_request" }),
    );
  }
  if (sourceId && !isSourceId(sourceId)) {
    return respondError(
      c,
      new ValidationError(
        "Pass a typed source ID (src_…). Resolve a slug via /v1/orgs/{orgSlug}/sources/{sourceSlug} first.",
        { code: "bare_slug_rejected" },
      ),
    );
  }

  const rawLimit = Number(body.limit ?? VIDEO_BACKFILL_DEFAULT_LIMIT);
  const limit = Number.isFinite(rawLimit)
    ? Math.min(Math.max(Math.floor(rawLimit), 1), VIDEO_BACKFILL_MAX_LIMIT)
    : VIDEO_BACKFILL_DEFAULT_LIMIT;
  const dryRun = body.dryRun !== false; // default to a dry run for safety

  if (!dryRun) {
    const dispatch = await dispatchMediaBackfillWorkflow(
      c,
      "video",
      "backfill-video",
      {
        releaseId: releaseId ?? null,
        sourceId: sourceId ?? null,
        all: body.all === true,
      },
      {
        releaseId: releaseId || undefined,
        sourceId: sourceId || undefined,
        all: body.all === true,
        batchLimit: limit,
        dryRun: false,
      },
    );
    if (dispatch) return c.json(dispatch);
  }

  const report = await runVideoBackfill(db, bucket, {
    releaseId: releaseId || undefined,
    sourceId: sourceId || undefined,
    limit,
    dryRun,
  });

  const scope = releaseId || sourceId || "all";
  logEvent("info", {
    component: "backfill-video",
    event: "done",
    releaseId: releaseId ?? null,
    sourceId: sourceId ?? null,
    all: body.all === true,
    ...report,
  });
  return c.json({ scope, ...report });
});

// ── POST /workflows/backfill-source ──────────────────────────────────────────
//
// Operator/agent-triggered full-history backfill for a windowed scrape source.
// Acquires the full page (supplied markdown / Firecrawl / plain fetch), loops
// extraction over every window, dedups by synthesized url, then upserts via the
// standard ingest tail and (inline) embeds + regenerates summaries. dryRun
// (default) previews counts + date range without writing. Idempotent.
//
// Body: { sourceId?, sourceSlug?, markdown?, maxWindows?, dryRun? }

const BACKFILL_DEFAULT_MAX_WINDOWS = 50;
const BACKFILL_MAX_MAX_WINDOWS = 200;
// Per-call summary chunk. generateContentForReleases bails entirely above
// MAX_AUTOGEN_ROWS_PER_FIRE (20) in poll-and-fetch.ts; chunk under it so a
// large backfill still gets every row summarized.
const BACKFILL_SUMMARY_CHUNK = 20;
// Matches FirecrawlIngestWorkflow's FIRECRAWL_EXTRACT_MODEL: cheap, deterministic.
const BACKFILL_EXTRACT_MODEL = "claude-haiku-4-5-20251001";

const backfillLogger = {
  info: (msg: string) =>
    logEvent("info", { component: "backfill-source", event: "extract-info", message: msg }),
  warn: (msg: string) =>
    logEvent("warn", { component: "backfill-source", event: "extract-warn", message: msg }),
  debug: (msg: string) =>
    logEvent("info", { component: "backfill-source", event: "extract-debug", message: msg }),
  error: (msg: string) =>
    logEvent("error", { component: "backfill-source", event: "extract-error", message: msg }),
};

interface BackfillSourceBody {
  sourceId?: string;
  sourceSlug?: string;
  markdown?: string;
  maxWindows?: number;
  dryRun?: boolean;
}

// TEST-ONLY hook (kept off the production Env type): inject the all-windows
// extraction result instead of calling Anthropic. Receives the *effective*
// (post-clamp) window budget so a test can assert the firecrawl ceiling.
type BackfillExtractOverride = (
  markdown: string,
  source: Source,
  maxWindows: number,
) => Promise<SourceBackfillExtractResult>;

// TEST-ONLY hook: inject the resolved body, bypassing the acquisition ladder
// (supplied / firecrawl / fetch) so the firecrawl `via` can be exercised in a
// unit test without a live Firecrawl scrape. As the first branch, it also
// supersedes any `markdown` supplied in the request body.
type BackfillBodyOverride = { markdown: string; via: BackfillBodyVia };

// Shared tail for windowed backfill (#1281) + re-extract (#1284): given a
// resolved body, run identical extract → ingest → embed machinery. Factored out
// so re-extraction reuses the exact same logic instead of forking it. Returns
// `{ ok: false }` when the Anthropic key is missing (caller maps to 503) so the
// HTTP concern stays in the route. Test override (`_backfillExtractOverride`)
// bypasses Anthropic for both routes.
async function executeWindowedBackfill(
  c: import("hono").Context<Env>,
  db: ReturnType<typeof createDb>,
  src: Source,
  resolved: { markdown: string; via: BackfillBodyVia },
  opts: { maxWindows: number; dryRun: boolean },
): Promise<{ ok: false } | { ok: true; report: SourceBackfillReport; guidance?: string }> {
  const { maxWindows, dryRun } = opts;
  // Firecrawl is the only via clamped (scrape long-pole); supplied/fetch/snapshot
  // keep the full 1–200 window budget.
  const effectiveMaxWindows = effectiveBackfillWindows(resolved.via, maxWindows);

  // ── Extraction (override in tests; else Haiku t0 all-windows) ──────────────
  const override = (c.env as { _backfillExtractOverride?: BackfillExtractOverride })
    ._backfillExtractOverride;
  let anthropicClient: ReturnType<typeof buildAnthropicClient> | null = null;
  if (!override) {
    const apiKey = await getAnthropicKey(c.env);
    if (!apiKey) return { ok: false };
    anthropicClient = buildAnthropicClient({ apiKey, ...(await resolveGatewayOpts(c.env)) });
  }
  const extract = async (markdown: string): Promise<SourceBackfillExtractResult> => {
    if (override) return override(markdown, src, effectiveMaxWindows);
    const r = await extractChangelogAllWindows(
      markdown,
      src,
      {
        anthropicClient: anthropicClient!,
        agentModel: BACKFILL_EXTRACT_MODEL,
        logger: backfillLogger,
        logUsageFn: (entry) => logUsage(db, { ...entry, sourceId: src.id }, "backfill-source"),
      },
      { maxWindows: effectiveMaxWindows },
    );
    return {
      releases: r.releases,
      windows: r.windows,
      cappedAtWindow: r.cappedAtWindow,
      droppedChars: r.droppedChars,
    };
  };

  // ── Ingest + enrich deps (lazy import only on the write path) ──────────────
  const deps: SourceBackfillDeps = {
    resolveBody: async () => resolved,
    extract,
    ingest: async () => {
      throw new Error("ingest unavailable on dryRun");
    },
    embedAndGenerate: async () => {},
  };
  if (!dryRun) {
    // poll-and-fetch.js pulls `cloudflare:workers` — import it only here so the
    // Bun-loaded OpenAPI coverage check / route smoke tests never trip on it.
    const { resolveFetchEnv, generateContentForReleases } =
      await import("../workflows/poll-and-fetch.js");
    const fetchEnv = await resolveFetchEnv(c.env as never);
    deps.ingest = (rows: RawRelease[]) =>
      ingestRawReleases(db as never, src as never, rows, fetchEnv);
    deps.embedAndGenerate = async (ids: string[]) => {
      if (c.env.RELEASES_INDEX) {
        await embedReleasesForSource(db as never, src as never, ids, fetchEnv, {
          throwOnError: false,
        });
      }
      for (let i = 0; i < ids.length; i += BACKFILL_SUMMARY_CHUNK) {
        // oxlint-disable-next-line no-await-in-loop -- bounded chunks under the autogen row cap
        await generateContentForReleases(
          db as never,
          c.env as never,
          src as never,
          ids.slice(i, i + BACKFILL_SUMMARY_CHUNK),
        );
      }
    };
  }

  const report = await runSourceBackfill({ id: src.id, slug: src.slug }, { dryRun }, deps);
  const guidance = firecrawlCapGuidance({
    via: resolved.via,
    cappedAtWindow: report.cappedAtWindow,
    effectiveMaxWindows,
    requestedMaxWindows: maxWindows,
  });
  if (report.cappedAtWindow || report.droppedChars > 0) {
    logEvent("info", {
      component: "backfill-source",
      event: "windowed-cap",
      sourceId: src.id,
      windows: report.windows,
      droppedChars: report.droppedChars,
    });
  }
  return guidance ? { ok: true, report, guidance } : { ok: true, report };
}

workflowsRoutes.post("/workflows/backfill-source", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<BackfillSourceBody>(c);

  const ident = body.sourceId?.trim() || body.sourceSlug?.trim();
  if (!ident) {
    return respondError(
      c,
      new ValidationError("Provide `sourceId` or `sourceSlug`", { code: "bad_request" }),
    );
  }
  if (!isSourceId(ident)) {
    return respondError(
      c,
      new ValidationError(
        "Pass a typed source ID (src_…). Bare slugs are ambiguous across orgs — resolve via /v1/orgs/{orgSlug}/sources/{sourceSlug} or /v1/lookups/source-by-slug first.",
        { code: "bare_slug_rejected" },
      ),
    );
  }

  const [src] = await db.select().from(sources).where(sourceMatchByIdOrSlug(ident));
  if (!src) return respondError(c, new NotFoundError("Source not found"));
  if (src.type !== "scrape") {
    return respondError(
      c,
      new ValidationError(`Backfill supports scrape sources; this source is type=${src.type}`, {
        code: "bad_request",
      }),
    );
  }

  const rawMax = Number(body.maxWindows ?? BACKFILL_DEFAULT_MAX_WINDOWS);
  const maxWindows = Number.isFinite(rawMax)
    ? Math.min(Math.max(Math.floor(rawMax), 1), BACKFILL_MAX_MAX_WINDOWS)
    : BACKFILL_DEFAULT_MAX_WINDOWS;
  const dryRun = body.dryRun !== false; // default to a dry run for safety
  const suppliedMarkdown =
    typeof body.markdown === "string" && body.markdown.trim().length > 0 ? body.markdown : null;
  const meta = getSourceMeta(src);

  // Deep Firecrawl backfills are extraction-bound (minutes); route them to the
  // durable BackfillSourceWorkflow so they survive client disconnect. Supplied-
  // markdown / plain-fetch stay synchronous (fast path). Flag off → unchanged.
  const wantsWorkflow =
    !suppliedMarkdown &&
    meta.firecrawl?.enabled === true &&
    !!c.env.BACKFILL_SOURCE_WORKFLOW &&
    (await flag(c.env.FLAGS, c.env.BACKFILL_WORKFLOW_ENABLED, FLAGS.backfillWorkflow));
  if (wantsWorkflow) {
    const scheduledTime = Date.now();
    const instance = await c.env.BACKFILL_SOURCE_WORKFLOW!.create({
      id: `backfill-${src.id}-${scheduledTime}`,
      params: { sourceId: src.id, maxWindows, dryRun },
    });
    const instanceId: string = (instance as unknown as { id: string }).id;
    logEvent("info", {
      component: "backfill-source",
      event: "workflow-dispatch",
      sourceId: src.id,
      instanceId,
      dryRun,
    });
    return c.json(
      {
        instanceId,
        async: true,
        statusUrl: `${c.env.ADMIN_BASE_URL ?? ""}/v1/workflows/backfill-source/status/${instanceId}`,
      },
      202,
    );
  }

  // ── Body acquisition (errors mapped to HTTP here) ──────────────────────────
  const bodyOverride = (c.env as { _backfillBodyOverride?: BackfillBodyOverride })
    ._backfillBodyOverride;
  let resolved: { markdown: string; via: BackfillBodyVia };
  if (bodyOverride) {
    resolved = bodyOverride;
  } else if (suppliedMarkdown) {
    resolved = { markdown: suppliedMarkdown, via: "supplied" };
  } else if (meta.firecrawl?.enabled) {
    const apiKey = await getSecret(c.env.FIRECRAWL_API_KEY);
    if (!apiKey) {
      return respondError(c, new ServiceUnavailableError("FIRECRAWL_API_KEY not configured"));
    }
    try {
      const client = createFirecrawlClient({ apiKey });
      const md = await client.scrapeOnce(src.url, { proxy: meta.firecrawl?.proxy });
      if (!md) {
        return respondError(c, new UpstreamError(`Empty Firecrawl scrape for ${src.url}`));
      }
      resolved = { markdown: md, via: "firecrawl" };
    } catch (err) {
      const status = err instanceof FirecrawlError ? err.status : null;
      return respondError(
        c,
        new UpstreamError(`Firecrawl scrape failed${status ? ` (${status})` : ""}`, {
          details: { upstream: "firecrawl", firecrawlStatus: status },
        }),
      );
    }
  } else {
    try {
      const res = await fetch(src.url, { headers: { "User-Agent": RELEASES_BOT_UA } });
      const md = res.ok ? htmlToMarkdown(await res.text()) : "";
      if (!md.trim()) {
        return respondError(
          c,
          new ValidationError(
            `Could not fetch a usable body for ${src.url}. Supply \`markdown\` or enable Firecrawl on this source.`,
            { code: "bad_request" },
          ),
        );
      }
      resolved = { markdown: md, via: "fetch" };
    } catch {
      return respondError(
        c,
        new ValidationError(
          `Could not fetch ${src.url}. Supply \`markdown\` or enable Firecrawl on this source.`,
          { code: "bad_request" },
        ),
      );
    }
  }

  const result = await executeWindowedBackfill(c, db, src, resolved, { maxWindows, dryRun });
  if (!result.ok) {
    return respondError(c, new ServiceUnavailableError("ANTHROPIC_API_KEY not configured"));
  }
  return c.json(result.guidance ? { ...result.report, guidance: result.guidance } : result.report);
});

// ── GET /workflows/backfill-source/status/:instanceId ────────────────────────
//
// Resolves the `statusUrl` returned by the POST trigger above. Thin pass-through
// to Cloudflare's `WorkflowInstance.status()` so operators can poll workflow
// state without dashboard access. Mirrors batch-summarize/status exactly.

workflowsRoutes.get("/workflows/backfill-source/status/:instanceId", async (c) => {
  const binding = c.env.BACKFILL_SOURCE_WORKFLOW;
  if (!binding) {
    return respondError(
      c,
      new ServiceUnavailableError("BACKFILL_SOURCE_WORKFLOW binding not configured"),
    );
  }
  const instanceId = c.req.param("instanceId");
  try {
    const instance = await binding.get(instanceId);
    const status = await instance.status();
    return c.json({ instanceId, ...status });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (WORKFLOW_NOT_FOUND_RE.test(message))
      return respondError(c, new NotFoundError(message, { code: "instance_not_found" }));
    logEvent("error", {
      component: "workflows-backfill-status",
      event: "lookup-failed",
      instanceId,
      err: err instanceof Error ? err : String(err),
    });
    return respondError(c, new InternalError(message));
  }
});

// ── POST /workflows/reextract-source ─────────────────────────────────────────
//
// Re-extract releases from a stored raw snapshot (#1284) — no live scrape, no
// Firecrawl credits, deterministic input. Resolves the source (typed `src_` id),
// picks the snapshot (explicit `snapshotId` or the latest by capture time),
// loads the body from `released-raw`, then runs the SAME windowed extract/ingest
// machinery as backfill-source with via="snapshot" (full window budget — the
// body is pre-loaded, so there's no Firecrawl scrape to bound). Idempotent via
// the standard URL upsert; `dryRun` (default true) previews counts without
// writing. Pairs with universal raw capture (#1283).
//
// Body: { sourceId, snapshotId?, maxWindows?, dryRun? }
interface ReextractSourceBody {
  sourceId?: string;
  snapshotId?: string;
  maxWindows?: number;
  dryRun?: boolean;
}

workflowsRoutes.post("/workflows/reextract-source", async (c) => {
  const db = createDb(c.env.DB);
  const body = await parseJsonBody<ReextractSourceBody>(c);

  const ident = body.sourceId?.trim();
  if (!ident) {
    return respondError(c, new ValidationError("Provide `sourceId`", { code: "bad_request" }));
  }
  if (!isSourceId(ident)) {
    return respondError(
      c,
      new ValidationError(
        "Pass a typed source ID (src_…). Bare slugs are ambiguous across orgs — resolve via /v1/orgs/{orgSlug}/sources/{sourceSlug} or /v1/lookups/source-by-slug first.",
        { code: "bare_slug_rejected" },
      ),
    );
  }

  const [src] = await db.select().from(sources).where(sourceMatchByIdOrSlug(ident));
  if (!src) return respondError(c, new NotFoundError("Source not found"));
  if (src.type !== "scrape") {
    return respondError(
      c,
      new ValidationError(`Re-extract supports scrape sources; this source is type=${src.type}`, {
        code: "bad_request",
      }),
    );
  }

  // Resolve the snapshot: the explicit one (scoped to this source so a stray id
  // can't reach another source's body) or the most recent capture.
  const snapId = body.snapshotId?.trim();
  const [snap] = snapId
    ? await db
        .select()
        .from(sourceRawSnapshots)
        .where(and(eq(sourceRawSnapshots.id, snapId), eq(sourceRawSnapshots.sourceId, src.id)))
        .limit(1)
    : await db
        .select()
        .from(sourceRawSnapshots)
        .where(eq(sourceRawSnapshots.sourceId, src.id))
        .orderBy(desc(sourceRawSnapshots.createdAt))
        .limit(1);
  if (!snap) {
    return respondError(
      c,
      new NotFoundError(
        snapId
          ? `No snapshot ${snapId} for source ${src.id}`
          : `No raw snapshot stored for source ${src.id}. Enable capture (raw-snapshot-capture-enabled) or run a Firecrawl backfill first.`,
      ),
    );
  }

  if (!c.env.RAW_SNAPSHOTS) {
    return respondError(c, new ServiceUnavailableError("RAW_SNAPSHOTS bucket not configured"));
  }
  const markdown = await loadRawSnapshot({ R2: c.env.RAW_SNAPSHOTS }, snap.r2Key);
  if (markdown === null) {
    return respondError(
      c,
      new NotFoundError(
        `Snapshot body gone from R2 (${snap.r2Key}); likely past the 90-day lifecycle. Re-scrape to capture a fresh snapshot.`,
        { code: "snapshot_expired" },
      ),
    );
  }

  const rawMax = Number(body.maxWindows ?? BACKFILL_DEFAULT_MAX_WINDOWS);
  const maxWindows = Number.isFinite(rawMax)
    ? Math.min(Math.max(Math.floor(rawMax), 1), BACKFILL_MAX_MAX_WINDOWS)
    : BACKFILL_DEFAULT_MAX_WINDOWS;
  const dryRun = body.dryRun !== false; // default to a dry run for safety

  const result = await executeWindowedBackfill(
    c,
    db,
    src,
    { markdown, via: "snapshot" },
    { maxWindows, dryRun },
  );
  if (!result.ok) {
    return respondError(c, new ServiceUnavailableError("ANTHROPIC_API_KEY not configured"));
  }
  logEvent("info", {
    component: "reextract-source",
    event: "completed",
    sourceId: src.id,
    snapshotId: snap.id,
    extracted: result.report.extracted,
    inserted: result.report.inserted,
    dryRun,
  });
  return c.json({
    ...result.report,
    ...(result.guidance ? { guidance: result.guidance } : {}),
    snapshot: {
      id: snap.id,
      contentHash: snap.contentHash,
      capturedAt: snap.createdAt,
      bytes: snap.bytes,
      format: snap.format,
    },
  });
});

// ── POST /workflows/collection-summaries ─────────────────────────────────────
//
// On-demand trigger for collection daily-summary generation. When
// `COLLECTION_SUMMARIES_WORKFLOW` is bound, dispatches a durable instance
// (async). Falls back to a synchronous single-day sweep for local dev / tests.
// `dryRun` always returns immediately with the resolved scope.

interface CollectionSummariesBody {
  /** Limit the run to a single collection (typed `col_…` id). */
  collectionId?: string;
  /** ET day to summarize (YYYY-MM-DD). Defaults to yesterday ET. */
  date?: string;
  /** When true, skip AI generation and return the resolved date only. */
  dryRun?: boolean;
  /** When true, regenerate even if a summary already exists for that day. */
  force?: boolean;
}

workflowsRoutes.post("/workflows/collection-summaries", async (c) => {
  const body = await parseJsonBody<CollectionSummariesBody>(c);

  const rawDate = body.date?.trim();
  if (rawDate && !isDateKey(rawDate)) {
    return respondError(
      c,
      new ValidationError("date must be a YYYY-MM-DD calendar date", { code: "bad_request" }),
    );
  }
  const date = rawDate || addDaysToDateKey(etDayKey(new Date()), -1);
  const collectionId = typeof body.collectionId === "string" ? body.collectionId : undefined;
  const force = body.force === true;

  // Preview short-circuit comes BEFORE model resolution — a dry run reports the
  // resolved scope without needing (or paying for) an AI model.
  if (body.dryRun === true) {
    return c.json({ date, dryRun: true, collectionId, force });
  }

  if (c.env.COLLECTION_SUMMARIES_WORKFLOW) {
    const scheduledTime = Date.now();
    const instance = await c.env.COLLECTION_SUMMARIES_WORKFLOW.create({
      id: `collection-summaries-admin-${scheduledTime}`,
      params: {
        scheduledTime,
        trigger: "admin" as const,
        dates: [date],
        collectionId,
        force,
      },
    });
    const instanceId: string = (instance as unknown as { id: string }).id;
    logEvent("info", {
      component: "collection-summaries",
      event: "workflow-trigger",
      instanceId,
      date,
      collectionId: collectionId ?? null,
      force,
    });
    return c.json({
      instanceId,
      statusUrl: `${c.env.ADMIN_BASE_URL ?? ""}/v1/workflows/collection-summaries/status/${instanceId}`,
    });
  }

  const model = await resolveCollectionSummaryModel(c.env);
  if (!model) {
    return respondError(
      c,
      new ServiceUnavailableError(
        "No AI model configured for collection summaries (ANTHROPIC_API_KEY or OPENROUTER_API_KEY required)",
      ),
    );
  }

  const db = createDb(c.env.DB);
  const result = await generateCollectionSummariesForDay(db, model, date, { collectionId, force });
  return c.json({ date, ...result });
});

workflowsRoutes.get("/workflows/collection-summaries/status/:instanceId", async (c) =>
  replyWorkflowStatus(
    c,
    c.env.COLLECTION_SUMMARIES_WORKFLOW,
    "COLLECTION_SUMMARIES_WORKFLOW binding not configured",
    "workflows-collection-summaries-status",
  ),
);

workflowsRoutes.post("/workflows/collection-summaries/terminate/:instanceId", async (c) =>
  replyWorkflowTerminate(
    c,
    c.env.COLLECTION_SUMMARIES_WORKFLOW,
    "COLLECTION_SUMMARIES_WORKFLOW binding not configured",
    "workflows-collection-summaries-terminate",
  ),
);

workflowsRoutes.get("/workflows/media-backfill/status/:instanceId", async (c) =>
  replyWorkflowStatus(
    c,
    c.env.MEDIA_BACKFILL_WORKFLOW,
    "MEDIA_BACKFILL_WORKFLOW binding not configured",
    "workflows-media-backfill-status",
  ),
);

workflowsRoutes.post("/workflows/media-backfill/terminate/:instanceId", async (c) =>
  replyWorkflowTerminate(
    c,
    c.env.MEDIA_BACKFILL_WORKFLOW,
    "MEDIA_BACKFILL_WORKFLOW binding not configured",
    "workflows-media-backfill-terminate",
  ),
);
