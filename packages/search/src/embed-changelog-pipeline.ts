/**
 * Chunk + embed + upsert pipeline for CHANGELOG files.
 *
 * Ordering (#620): D1 first with `vectorId = null`, then Vectorize, then a
 * follow-up D1 UPDATE to set `vectorId`. Both D1 phases run in caller-
 * supplied callbacks (`onDiff`, `onVectorsCommitted`) because the worker
 * uses drizzle/D1 and the OSS CLI uses bun:sqlite — the pipeline stays
 * driver-agnostic.
 *
 * Why this order: writing Vectorize first leaves a window where vectors
 * are live in Vectorize with no D1 row pointing at them — search hits
 * fail to hydrate and quietly drop. Writing D1 first with `vectorId =
 * null` means any failure between the D1 INSERT and the Vectorize UPSERT
 * leaves chunks the existing backfill job (`vectorId IS NULL`) already
 * picks up. Vector-side orphans (Vectorize has the vector, D1 has no
 * matching row) are impossible because D1 always wins the race.
 *
 * Failure policy: each phase catches and logs its own errors. The pipeline
 * only re-throws when `throwOnError = true` (the Workflows path uses this
 * so each step retries independently). Otherwise the historical fire-and-
 * forget contract is preserved — failures stop the pipeline but never
 * abort the caller's outer fetch.
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
   * Newly-embedded vectors with `vectorId` already computed (via
   * `buildVectorId`) but NOT yet committed to Vectorize. Callers MUST
   * insert chunk rows with `vectorId = null` and `embeddedAt = null` —
   * the pipeline calls `onVectorsCommitted` after Vectorize confirms
   * so the caller can run a follow-up UPDATE. Recording the vectorId
   * at insert time would invert the failure mode (#620): a worker
   * death between D1 commit and Vectorize upsert would leave D1 rows
   * pointing at vectors that don't exist, and the backfill job (which
   * scans for `vectorId IS NULL`) would not pick them up.
   */
  pending: EmbeddedChunk[];
}

export interface OnVectorsCommittedPayload {
  /**
   * Vectors that successfully landed in Vectorize. The caller should
   * UPDATE the corresponding chunk rows (matched by `vectorId`, which
   * `buildVectorId` derives deterministically from file id + content
   * hash) to set `vectorId` and `embeddedAt`. If this UPDATE fails the
   * chunks stay with `vectorId = null` and the existing embed-backfill
   * job picks them up; the next run produces the same vectorId and the
   * upsert is idempotent.
   */
  committed: EmbeddedChunk[];
}

export interface EmbedAndUpsertChangelogFileOptions {
  file: EmbedChangelogFileInput;
  existingChunks: ExistingChunkRow[];
  vectorIndex: VectorizeIndex;
  embedConfig?: Partial<EmbeddingConfig>;
  /**
   * Stage-1 callback. Apply the chunk diff to D1: delete stale rows,
   * shift unchanged rows' offsets, and insert new rows with
   * `vectorId = null` / `embeddedAt = null`. Invoked even on embed
   * failure (with `pending = []`) so the caller can still apply the
   * delete + offset-update phases.
   */
  onDiff: (payload: OnDiffPayload) => Promise<void>;
  /**
   * Stage-2 callback, invoked only after `onDiff` succeeded AND the
   * Vectorize upsert succeeded. Apply a follow-up D1 UPDATE to set
   * `vectorId` / `embeddedAt` on the rows the caller staged in
   * `onDiff`. Skipped if there is nothing to commit.
   */
  onVectorsCommitted: (payload: OnVectorsCommittedPayload) => Promise<void>;
  logger?: EmbedLogger;
  /**
   * When true, any embed/upsert/D1 failure re-throws after logging so the
   * caller can retry (e.g. from a Cloudflare Workflow step). Default
   * false preserves the historical fire-and-forget contract.
   */
  throwOnError?: boolean;
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

  // Phase 1: chunk + diff. A throw here would mean the chunker itself
  // blew up — abort the whole pipeline rather than papering over it.
  try {
    const next = chunkChangelog(file.content);
    diff = diffChunks({ existing: existingChunks, next });
  } catch (err) {
    logger.warn(
      `[embed-changelog-pipeline] chunk/diff failed for ${file.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (throwOnError) throw err;
    return;
  }

  // Phase 2: embed the new chunks. On failure log + continue with an
  // empty `embedded` list — onDiff still needs to run so the delete +
  // offset-update phases land.
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
      logger.warn(
        `[embed-changelog-pipeline] embed failed for ${file.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      firstError ??= err;
    }
  }

  // Phase 3: stage D1 changes — delete stale rows, shift unchanged
  // offsets, insert new rows with `vectorId = null`. Atomic via the
  // caller's batch. If this fails we MUST skip Vectorize writes —
  // upserting now would produce orphan vectors (vectors with no D1
  // row), which is exactly the failure mode we're trying to fix.
  let diffApplied = false;
  try {
    await onDiff({ diff, pending: embedded });
    diffApplied = true;
  } catch (err) {
    const cause =
      err instanceof Error && "cause" in err && err.cause
        ? ` cause=${err.cause instanceof Error ? err.cause.message : String(err.cause)}`
        : "";
    logger.warn(
      `[embed-changelog-pipeline] onDiff callback failed for ${file.id}: ${
        err instanceof Error ? err.message : String(err)
      }${cause}`,
    );
    firstError ??= err;
  }

  if (!diffApplied) {
    if (throwOnError && firstError) throw firstError;
    return;
  }

  // Phase 4: upsert vectors to Vectorize. Failure means the staged D1
  // rows stay with `vectorId = null` — the backfill job picks them up.
  let upserted = false;
  if (embedded.length > 0) {
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
      upserted = true;
    } catch (err) {
      logger.warn(
        `[embed-changelog-pipeline] Vectorize upsert failed for ${file.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      firstError ??= err;
    }
  }

  // Phase 5: caller UPDATEs vectorId on the staged rows. Skipped if
  // upsert failed or there was nothing to commit. Failure here is
  // recoverable via backfill (deterministic vectorId + idempotent
  // upsert).
  if (upserted) {
    try {
      await onVectorsCommitted({ committed: embedded });
    } catch (err) {
      const cause =
        err instanceof Error && "cause" in err && err.cause
          ? ` cause=${err.cause instanceof Error ? err.cause.message : String(err.cause)}`
          : "";
      logger.warn(
        `[embed-changelog-pipeline] onVectorsCommitted callback failed for ${file.id}: ${
          err instanceof Error ? err.message : String(err)
        }${cause}`,
      );
      firstError ??= err;
    }
  }

  // Phase 6: delete stale vectors from Vectorize. Their D1 rows are
  // already gone (they were in `diff.toDelete`, which `onDiff` applied).
  // Failure here only leaves orphan storage — harmless because search
  // joins via D1's `vector_id` column, and there is no D1 row pointing
  // at them.
  const deleteIds = diff.toDelete
    .map((d) => d.vectorId)
    .filter((v): v is string => typeof v === "string" && v.length > 0);
  if (deleteIds.length > 0) {
    try {
      await vectorIndex.deleteByIds(deleteIds);
    } catch (err) {
      logger.warn(
        `[embed-changelog-pipeline] Vectorize delete failed for ${file.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      firstError ??= err;
    }
  }

  if (throwOnError && firstError) throw firstError;
}
