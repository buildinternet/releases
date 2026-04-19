/**
 * Admin-only endpoints for semantic-search backfill. The CLI cannot talk to
 * Vectorize directly (bindings are Worker-only), so `releases admin embed ...`
 * proxies through these routes. Each POST endpoint pulls up to BATCH_CAP rows
 * where `embedded_at IS NULL`, hands them to the matching `src/lib/embed-*.ts`
 * helper from task 6, and returns a summary including `remaining` so the CLI
 * can loop until the backlog is drained.
 *
 * Gated by `authMiddleware` via the `/admin/*` mount in workers/api/src/index.ts.
 *
 * Batch cap: Workers have a hard CPU limit per invocation. The CLI loops so a
 * modest per-call cap keeps each request well under the budget while still
 * making forward progress. Voyage charges per-token so batching is cheap.
 */

import { Hono } from "hono";
import { eq, and, inArray, gte, count, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  releases,
  sources,
  organizations,
  products,
  sourceChangelogFiles,
  sourceChangelogChunks,
} from "@releases/core-internal/schema";
import type { Env } from "../index.js";
import { embedAndUpsertReleases, type EmbedReleaseInput } from "@releases/lib/embed-releases.js";
import {
  embedAndUpsertEntities,
  type EmbedEntityInput,
  type EntityKind,
} from "@releases/lib/embed-entities.js";
import { embedAndUpsertChangelogFile } from "@releases/lib/embed-changelog-pipeline.js";
import { buildEmbedConfig } from "../lib/embed-config.js";
import type { VectorizeIndex } from "@releases/lib/vector-search.js";

export const adminEmbedRoutes = new Hono<Env>();

/** Max rows processed per endpoint call. The CLI loops until `remaining === 0`. */
const BATCH_CAP = 50;

/**
 * Cast: workers-types `VectorizeIndex` declares a stricter metadata value
 * type than the runtime-agnostic interface in `@releases/lib/vector-search.ts`.
 * Identical at runtime; only diverges by type-system variance.
 */
function asSharedIndex(index: unknown): VectorizeIndex {
  return index as VectorizeIndex;
}

// ── helpers ───────────────────────────────────────────────────────────────

function clampLimit(n: unknown): number {
  const parsed = typeof n === "number" ? n : typeof n === "string" ? parseInt(n, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return BATCH_CAP;
  return Math.min(parsed, BATCH_CAP);
}

async function safeJson<T>(req: Request): Promise<T> {
  try {
    return (await req.json()) as T;
  } catch {
    return {} as T;
  }
}

// ── GET /admin/embed/status ───────────────────────────────────────────────

adminEmbedRoutes.get("/admin/embed/status", async (c) => {
  const db = createDb(c.env.DB);

  const [
    [releasesTotal],
    [releasesEmbedded],
    [orgsTotal],
    [orgsEmbedded],
    [productsTotal],
    [productsEmbedded],
    [sourcesTotal],
    [sourcesEmbedded],
    [chunksTotal],
    [chunksEmbedded],
  ] = await Promise.all([
    db.select({ n: count() }).from(releases),
    db
      .select({ n: count() })
      .from(releases)
      .where(
        and(
          // Embedded is simply "embedded_at IS NOT NULL" — suppressed rows are
          // still counted because the backfill treats them the same. Operators
          // who care about suppressed gaps can diff against the search paths.
          sql`${releases.embeddedAt} IS NOT NULL`,
        ),
      ),
    db.select({ n: count() }).from(organizations),
    db
      .select({ n: count() })
      .from(organizations)
      .where(sql`${organizations.embeddedAt} IS NOT NULL`),
    db.select({ n: count() }).from(products),
    db
      .select({ n: count() })
      .from(products)
      .where(sql`${products.embeddedAt} IS NOT NULL`),
    db.select({ n: count() }).from(sources),
    db
      .select({ n: count() })
      .from(sources)
      .where(sql`${sources.embeddedAt} IS NOT NULL`),
    db.select({ n: count() }).from(sourceChangelogChunks),
    db
      .select({ n: count() })
      .from(sourceChangelogChunks)
      .where(sql`${sourceChangelogChunks.vectorId} IS NOT NULL`),
  ]);

  const entitiesTotal = orgsTotal.n + productsTotal.n + sourcesTotal.n;
  const entitiesEmbedded = orgsEmbedded.n + productsEmbedded.n + sourcesEmbedded.n;

  return c.json({
    releases: {
      total: releasesTotal.n,
      embedded: releasesEmbedded.n,
      unembedded: releasesTotal.n - releasesEmbedded.n,
    },
    entities: {
      total: entitiesTotal,
      embedded: entitiesEmbedded,
      unembedded: entitiesTotal - entitiesEmbedded,
      breakdown: {
        org: {
          total: orgsTotal.n,
          embedded: orgsEmbedded.n,
          unembedded: orgsTotal.n - orgsEmbedded.n,
        },
        product: {
          total: productsTotal.n,
          embedded: productsEmbedded.n,
          unembedded: productsTotal.n - productsEmbedded.n,
        },
        source: {
          total: sourcesTotal.n,
          embedded: sourcesEmbedded.n,
          unembedded: sourcesTotal.n - sourcesEmbedded.n,
        },
      },
    },
    chunks: {
      total: chunksTotal.n,
      embedded: chunksEmbedded.n,
      unembedded: chunksTotal.n - chunksEmbedded.n,
    },
  });
});

// ── POST /admin/embed/releases ────────────────────────────────────────────

interface EmbedReleasesBody {
  since?: string;
  limit?: number;
  dryRun?: boolean;
}

adminEmbedRoutes.post("/admin/embed/releases", async (c) => {
  const db = createDb(c.env.DB);
  const body = await safeJson<EmbedReleasesBody>(c.req.raw);
  const limit = clampLimit(body.limit);
  const since = body.since;
  const dryRun = body.dryRun === true;

  // Join releases → sources for org/product/category metadata.
  const conditions = [sql`${releases.embeddedAt} IS NULL`];
  if (since) conditions.push(gte(releases.publishedAt, since));

  const rows = await db
    .select({
      id: releases.id,
      title: releases.title,
      content: releases.content,
      contentSummary: releases.contentSummary,
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
    .limit(limit);

  // Remaining = backlog under the same predicate minus what we just grabbed.
  const [{ n: remainingBefore }] = await db
    .select({ n: count() })
    .from(releases)
    .where(and(...conditions));

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
    return c.json(
      { error: "embed_unavailable", message: "Embedding provider not configured" },
      503,
    );
  }
  let persistedIds: string[] = [];

  const inputs: EmbedReleaseInput[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    content: r.content,
    contentSummary: r.contentSummary,
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

// ── POST /admin/embed/entities ────────────────────────────────────────────

interface EmbedEntitiesBody {
  kind?: EntityKind;
  limit?: number;
  dryRun?: boolean;
}

adminEmbedRoutes.post("/admin/embed/entities", async (c) => {
  const db = createDb(c.env.DB);
  const body = await safeJson<EmbedEntitiesBody>(c.req.raw);
  const limit = clampLimit(body.limit);
  const dryRun = body.dryRun === true;
  const kindFilter: EntityKind | undefined = body.kind;

  // Pull from orgs, products, sources (respecting the optional `kind` filter).
  // Inputs are built to a uniform shape so `embedAndUpsertEntities` can handle
  // them in one batch — all three share ENTITIES_INDEX.
  const entities: EmbedEntityInput[] = [];

  function urlHost(url: string | null): string | null {
    if (!url) return null;
    try {
      return new URL(url).hostname;
    } catch {
      return null;
    }
  }

  async function fetchUnembedded(kind: EntityKind, n: number): Promise<void> {
    if (n <= 0) return;
    if (kind === "org") {
      const rows = await db
        .select()
        .from(organizations)
        .where(sql`${organizations.embeddedAt} IS NULL`)
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
        .where(sql`${products.embeddedAt} IS NULL`)
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
    const rows = await db
      .select()
      .from(sources)
      .where(sql`${sources.embeddedAt} IS NULL`)
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
  }

  async function countUnembeddedKind(kind: EntityKind): Promise<number> {
    const table = kind === "org" ? organizations : kind === "product" ? products : sources;
    const col =
      kind === "org"
        ? organizations.embeddedAt
        : kind === "product"
          ? products.embeddedAt
          : sources.embeddedAt;
    const [{ n }] = await db
      .select({ n: count() })
      .from(table)
      .where(sql`${col} IS NULL`);
    return n;
  }

  if (kindFilter) {
    await fetchUnembedded(kindFilter, limit);
  } else {
    // Round-robin-ish: give each kind up to limit/3, then refill from what's
    // left. Keeps backfill balanced across tables.
    const third = Math.max(1, Math.floor(limit / 3));
    await fetchUnembedded("org", third);
    await fetchUnembedded("product", third);
    await fetchUnembedded("source", limit - entities.length);
  }

  const remainingBefore = kindFilter
    ? await countUnembeddedKind(kindFilter)
    : (
        await Promise.all([
          countUnembeddedKind("org"),
          countUnembeddedKind("product"),
          countUnembeddedKind("source"),
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
    return c.json(
      { error: "embed_unavailable", message: "Embedding provider not configured" },
      503,
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
      const partitions: Record<EntityKind, string[]> = { org: [], product: [], source: [] };
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

// ── POST /admin/embed/changelogs ──────────────────────────────────────────

interface EmbedChangelogsBody {
  sourceSlug?: string;
  limit?: number;
  dryRun?: boolean;
}

adminEmbedRoutes.post("/admin/embed/changelogs", async (c) => {
  const db = createDb(c.env.DB);
  const body = await safeJson<EmbedChangelogsBody>(c.req.raw);
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
      return c.json({ error: "not_found", message: `source not found: ${body.sourceSlug}` }, 404);
    }
    fileConditions.push(eq(sourceChangelogFiles.sourceId, src.id));
  }

  // A file needs work if ANY of its chunks have `vector_id IS NULL`, or if
  // it has zero chunks (never been embedded). We compute this via a LEFT
  // JOIN + aggregate rather than a correlated subquery for D1 compatibility.
  const whereClause = fileConditions.length > 0 ? and(...fileConditions) : undefined;
  const baseSelect = {
    file: sourceChangelogFiles,
    nullChunks: sql<number>`SUM(CASE WHEN ${sourceChangelogChunks.vectorId} IS NULL THEN 1 ELSE 0 END)`,
    totalChunks: sql<number>`COUNT(${sourceChangelogChunks.id})`,
  };
  function needsWork(r: { nullChunks: number | null; totalChunks: number | null }): boolean {
    return Number(r.totalChunks ?? 0) === 0 || Number(r.nullChunks ?? 0) > 0;
  }

  const fileRows = await db
    .select(baseSelect)
    .from(sourceChangelogFiles)
    .leftJoin(
      sourceChangelogChunks,
      eq(sourceChangelogChunks.sourceChangelogFileId, sourceChangelogFiles.id),
    )
    .where(whereClause)
    .groupBy(sourceChangelogFiles.id)
    .limit(limit);

  const todo = fileRows.filter(needsWork);

  // Remaining: total files matching the filter that still need work.
  // Cheap approximation — recompute the same predicate without the LIMIT.
  const allFileRows = await db
    .select(baseSelect)
    .from(sourceChangelogFiles)
    .leftJoin(
      sourceChangelogChunks,
      eq(sourceChangelogChunks.sourceChangelogFileId, sourceChangelogFiles.id),
    )
    .where(whereClause)
    .groupBy(sourceChangelogFiles.id);

  const remainingBefore = allFileRows.filter(needsWork).length;

  if (todo.length === 0 || dryRun) {
    return c.json({
      processed: todo.length,
      succeeded: 0,
      failed: 0,
      remaining: dryRun ? remainingBefore : 0,
      dryRun,
    });
  }

  const embedConfig = await buildEmbedConfig(c.env);
  if (!embedConfig) {
    return c.json(
      { error: "embed_unavailable", message: "Embedding provider not configured" },
      503,
    );
  }
  let succeeded = 0;
  let failed = 0;

  for (const row of todo) {
    const file = row.file;
    const existingChunks = await db
      .select({
        id: sourceChangelogChunks.id,
        offset: sourceChangelogChunks.offset,
        contentHash: sourceChangelogChunks.contentHash,
        vectorId: sourceChangelogChunks.vectorId,
      })
      .from(sourceChangelogChunks)
      .where(eq(sourceChangelogChunks.sourceChangelogFileId, file.id));

    let applied = false;
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
      onDiff: async ({ diff, embedded }) => {
        const now = new Date().toISOString();
        const embeddedByHash = new Map(embedded.map((e) => [e.chunk.contentHash, e]));

        // Delete stale rows first so their (file_id, offset) slots are free
        // before we potentially re-insert at the same offset.
        if (diff.toDelete.length > 0) {
          const ids = diff.toDelete.map((d) => d.id);
          for (let i = 0; i < ids.length; i += 50) {
            await db
              .delete(sourceChangelogChunks)
              .where(inArray(sourceChangelogChunks.id, ids.slice(i, i + 50)));
          }
        }

        // Update unchanged rows' offset/length/heading in case the surrounding
        // file shifted — content hash matched so they don't need re-embedding.
        for (const u of diff.unchanged) {
          await db
            .update(sourceChangelogChunks)
            .set({
              offset: u.chunk.offset,
              length: u.chunk.length,
              heading: u.chunk.heading,
            })
            .where(eq(sourceChangelogChunks.id, u.id));
        }

        // Insert the new chunks. Rows whose embedding landed get a vectorId +
        // embeddedAt; rows whose embedding failed go in with null so the next
        // backfill run can pick them up.
        if (diff.toInsert.length > 0) {
          const inserts = diff.toInsert.map((chunk) => {
            const e = embeddedByHash.get(chunk.contentHash);
            return {
              sourceChangelogFileId: file.id,
              sourceId: file.sourceId,
              offset: chunk.offset,
              length: chunk.length,
              tokens: chunk.tokens,
              contentHash: chunk.contentHash,
              heading: chunk.heading,
              vectorId: e?.vectorId ?? null,
              embeddedAt: e ? now : null,
            };
          });
          // D1 caps bound parameters per statement at ~100. This table has
          // 11 columns, so 9 rows per batch keeps us under the limit.
          for (let i = 0; i < inserts.length; i += 9) {
            await db.insert(sourceChangelogChunks).values(inserts.slice(i, i + 9));
          }
        }
        applied = true;
      },
    });

    if (applied) succeeded += 1;
    else failed += 1;
  }

  return c.json({
    processed: todo.length,
    succeeded,
    failed,
    remaining: Math.max(remainingBefore - succeeded, 0),
  });
});
