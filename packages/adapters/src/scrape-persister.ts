/**
 * Persistence seam for `scrapeFetch` (#1946 phase 4). `ScrapePersister`
 * abstracts source reads, release inserts, source-after-fetch updates,
 * fetch-log writes, and raw-snapshot capture behind an interface so a
 * direct-DB implementation can be injected later without touching
 * `scrape-fetch.ts`'s extraction logic. `httpPersister` is the default —
 * it reproduces exactly what `scrape-fetch.ts` did inline before this seam
 * existed, calling the API worker over `apiFetcher`. The discovery worker
 * (which has no D1/R2) passes no `persister`, so it keeps using this HTTP
 * path unchanged.
 */

import type { Source } from "@buildinternet/releases-core/schema";
import { CategorizedError, type ErrorCategory } from "@releases/lib/errors";
import { logEvent } from "@releases/lib/log-event";
import type { KnownRelease, MappedEntry } from "@releases/adapters/extract";

export interface FetchLogInput {
  releasesFound: number;
  releasesInserted: number;
  durationMs: number;
  status: string;
  error?: string;
  errorCategory?: ErrorCategory;
  /** #1862 transport-only drain-vs-quiet-poll signal; never a fetch_log column. */
  wasFlagged?: boolean;
}

export interface InsertReleasesResult {
  inserted: number;
  /** rel_ ids of affected rows; empty when the impl cannot know them (pre-extension HTTP). */
  insertedIds: string[];
}

export interface ScrapePersister {
  getSource(identifier: string): Promise<Source | null>;
  getKnownReleases(source: Source): Promise<KnownRelease[]>;
  insertReleases(source: Source, releases: MappedEntry[]): Promise<InsertReleasesResult>;
  updateSourceAfterFetch(source: Source): Promise<void>;
  /** Best-effort inside the impl — must never throw. */
  writeFetchLog(sourceId: string, result: FetchLogInput): Promise<void>;
  /** Gated + best-effort inside the impl — must never throw. */
  captureRawSnapshot(source: Source, body: string): Promise<void>;
}

export interface HttpPersisterEnv {
  /** Service binding or fetcher for API worker calls. */
  apiFetcher: { fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  apiKey: string;
  sessionId?: string;
  /**
   * `true` to capture the scraped markdown body as a raw snapshot (#1283).
   * The discovery worker has no D1/R2, so `runScrapePath` POSTs the body to the
   * API worker's raw-snapshot endpoint for later re-extraction (#1284).
   * Resolved per session from the `raw-snapshot-capture-enabled` flag.
   */
  captureRawSnapshots?: boolean;
}

/**
 * Build an org-scoped sub-resource path for a source. Mirrors the helper in
 * `extract-deps-worker.ts` — passing `source.orgId` + `source.id` (both
 * `org_…`/`src_…` IDs) avoids the bare-slug ambiguity that #690 introduced
 * and unblocks the planned 400-on-bare-slug rejection (#698).
 */
export function sourceSubpath(source: Source, sub?: string): string {
  const tail = sub ? `/${sub}` : "";
  return `/v1/orgs/${encodeURIComponent(source.orgId)}/sources/${encodeURIComponent(source.id)}${tail}`;
}

/**
 * Default `ScrapePersister` — reproduces today's HTTP-via-API-worker
 * behavior exactly (moved, not rewritten, from `scrape-fetch.ts`). Two
 * additive deltas vs. the pre-seam helpers: `insertReleases` now returns
 * `insertedIds` (empty when the API response predates that field), and
 * `wasFlagged` is still only sent on the wire when true.
 */
export function httpPersister(env: HttpPersisterEnv): ScrapePersister {
  return {
    async getSource(identifier) {
      // Callers (cron triggers, manual scrape requests, the agent's manage_source
      // fetch fallback) hand us a `src_…` ID, an `org/slug` coordinate, or a bare
      // slug. Typed IDs and coordinates have unambiguous routes after #698 — bare
      // slugs are rejected on the legacy path. Pick the right URL by shape so the
      // coordinate form (used by the agent fallback once #710 lands) doesn't 404.
      const slash = identifier.indexOf("/");
      const url = identifier.startsWith("src_")
        ? `https://api/v1/sources/${encodeURIComponent(identifier)}`
        : slash > 0 && slash < identifier.length - 1
          ? `https://api/v1/orgs/${encodeURIComponent(identifier.slice(0, slash))}/sources/${encodeURIComponent(identifier.slice(slash + 1))}`
          : `https://api/v1/sources/${encodeURIComponent(identifier)}`;
      const res = await env.apiFetcher.fetch(url, {
        headers: { Authorization: `Bearer ${env.apiKey}` },
      });
      if (!res.ok) return null;
      return res.json() as Promise<Source>;
    },

    async getKnownReleases(source) {
      const res = await env.apiFetcher.fetch(
        `https://api${sourceSubpath(source, "known-releases")}?limit=10`,
        { headers: { Authorization: `Bearer ${env.apiKey}` } },
      );
      if (!res.ok) return [];
      return (await res.json()) as KnownRelease[];
    },

    async insertReleases(source, releases) {
      if (releases.length === 0) return { inserted: 0, insertedIds: [] };

      const res = await env.apiFetcher.fetch(
        `https://api${sourceSubpath(source, "releases/batch")}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.apiKey}`,
          },
          body: JSON.stringify({
            releases: releases.map((r) => ({
              title: r.title,
              content: r.content,
              url: r.url ?? null,
              version: r.version ?? null,
              publishedAt: r.publishedAt?.toISOString() ?? null,
              media: JSON.stringify(r.media ?? []),
            })),
          }),
        },
      );

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new CategorizedError("infra", `Release insert failed (${res.status}): ${body}`);
      }

      const result = (await res.json()) as { inserted: number; insertedIds?: string[] };
      return { inserted: result.inserted, insertedIds: result.insertedIds ?? [] };
    },

    async updateSourceAfterFetch(source) {
      await env.apiFetcher.fetch(`https://api${sourceSubpath(source)}`, {
        method: "PATCH",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${env.apiKey}`,
        },
        body: JSON.stringify({
          lastFetchedAt: new Date().toISOString(),
          changeDetectedAt: null,
          consecutiveErrors: 0,
          consecutiveNoChange: 0,
          // Clear any error backoff a prior deterministic failure set (#1851) so a
          // recovered source resumes its normal tier cadence immediately instead of
          // waiting out a stale `next_fetch_after`.
          nextFetchAfter: null,
        }),
      });
    },

    async writeFetchLog(sourceId, result) {
      await env.apiFetcher
        .fetch("https://api/v1/admin/logs/fetch", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${env.apiKey}`,
          },
          body: JSON.stringify({
            sourceId,
            sessionId: env.sessionId ?? null,
            releasesFound: result.releasesFound,
            releasesInserted: result.releasesInserted,
            durationMs: result.durationMs,
            status: result.status,
            error: result.error ?? null,
            errorCategory: result.errorCategory ?? null,
            ...(result.wasFlagged ? { wasFlagged: true } : {}),
          }),
        })
        .catch(() => {}); // best-effort
    },

    async captureRawSnapshot(source, body) {
      if (!env.captureRawSnapshots || body.trim().length === 0) return;
      try {
        const res = await env.apiFetcher.fetch(
          `https://api${sourceSubpath(source, "raw-snapshot")}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.apiKey}` },
            body: JSON.stringify({ body, format: "markdown" }),
          },
        );
        if (!res.ok) {
          logEvent("warn", {
            component: "scrape-fetch",
            event: "raw-snapshot-capture-failed",
            sourceSlug: source.slug,
            status: res.status,
          });
        }
      } catch (err) {
        logEvent("warn", {
          component: "scrape-fetch",
          event: "raw-snapshot-capture-error",
          sourceSlug: source.slug,
          err: err instanceof Error ? err : String(err),
        });
      }
    },
  };
}
