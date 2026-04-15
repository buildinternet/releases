/**
 * Embed + upsert helper for release rows.
 *
 * Called as a side effect on write paths (see src/db/queries.ts#insertReleases
 * and workers/api/src/routes/sources.ts batch insert). The key contract:
 *
 *   **Embedding failure MUST NEVER fail the write.**
 *
 * All errors are caught and logged. Rows whose embedding call failed simply
 * stay with `embedded_at = NULL`; the backfill CLI sweeps them up later.
 *
 * Runtime-agnostic: accepts a `VectorizeIndex` binding and an `embedConfig`
 * override so the same helper works inside the API Worker (Vectorize binding)
 * and, in theory, anywhere else that can produce a binding. The local CLI has
 * no Vectorize binding so the release ingest path there simply never calls
 * this — semantic search is remote-only for now.
 */

import { embedBatch, type EmbeddingConfig } from "./embeddings.js";
import type { VectorizeIndex, VectorMetadataValue } from "./vector-search.js";

export interface EmbedReleaseInput {
  id: string;
  title: string;
  content: string;
  contentSummary: string | null;
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
}

/** Max characters of fallback content body when no summary is available. */
const CONTENT_FALLBACK_CHARS = 4_000;

/**
 * Build the text blob to embed. Structure matters less than the content
 * mix — we concatenate title, version, and a body candidate separated by
 * newlines so the embedding captures both the label and the substance.
 */
function buildReleaseText(row: EmbedReleaseInput): string {
  const parts: string[] = [row.title];
  if (row.version) parts.push(row.version);
  const body =
    (row.contentSummary && row.contentSummary.trim().length > 0
      ? row.contentSummary
      : row.content ?? "").slice(0, CONTENT_FALLBACK_CHARS);
  if (body.length > 0) parts.push(body);
  return parts.join("\n");
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
export async function embedAndUpsertReleases(
  opts: EmbedAndUpsertReleasesOptions,
): Promise<void> {
  const { releases, vectorIndex, embedConfig, onPersisted } = opts;
  const logger = opts.logger ?? console;

  if (!releases || releases.length === 0) return;

  try {
    const texts = releases.map(buildReleaseText);
    const { vectors } = await embedBatch(texts, embedConfig);

    if (vectors.length !== releases.length) {
      logger.warn(
        `[embed-releases] vector count mismatch (${vectors.length} vs ${releases.length}) — skipping upsert`,
      );
      return;
    }

    // Vectorize v1 caps upserts at 1000 vectors per call (April 2026). Keep
    // well under that with a conservative chunk size — most ingest batches
    // are much smaller anyway.
    const UPSERT_CHUNK = 500;
    const persisted: string[] = [];
    for (let i = 0; i < releases.length; i += UPSERT_CHUNK) {
      const chunk = releases.slice(i, i + UPSERT_CHUNK);
      const chunkVectors = vectors.slice(i, i + UPSERT_CHUNK);
      const upsertPayload = chunk.map((r, idx) => ({
        id: r.id,
        values: chunkVectors[idx],
        metadata: buildMetadata(r),
      }));
      try {
        await vectorIndex.upsert(upsertPayload);
        persisted.push(...chunk.map((r) => r.id));
      } catch (err) {
        logger.warn(
          `[embed-releases] Vectorize upsert failed for chunk of ${chunk.length}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    if (persisted.length > 0 && onPersisted) {
      try {
        await onPersisted(persisted);
      } catch (err) {
        logger.warn(
          `[embed-releases] onPersisted callback failed for ${persisted.length} id(s): ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } catch (err) {
    logger.warn(
      `[embed-releases] embed pipeline failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
