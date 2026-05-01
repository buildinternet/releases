/**
 * Chunk + embed + upsert pipeline for CHANGELOG files.
 *
 * Ordering (#620): D1 first with `vectorId = null`, then Vectorize, then a
 * follow-up D1 UPDATE to set `vectorId`. Both D1 phases run in caller-
 * supplied callbacks (`onDiff`, `onVectorsCommitted`) so the pipeline
 * stays driver-agnostic — the API worker uses drizzle/D1 and the OSS CLI
 * uses bun:sqlite.
 *
 * Why D1-first: writing Vectorize first leaves a window where vectors
 * are live in Vectorize with no D1 row pointing at them — search hits
 * fail to hydrate and quietly drop. With D1 first, any failure between
 * the D1 INSERT and the Vectorize UPSERT leaves chunks the existing
 * `vectorId IS NULL` backfill job already picks up. Vector-side orphans
 * are at worst storage-only (search hydration filters them out via the
 * `scc.vector_id` join).
 *
 * Failure policy: each phase logs its own errors. The pipeline only
 * re-throws when `throwOnError = true` (the Workflows path uses this so
 * each step retries independently).
 */

import { embedBatch, type EmbeddingConfig } from "./embeddings.js";
import {
  chunkChangelog,
  diffChunks,
  buildVectorId,
  type Chunk,
  type DiffResult,
  type ExistingChunkRow,
} from "./embed-changelogs.js";
import type { VectorizeIndex } from "./vector-search.js";
import type { EmbedLogger } from "./embed-releases.js";

export interface EmbedChangelogFileInput {
  id: string;
  sourceId: string;
  content: string;
  contentHash: string;
}

export interface EmbeddedChunk {
  chunk: Chunk;
  vectorId: string;
  vector: number[];
}

export interface OnDiffPayload {
  diff: DiffResult;
  /**
   * Newly-embedded vectors that are NOT yet in Vectorize. Insert chunk
   * rows with `vectorId = null` / `embeddedAt = null`; the pipeline
   * calls `onVectorsCommitted` after Vectorize confirms.
   */
  pending: EmbeddedChunk[];
}

export interface OnVectorsCommittedPayload {
  /** Vectors that landed in Vectorize. UPDATE the matching rows. */
  committed: EmbeddedChunk[];
}

export interface EmbedAndUpsertChangelogFileOptions {
  file: EmbedChangelogFileInput;
  existingChunks: ExistingChunkRow[];
  vectorIndex: VectorizeIndex;
  embedConfig?: Partial<EmbeddingConfig>;
  /**
   * Stage-1 callback. Apply the chunk diff to D1 atomically (delete
   * stale, shift unchanged offsets, insert new with `vectorId = null`).
   * Invoked even on embed failure (with `pending = []`) so the delete +
   * offset-update phases still land.
   */
  onDiff: (payload: OnDiffPayload) => Promise<void>;
  /**
   * Stage-2 callback, invoked only after `onDiff` succeeded AND the
   * Vectorize upsert succeeded. Skipped when there is nothing to commit.
   */
  onVectorsCommitted: (payload: OnVectorsCommittedPayload) => Promise<void>;
  logger?: EmbedLogger;
  /**
   * When true, any embed/upsert/D1 failure re-throws after logging so
   * the caller can retry (e.g. from a Cloudflare Workflow step).
   */
  throwOnError?: boolean;
}

function formatErr(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  if (err instanceof Error && "cause" in err && err.cause) {
    const cause = err.cause instanceof Error ? err.cause.message : String(err.cause);
    return `${msg} cause=${cause}`;
  }
  return msg;
}

export async function embedAndUpsertChangelogFile(
  opts: EmbedAndUpsertChangelogFileOptions,
): Promise<void> {
  const {
    file,
    existingChunks,
    vectorIndex,
    embedConfig,
    onDiff,
    onVectorsCommitted,
    throwOnError = false,
  } = opts;
  const logger = opts.logger ?? console;

  let diff: DiffResult;
  let embedded: EmbeddedChunk[] = [];
  let firstError: unknown;

  try {
    const next = chunkChangelog(file.content);
    diff = diffChunks({ existing: existingChunks, next });
  } catch (err) {
    logger.warn(`[embed-changelog-pipeline] chunk/diff failed for ${file.id}: ${formatErr(err)}`);
    if (throwOnError) throw err;
    return;
  }

  if (diff.toInsert.length > 0) {
    try {
      const { vectors } = await embedBatch(
        diff.toInsert.map((c) => c.text),
        embedConfig,
      );
      if (vectors.length === diff.toInsert.length) {
        embedded = diff.toInsert.map((chunk, i) => ({
          chunk,
          vectorId: buildVectorId(file.id, chunk.contentHash),
          vector: vectors[i],
        }));
      } else {
        const msg = `[embed-changelog-pipeline] vector count mismatch for ${file.id}: ${vectors.length} vs ${diff.toInsert.length}`;
        logger.warn(msg);
        firstError ??= new Error(msg);
      }
    } catch (err) {
      logger.warn(`[embed-changelog-pipeline] embed failed for ${file.id}: ${formatErr(err)}`);
      firstError ??= err;
    }
  }

  // Stage D1 first. If this fails we MUST skip the Vectorize writes
  // below — upserting now would produce orphan vectors, exactly the
  // failure mode #620 fixes.
  let diffApplied = false;
  try {
    await onDiff({ diff, pending: embedded });
    diffApplied = true;
  } catch (err) {
    logger.warn(
      `[embed-changelog-pipeline] onDiff callback failed for ${file.id}: ${formatErr(err)}`,
    );
    firstError ??= err;
  }

  if (!diffApplied) {
    if (throwOnError && firstError) throw firstError;
    return;
  }

  // Vectorize upsert and stale-delete are independent — new chunks have
  // new content hashes by construction, so vectorIds are disjoint from
  // the IDs in `toDelete`. Run in parallel; each catches its own error.
  const deleteIds = diff.toDelete
    .map((d) => d.vectorId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);

  const doUpsert = async (): Promise<boolean> => {
    if (embedded.length === 0) return false;
    const payload = embedded.map((e) => ({
      id: e.vectorId,
      values: e.vector,
      metadata: {
        type: "changelog_chunk",
        source_id: file.sourceId,
        source_changelog_file_id: file.id,
        offset: e.chunk.offset,
        heading: e.chunk.heading ?? "",
      },
    }));
    try {
      await vectorIndex.upsert(payload);
      return true;
    } catch (err) {
      logger.warn(
        `[embed-changelog-pipeline] Vectorize upsert failed for ${file.id}: ${formatErr(err)}`,
      );
      firstError ??= err;
      return false;
    }
  };

  const doDeleteStale = async (): Promise<void> => {
    if (deleteIds.length === 0) return;
    try {
      await vectorIndex.deleteByIds(deleteIds);
    } catch (err) {
      logger.warn(
        `[embed-changelog-pipeline] Vectorize delete failed for ${file.id}: ${formatErr(err)}`,
      );
      firstError ??= err;
    }
  };

  const [upserted] = await Promise.all([doUpsert(), doDeleteStale()]);

  if (upserted) {
    try {
      await onVectorsCommitted({ committed: embedded });
    } catch (err) {
      logger.warn(
        `[embed-changelog-pipeline] onVectorsCommitted callback failed for ${file.id}: ${formatErr(err)}`,
      );
      firstError ??= err;
    }
  }

  if (throwOnError && firstError) throw firstError;
}
