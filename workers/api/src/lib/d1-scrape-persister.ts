/**
 * Direct-D1 `ScrapePersister` for the API worker's deterministic update
 * workflow (#1946 phase 4, task 6). It mirrors `httpPersister`'s mappings while
 * calling the extracted ingest helpers in-process. Workflow callers have no
 * `waitUntil`, so every durable write and post-ingest effect is awaited.
 */
import { and, desc, eq } from "drizzle-orm";
import { releases, sources, type Source } from "@buildinternet/releases-core/schema";
import type { ScrapePersister } from "@releases/adapters/scrape-persister";
import { logEvent } from "@releases/lib/log-event";
import type { D1Db } from "../db.js";
import { findSourceForOrgSlug, sourceById, sourceMatchByIdOrSlug } from "../utils.js";
import {
  ingestReleaseBatch,
  runBatchIngestEffects,
  type BatchEffectsEnv,
  type BatchIngestEnv,
} from "./release-batch-ingest.js";
import { ingestFetchLog, type FetchLogEnv } from "./fetch-log-ingest.js";
import { completeSourceFetch } from "./source-fetch-complete.js";
import { saveRawSnapshot } from "./raw-snapshot.js";

export interface D1PersisterEnv extends BatchIngestEnv, BatchEffectsEnv, FetchLogEnv {
  /** Optional, matching `Env` — an unbound bucket makes `captureRawSnapshot` a no-op (mirrors the route's `no_binding` path). */
  RAW_SNAPSHOTS?: R2Bucket;
}

/**
 * Resolves a genuine not-found to `null` (mirroring `httpPersister`'s
 * `!res.ok -> null` for a 404) but rethrows on an actual DB error — a
 * transient D1 outage must not be indistinguishable from "source not found",
 * which would otherwise silently skip that source's post-insert steps
 * (#1970). Logged at warn before rethrow so it's visible in Axiom.
 */
async function resolveSource(db: D1Db, identifier: string): Promise<Source | null> {
  try {
    if (identifier.startsWith("src_")) {
      const [row] = await db.select().from(sources).where(sourceById(identifier)).limit(1);
      return row ?? null;
    }

    const slash = identifier.indexOf("/");
    if (slash > 0 && slash < identifier.length - 1) {
      return await findSourceForOrgSlug(
        db,
        identifier.slice(0, slash),
        identifier.slice(slash + 1),
      );
    }

    const [row] = await db.select().from(sources).where(sourceMatchByIdOrSlug(identifier)).limit(1);
    return row ?? null;
  } catch (err) {
    logEvent("warn", {
      component: "d1-scrape-persister",
      event: "d1-persister-source-lookup-failed",
      identifier,
      err: err instanceof Error ? err : String(err),
    });
    throw err;
  }
}

export function d1ScrapePersister(opts: {
  db: D1Db;
  env: D1PersisterEnv;
  sessionId: string;
  captureRawSnapshots: boolean;
}): ScrapePersister {
  const { db, env } = opts;

  return {
    getSource(identifier) {
      return resolveSource(db, identifier);
    },

    async getKnownReleases(source) {
      return db
        .select({
          version: releases.version,
          title: releases.title,
          publishedAt: releases.publishedAt,
        })
        .from(releases)
        .where(and(eq(releases.sourceId, source.id), eq(releases.suppressed, false)))
        .orderBy(desc(releases.publishedAt))
        .limit(10);
    },

    async insertReleases(source, entries) {
      if (entries.length === 0) return { inserted: 0, insertedIds: [] };

      const result = await ingestReleaseBatch(db, env, source, {
        releases: entries.map((r) => ({
          title: r.title,
          content: r.content,
          url: r.url ?? null,
          version: r.version ?? null,
          publishedAt: r.publishedAt?.toISOString() ?? null,
          media: JSON.stringify(r.media ?? []),
        })),
        enrichMode: false,
      });
      await runBatchIngestEffects(db, env, source, result, {
        skipEmbed: true,
        skipInvalidate: true,
      });
      return { inserted: result.inserted, insertedIds: result.insertedIds };
    },

    async updateSourceAfterFetch(source) {
      await completeSourceFetch(db, source);
    },

    async writeFetchLog(sourceId, result) {
      try {
        await ingestFetchLog(db, env, {
          sourceId,
          sessionId: opts.sessionId,
          releasesFound: result.releasesFound,
          releasesInserted: result.releasesInserted,
          durationMs: result.durationMs,
          status: result.status,
          error: result.error ?? null,
          errorCategory: result.errorCategory ?? null,
          ...(result.wasFlagged ? { wasFlagged: true } : {}),
        });
      } catch {
        // Best-effort, matching httpPersister's rejected-fetch suppression.
      }
    },

    async captureRawSnapshot(source, body) {
      if (!opts.captureRawSnapshots || body.trim().length === 0 || !env.RAW_SNAPSHOTS) return;
      try {
        await saveRawSnapshot(
          { R2: env.RAW_SNAPSHOTS, db },
          { sourceId: source.id, body, format: "markdown" },
        );
      } catch (err) {
        logEvent("warn", {
          component: "d1-scrape-persister",
          event: "raw-snapshot-failed",
          err: err instanceof Error ? err : String(err),
        });
      }
    },
  };
}
