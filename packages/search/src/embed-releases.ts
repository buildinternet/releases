/**
 * Embed + upsert helper for release rows.
 *
 * Called as a side effect on write paths (see src/db/queries.ts#insertReleases
 * and workers/api/src/routes/sources.ts batch insert). Default contract:
 *
 *   **Embedding failure MUST NEVER fail the write.**
 *
 * All errors are caught and logged. Rows whose embedding call failed simply
 * stay with `embedded_at = NULL`; the backfill CLI sweeps them up later.
 *
 * Opt-in throwing: callers that can retry the embed (e.g. a Workflows step)
 * pass `throwOnError: true` to bubble up failures after logging. Any top-level
 * error OR any failed Vectorize chunk then throws. Chunks are keyed by id, so
 * retries re-upsert idempotently.
 *
 * Runtime-agnostic: accepts a `VectorizeIndex` binding and an `embedConfig`
 * override so the same helper works inside the API Worker (Vectorize binding)
 * and, in theory, anywhere else that can produce a binding. The local CLI has
 * no Vectorize binding so the release ingest path there simply never calls
 * this — semantic search is remote-only for now.
 */

import { embedBatch, type EmbeddingConfig } from "./embeddings.js";
import type { VectorizeIndex, VectorMetadataValue } from "./vector-search.js";
import { isEmptyReleaseContent } from "./content-quality.js";

export interface EmbedReleaseInput {
  id: string;
  title: string;
  content: string;
  summary: string | null;
  version: string | null;
  publishedAt: string | null;
  sourceId: string;
  orgId?: string | null;
  productId?: string | null;
  category?: string | null;
  type: string;
}

export interface EmbedLogger {
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
  debug?: (...args: unknown[]) => void;
}

export interface EmbedAndUpsertReleasesOptions {
  releases: EmbedReleaseInput[];
  vectorIndex: VectorizeIndex;
  embedConfig?: Partial<EmbeddingConfig>;
  /** Called after a successful Vectorize upsert with the ids that landed. */
  onPersisted?: (ids: string[]) => Promise<void>;
  logger?: EmbedLogger;
  /**
   * When true, any embed/upsert failure re-throws after logging so the caller
   * can retry (e.g. from a Cloudflare Workflow step). Default false preserves
   * the historical fire-and-forget contract. See #486.
   */
  throwOnError?: boolean;
}

/** Max characters of fallback content body when no summary is available. */
const CONTENT_FALLBACK_CHARS = 4_000;

/**
 * Body candidate used for both the embed blob and the empty-content gate —
 * summary when present, otherwise a content prefix (same as buildReleaseText).
 */
function releaseBodyForEmbed(row: EmbedReleaseInput): string {
  return (row.summary && row.summary.trim().length > 0 ? row.summary : (row.content ?? "")).slice(
    0,
    CONTENT_FALLBACK_CHARS,
  );
}

/**
 * Build the text blob to embed. Structure matters less than the content
 * mix — we concatenate title, version, and a body candidate separated by
 * newlines so the embedding captures both the label and the substance.
 */
function buildReleaseText(row: EmbedReleaseInput): string {
  const parts: string[] = [row.title];
  if (row.version) parts.push(row.version);
  const body = releaseBodyForEmbed(row);
  if (body.length > 0) parts.push(body);
  return parts.join("\n");
}

/** True when this row would only produce a noise vector (placeholder/empty). */
export function shouldSkipReleaseEmbed(row: EmbedReleaseInput): boolean {
  const body = releaseBodyForEmbed(row);
  return isEmptyReleaseContent({
    title: row.title,
    summary: body,
    contentChars: body.length > 0 ? body.length : (row.title?.length ?? 0),
  });
}

function buildMetadata(row: EmbedReleaseInput): Record<string, VectorMetadataValue> {
  const meta: Record<string, VectorMetadataValue> = {
    type: "release",
    source_id: row.sourceId,
    release_type: row.type,
  };
  if (row.orgId) meta.org_id = row.orgId;
  if (row.productId) meta.product_id = row.productId;
  if (row.category) meta.category = row.category;
  if (row.publishedAt) meta.published_at = row.publishedAt;
  return meta;
}

/**
 * Embed a batch of releases and upsert them into Vectorize. Catches every
 * error internally — callers never need to wrap this in try/catch. Returns
 * silently on any failure; inspect the logger output for diagnostics.
 */
export async function embedAndUpsertReleases(opts: EmbedAndUpsertReleasesOptions): Promise<void> {
  const { releases, vectorIndex, embedConfig, onPersisted, throwOnError = false } = opts;
  const logger = opts.logger ?? console;

  if (!releases || releases.length === 0) return;

  // Accumulate the first failure across each narrow catch below. Every
  // failure is logged at its own site; `throwOnError` only re-throws at the
  // end to avoid double-logging the same error through a wrapping catch.
  let innerErr: unknown;

  // Empty / placeholder bodies (title+summary "test", short "no changes", …)
  // produce magnet vectors that pollute hybrid RRF. Skip the embed API,
  // best-effort delete any existing Vectorize row, and still mark persisted
  // so backfill does not loop forever. Search hydration also drops empty
  // tier — this stops new junk from entering the index.
  const toEmbed: EmbedReleaseInput[] = [];
  const skippedEmpty: EmbedReleaseInput[] = [];
  for (const row of releases) {
    if (shouldSkipReleaseEmbed(row)) skippedEmpty.push(row);
    else toEmbed.push(row);
  }

  if (skippedEmpty.length > 0) {
    logger.debug?.(
      `[embed-releases] skipping ${skippedEmpty.length} empty-body release(s): ${skippedEmpty
        .map((r) => r.id)
        .join(", ")}`,
    );
    try {
      await vectorIndex.deleteByIds(skippedEmpty.map((r) => r.id));
    } catch (err) {
      // Missing vectors or transient Vectorize errors — not fatal; search
      // still filters empty at hydrate time.
      logger.warn(
        `[embed-releases] Vectorize delete for empty-body releases failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      innerErr ??= err;
    }
  }

  const persisted: string[] = [];

  if (toEmbed.length > 0) {
    let vectors: number[][];
    try {
      const texts = toEmbed.map(buildReleaseText);
      ({ vectors } = await embedBatch(texts, embedConfig));
    } catch (err) {
      logger.warn(
        `[embed-releases] embed pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      if (throwOnError) throw err;
      // Still try to mark empty skips persisted below when throwOnError is off.
      vectors = [];
    }

    if (vectors.length > 0 && vectors.length !== toEmbed.length) {
      const msg = `[embed-releases] vector count mismatch (${vectors.length} vs ${toEmbed.length}) — skipping upsert`;
      logger.warn(msg);
      if (throwOnError) throw new Error(msg);
    } else if (vectors.length === toEmbed.length) {
      // Vectorize v1 caps upserts at 1000 vectors per call (April 2026). Keep
      // well under that with a conservative chunk size — most ingest batches
      // are much smaller anyway.
      const UPSERT_CHUNK = 500;
      for (let i = 0; i < toEmbed.length; i += UPSERT_CHUNK) {
        const chunk = toEmbed.slice(i, i + UPSERT_CHUNK);
        const chunkVectors = vectors.slice(i, i + UPSERT_CHUNK);
        const upsertPayload = chunk.map((r, idx) => ({
          id: r.id,
          values: chunkVectors[idx],
          metadata: buildMetadata(r),
        }));
        try {
          // oxlint-disable-next-line no-await-in-loop -- Vectorize D1 chunking; chunks must be upserted sequentially to respect batch limits
          await vectorIndex.upsert(upsertPayload);
          persisted.push(...chunk.map((r) => r.id));
        } catch (err) {
          logger.warn(
            `[embed-releases] Vectorize upsert failed for chunk of ${chunk.length}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
          innerErr ??= err;
        }
      }
    }
  }

  // Mark empty skips as "done" so admin embed backfill does not re-queue them.
  // They have no vector (deleted above); FTS may still match but search
  // hydration drops empty-tier hits.
  persisted.push(...skippedEmpty.map((r) => r.id));

  if (persisted.length > 0 && onPersisted) {
    try {
      await onPersisted(persisted);
    } catch (err) {
      logger.warn(
        `[embed-releases] onPersisted callback failed for ${persisted.length} id(s): ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      innerErr ??= err;
    }
  }

  if (throwOnError && innerErr) throw innerErr;
}
