/**
 * Chunk + embed + upsert pipeline for CHANGELOG files.
 *
 * The shape here is deliberately "hand off the diff to a caller-provided
 * persistence callback" because the DB driver on each side is different
 * (drizzle over D1 in the Worker vs. bun:sqlite locally, if ever). This
 * module does all the pure work — chunking, diffing, embedding, upserting
 * to Vectorize, deleting stale vectors — and then hands the caller a
 * structured payload with everything they need to update the DB.
 *
 * Failure policy: catches every error and logs it. Never throws. If embed
 * or upsert fails, the `onDiff` callback is still invoked so the caller
 * can at least update offsets / prune rows — just with an empty `embedded`
 * list so the new rows are inserted with `vectorId = null` and the
 * backfill job can pick them up later.
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
  embedded: EmbeddedChunk[];
}

export interface EmbedAndUpsertChangelogFileOptions {
  file: EmbedChangelogFileInput;
  existingChunks: ExistingChunkRow[];
  vectorIndex: VectorizeIndex;
  embedConfig?: Partial<EmbeddingConfig>;
  /**
   * Called with the diff plus any successfully-embedded chunks so the caller
   * can apply DB changes (insert new rows, delete stale rows, update
   * unchanged rows' offsets). Invoked even on partial embed failure — in
   * that case `embedded` is the subset that made it through.
   */
  onDiff: (payload: OnDiffPayload) => Promise<void>;
  logger?: EmbedLogger;
  /**
   * When true, any embed/upsert failure re-throws after logging so the caller
   * can retry (e.g. from a Cloudflare Workflow step). Default false preserves
   * the historical fire-and-forget contract. See #486.
   */
  throwOnError?: boolean;
}

export async function embedAndUpsertChangelogFile(
  opts: EmbedAndUpsertChangelogFileOptions,
): Promise<void> {
  const { file, existingChunks, vectorIndex, embedConfig, onDiff, throwOnError = false } = opts;
  const logger = opts.logger ?? console;

  let diff: DiffResult;
  let embedded: EmbeddedChunk[] = [];
  let deleteIds: string[] = [];
  let innerErr: unknown;

  try {
    const next = chunkChangelog(file.content);
    diff = diffChunks({ existing: existingChunks, next });

    // 1. Embed the new chunks (if any).
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
          innerErr ??= new Error(msg);
        }
      } catch (err) {
        logger.warn(
          `[embed-changelog-pipeline] embed failed for ${file.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        innerErr ??= err;
      }
    }

    // 2. Upsert the embedded vectors.
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
      } catch (err) {
        logger.warn(
          `[embed-changelog-pipeline] Vectorize upsert failed for ${file.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        // Wipe the embedded list so the caller inserts rows with
        // vectorId = null rather than lying about what's in Vectorize.
        embedded = [];
        innerErr ??= err;
      }
    }

    // 3. Delete stale vectors from Vectorize.
    deleteIds = diff.toDelete
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
        innerErr ??= err;
      }
    }
  } catch (err) {
    logger.warn(
      `[embed-changelog-pipeline] pipeline failed for ${file.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    if (throwOnError) throw err;
    return;
  }

  // 4. Hand off to caller for DB reconciliation. Outside the outer try so
  //    DB errors surface via the callback's own error handling.
  try {
    await onDiff({ diff, embedded });
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
    if (throwOnError) throw err;
  }

  if (throwOnError && innerErr) throw innerErr;
}
