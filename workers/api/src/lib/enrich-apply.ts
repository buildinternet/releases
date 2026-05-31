/**
 * Enrichment result-application: the shared core for turning a fetched page into
 * an enriched release body, used by both the synchronous backfill route
 * (`runEnrichBackfill` in routes/workflows.ts) and the async Message Batches
 * workflow (`BatchEnrichWorkflow`).
 *
 * The two paths differ only in WHERE the AI extraction happens — inline per row
 * for the sync route, one Anthropic batch for the async one. Everything around
 * it (which rows are candidates, the improvement-bar gate, the idempotent
 * update field-set, the enrichment marker) is identical, so it lives here once.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { releases } from "@buildinternet/releases-core/schema";
import { computeContentSize } from "@buildinternet/releases-core/tokens";
import { contentHash } from "@releases/adapters/content-hash";
import { extractMediaFromMarkdown } from "@releases/adapters/feed.js";
import { normalizeMediaUrl } from "@releases/rendering/media-url.js";
import {
  SYSTEM_PROMPT,
  MAX_OUTPUT_TOKENS,
  MODEL as ARTICLE_MODEL,
  buildArticleInput,
} from "@releases/ai-internal/article-extract";

type BatchCreateParams = Anthropic.Messages.Batches.BatchCreateParams;

/** Minimal drizzle handle accepted by the applier (same pattern as batch-run.ts). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- drizzle generic param isn't exposed uniformly across runtimes
type AnyDb = DrizzleD1Database<any>;

/** A page fetched in the workflow's fetch phase, ready for batch extraction. */
export interface EnrichBatchItem {
  /** The release row id — used as the batch `custom_id` so results map back. */
  releaseId: string;
  /** Release title, fed to the extractor as the article anchor. */
  title: string;
  /** Page markdown (already rendered/fetched). */
  markdown: string;
}

/**
 * Build one `extractArticle` request per fetched page for a single Anthropic
 * Message Batch. Mirrors the synchronous `extractArticle` call shape — same
 * model, output cap, cacheable system prompt, and per-item user message — so
 * batch results parse identically via `parseArticleResponse`.
 */
export function buildEnrichBatchRequests(
  items: ReadonlyArray<EnrichBatchItem>,
): BatchCreateParams["requests"] {
  return items.map((item) => ({
    custom_id: item.releaseId,
    params: {
      model: ARTICLE_MODEL,
      max_tokens: MAX_OUTPUT_TOKENS,
      system: [
        {
          type: "text" as const,
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" as const },
        },
      ],
      messages: [
        {
          role: "user" as const,
          content: buildArticleInput({ markdown: item.markdown, title: item.title }),
        },
      ],
    },
  }));
}

// ── Result → upsert application ─────────────────────────────────────────────

/** Enrichment marker stored under `release.metadata.enrichment`. */
export interface EnrichmentMarker {
  attemptedAt: string;
  succeeded: boolean;
  via?: "fetch" | "render";
}

/**
 * Merge an enrichment marker into a release's existing metadata JSON, preserving
 * any other top-level keys. Tolerates null / malformed metadata. Shared with the
 * synchronous backfill route so both paths write the marker identically.
 */
export function mergeEnrichmentMarker(
  existing: string | null,
  enrichment: EnrichmentMarker,
): string {
  let base: Record<string, unknown> = {};
  if (existing) {
    try {
      const parsed = JSON.parse(existing);
      if (parsed && typeof parsed === "object") base = parsed as Record<string, unknown>;
    } catch {
      // malformed metadata — start fresh rather than throw
    }
  }
  return JSON.stringify({ ...base, enrichment });
}

/** True when a release's stored media JSON holds at least one entry. */
export function hasStoredMedia(raw: string | null): boolean {
  if (!raw) return false;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) && arr.length > 0;
  } catch {
    return false;
  }
}

/**
 * The enrichment improvement bar: an enriched body must clear
 * `max(thinChars, 1.5 × summaryLen)` to be worth replacing the feed teaser.
 * Canonical definition — `enrichFeedItem`'s internal `bar()` delegates here so
 * the sync forward path, the sync backfill route, and the batch workflow all
 * gate on the same threshold.
 */
export function enrichmentFloor(summary: string, thinChars: number): number {
  return Math.max(thinChars, Math.ceil(summary.length * 1.5));
}

/** Candidate release row the applier reads (matches `selectEnrichCandidates`). */
export interface EnrichCandidateRow {
  id: string;
  /** Owning source — lets the batch workflow group regeneration per source. */
  sourceId: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  /** Current (thin) body — the feed teaser, used as the improvement-bar baseline. */
  content: string;
  url: string | null;
  media: string | null;
  metadata: string | null;
}

export interface SelectEnrichCandidatesArgs {
  /** Sources to scan. Kept small (the deferred render-heavy set) — single `inArray`. */
  sourceIds: ReadonlyArray<string>;
  /** Max rows across all sources, most-recent first. */
  limit: number;
  /** Thinness threshold for the summary-less length guard. */
  thinChars: number;
}

/**
 * Select thin releases that haven't been successfully enriched, across one or
 * more sources. Single source of truth for the candidate filter shared by the
 * synchronous `runEnrichBackfill` route and the async `BatchEnrichWorkflow`:
 *
 * - URL present (enrichment follows the item's link).
 * - No prior enrichment, or a prior *failed* attempt (transient failures stay
 *   retryable; a success is never re-run).
 * - Thin only: teaser-as-content (`content == summary`), or no summary AND a
 *   short body — so full-body summary-less releases don't burn a fetch+extract
 *   before the improvement bar no-ops them.
 */
export async function selectEnrichCandidates(
  db: AnyDb,
  args: SelectEnrichCandidatesArgs,
): Promise<EnrichCandidateRow[]> {
  if (args.sourceIds.length === 0) return [];
  return db
    .select({
      id: releases.id,
      sourceId: releases.sourceId,
      title: releases.title,
      version: releases.version,
      publishedAt: releases.publishedAt,
      content: releases.content,
      url: releases.url,
      media: releases.media,
      metadata: releases.metadata,
    })
    .from(releases)
    .where(
      and(
        inArray(releases.sourceId, [...args.sourceIds]),
        sql`${releases.url} IS NOT NULL`,
        sql`(json_extract(${releases.metadata}, '$.enrichment') IS NULL OR json_extract(${releases.metadata}, '$.enrichment.succeeded') = 0)`,
        sql`(${releases.content} = ${releases.summary} OR (${releases.summary} IS NULL AND length(${releases.content}) <= ${args.thinChars}))`,
      ),
    )
    .orderBy(sql`${releases.publishedAt} DESC`)
    .limit(args.limit) as Promise<EnrichCandidateRow[]>;
}

export interface ApplyExtractedContentArgs {
  candidates: ReadonlyArray<EnrichCandidateRow>;
  /** releaseId → parsed `<article>` body. Absent / "" / sub-floor → skipped. */
  extracted: ReadonlyMap<string, string>;
  thinChars: number;
  /** How the page was fetched, recorded in the success marker. Default "render". */
  via?: "fetch" | "render";
}

export interface ApplyExtractedContentResult {
  enriched: number;
  skipped: number;
  enrichedIds: string[];
}

/**
 * Apply parsed batch-extraction results to the candidate releases. Idempotent
 * in-place UPDATEs keyed by id, mirroring `runEnrichBackfill`'s field-set:
 *
 * - A body that clears the improvement floor replaces `content` (with refreshed
 *   size + hash), backfills article media when the row has none, stamps a
 *   `succeeded: true` marker, and nulls `summary`/`titleGenerated`/`titleShort`/
 *   `embeddedAt` so the row re-summarizes + re-embeds on the richer body.
 * - Anything else (empty `<article>` JS-shell signal, sub-floor body, or a
 *   missing batch result) writes only a `succeeded: false` marker and leaves the
 *   stored content untouched (fail-open: never lose the feed summary).
 *
 * Sequential per-row UPDATEs (not chunked): the enrichment backfill set is
 * bounded (≤ a few hundred rows), so the round-trips are acceptable and the code
 * stays a one-to-one mirror of the synchronous route.
 */
export async function applyExtractedContent(
  db: AnyDb,
  args: ApplyExtractedContentArgs,
): Promise<ApplyExtractedContentResult> {
  const via = args.via ?? "render";
  const enrichedIds: string[] = [];
  let enriched = 0;
  let skipped = 0;

  for (const row of args.candidates) {
    const attemptedAt = new Date().toISOString();
    const content = args.extracted.get(row.id);
    const floor = enrichmentFloor(row.content, args.thinChars);

    if (!content || content.length < floor) {
      skipped++;
      // oxlint-disable-next-line no-await-in-loop -- bounded candidate set; sequential mirrors the sync route
      await db
        .update(releases)
        .set({ metadata: mergeEnrichmentMarker(row.metadata, { attemptedAt, succeeded: false }) })
        .where(eq(releases.id, row.id));
      continue;
    }

    const size = computeContentSize(content);
    const media = extractMediaFromMarkdown(content);
    // Only backfill media from the article when the release has none — never
    // clobber existing feed / curated images.
    const mediaJson =
      !hasStoredMedia(row.media) && media.length > 0
        ? JSON.stringify(
            // oxlint-disable-next-line no-map-spread
            media.map((m) => ({ ...m, url: normalizeMediaUrl(m.url) })),
          )
        : undefined;

    // oxlint-disable-next-line no-await-in-loop -- bounded candidate set; sequential mirrors the sync route
    await db
      .update(releases)
      .set({
        content,
        contentChars: size.contentChars,
        contentTokens: size.contentTokens,
        contentHash: contentHash({
          title: row.title,
          version: row.version ?? undefined,
          publishedAt: row.publishedAt ? new Date(row.publishedAt) : undefined,
          content,
        }),
        ...(mediaJson !== undefined ? { media: mediaJson } : {}),
        metadata: mergeEnrichmentMarker(row.metadata, { attemptedAt, succeeded: true, via }),
        // Force summary + embedding refresh on the richer body.
        summary: null,
        titleGenerated: null,
        titleShort: null,
        embeddedAt: null,
      })
      .where(eq(releases.id, row.id));

    enriched++;
    enrichedIds.push(row.id);
  }

  return { enriched, skipped, enrichedIds };
}
