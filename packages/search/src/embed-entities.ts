/**
 * Embed + upsert helper for entity rows (organizations, products, sources,
 * collections).
 *
 * Entities share one Vectorize index (ENTITIES_INDEX). Vector ID = the row's
 * natural ID (e.g. `org_...`, `prod_...`, `src_...`, `col_...`), so
 * re-embedding on edit is idempotent — the upsert overwrites the previous
 * vector in place. Callers downstream dispatch on the ID prefix to hydrate
 * back to the right table.
 *
 * Same "never fail the write" contract as embed-releases: all errors caught,
 * logged, and swallowed. If the embed fails, `embedded_at` is left NULL and
 * the backfill CLI sweeps the row later.
 */

import { embedBatch, type EmbeddingConfig } from "./embeddings.js";
import type { VectorizeIndex, VectorMetadataValue } from "./vector-search.js";
import type { EmbedLogger } from "./embed-releases.js";

export type EntityKind = "org" | "product" | "source" | "collection";

export interface EmbedEntityInput {
  id: string;
  kind: EntityKind;
  name: string;
  description?: string | null;
  category?: string | null;
  /** Best-effort: org.domain, source.url host, etc. */
  domain?: string | null;
  /**
   * Parent org id for products and sources. Stored in Vectorize metadata so
   * downstream features (e.g. "related sources within the same org") can
   * filter by `orgId` without hitting D1. Organizations set this to their
   * own id so the filter works uniformly. Collections are cross-org by design
   * — they leave this unset.
   */
  orgId?: string | null;
  /**
   * Member names (orgs + products) baked into the embedded text for
   * collections. Lets a topical query ("coding agents") match a collection
   * whose members cover the topic even when the collection's name/description
   * doesn't mention it. Ignored on org/product/source kinds — those embed
   * name + description + category + domain and don't need a synthetic
   * context line.
   */
  memberNames?: string[];
}

export interface EmbedAndUpsertEntitiesOptions {
  entities: EmbedEntityInput[];
  vectorIndex: VectorizeIndex;
  embedConfig?: Partial<EmbeddingConfig>;
  onPersisted?: (ids: string[]) => Promise<void>;
  logger?: EmbedLogger;
  /**
   * Re-throw the first caught error after logging. Default `false` — errors
   * are swallowed to keep the "never fail the write" contract.
   */
  throwOnError?: boolean;
}

function buildEntityText(e: EmbedEntityInput): string {
  // Cap at 32 names so very large collections don't overflow the embedder's
  // effective input window.
  const parts: string[] = [e.name, e.description ?? "", e.category ?? "", e.domain ?? ""];
  if (e.kind === "collection" && e.memberNames && e.memberNames.length > 0) {
    parts.push(`Members: ${e.memberNames.slice(0, 32).join(", ")}`);
  }
  return parts
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .join(" ");
}

function buildEntityMetadata(e: EmbedEntityInput): Record<string, VectorMetadataValue> {
  const meta: Record<string, VectorMetadataValue> = { type: e.kind };
  if (e.category) meta.category = e.category;
  if (e.orgId) meta.org_id = e.orgId;
  return meta;
}

export async function embedAndUpsertEntities(opts: EmbedAndUpsertEntitiesOptions): Promise<void> {
  const { entities, vectorIndex, embedConfig, onPersisted, throwOnError = false } = opts;
  const logger = opts.logger ?? console;

  if (!entities || entities.length === 0) return;

  try {
    const texts = entities.map(buildEntityText);
    const { vectors } = await embedBatch(texts, embedConfig);
    if (vectors.length !== entities.length) {
      const msg = `vector count mismatch (${vectors.length} vs ${entities.length})`;
      logger.warn(`[embed-entities] ${msg} — skipping upsert`);
      if (throwOnError) throw new Error(msg);
      return;
    }

    const payload = entities.map((e, i) => ({
      id: e.id,
      values: vectors[i],
      metadata: buildEntityMetadata(e),
    }));

    try {
      await vectorIndex.upsert(payload);
    } catch (err) {
      logger.warn(
        `[embed-entities] Vectorize upsert failed for ${entities.length} entity/entities: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      if (throwOnError) throw err;
      return;
    }

    if (onPersisted) {
      try {
        await onPersisted(entities.map((e) => e.id));
      } catch (err) {
        // onPersisted is bookkeeping; a retry here would re-upsert vectors
        // unnecessarily. Swallow even when throwOnError is set.
        logger.warn(
          `[embed-entities] onPersisted callback failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  } catch (err) {
    logger.warn(
      `[embed-entities] embed pipeline failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (throwOnError) throw err;
  }
}
