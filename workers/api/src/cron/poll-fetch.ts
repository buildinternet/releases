import { eq, and, or, sql, isNull } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sources, releases, fetchLog } from "@released/db/schema.js";
import type { Source } from "@released/db/schema.js";
import { headCheckFeed, fetchAndParseFeed, getSourceMeta } from "@released/adapters/feed.js";
import type { SourceMetadata } from "@released/adapters/feed.js";
import { contentHash } from "@released/adapters/resolve.js";
import type { RawRelease } from "@released/adapters/types.js";

// ── Tier intervals (hours) ──

type PollTier = "normal" | "low";

const TIER_INTERVALS: Record<PollTier, number> = {
  normal: 4,
  low: 24,
};

const POLL_CONCURRENCY = 5;
const FETCH_CONCURRENCY = 3;

// ── Main entry point ──

export async function pollAndFetch(env: { DB: D1Database; GITHUB_TOKEN?: string; CRON_ENABLED?: string }): Promise<void> {
  if (env.CRON_ENABLED === "false") {
    console.log("[cron] Disabled via CRON_ENABLED=false, skipping");
    return;
  }

  const db = drizzle(env.DB);
  const now = new Date();

  // Query sources due for a poll
  const dueSources = await queryDueSources(db, now);
  if (dueSources.length === 0) return;

  console.log(`[cron] Polling ${dueSources.length} due source(s)`);

  // Poll phase: HEAD checks
  const pollResults = await runWithConcurrency(dueSources, POLL_CONCURRENCY, async (source) => {
    return pollOne(db, source, now);
  });

  // Fetch phase: fetch changed feed/github sources
  const fetchable = pollResults
    .filter((r) => r.changed)
    .map((r) => r.source)
    .filter((s) => s.type === "feed" || s.type === "github");

  if (fetchable.length > 0) {
    console.log(`[cron] Fetching ${fetchable.length} changed source(s)`);
    await runWithConcurrency(fetchable, FETCH_CONCURRENCY, async (source) => {
      return fetchOne(db, source, env);
    });
  }

  const changedScrape = pollResults.filter((r) => r.changed).map((r) => r.source).filter((s) => s.type === "scrape" || s.type === "agent");
  if (changedScrape.length > 0) {
    console.log(`[cron] ${changedScrape.length} scrape/agent source(s) flagged for CLI pickup`);
  }
}

// ── Query due sources ──

async function queryDueSources(db: ReturnType<typeof drizzle>, now: Date): Promise<Source[]> {
  const notDisabled = sql`(${sources.isHidden} = 0 OR ${sources.isHidden} IS NULL)`;
  const notPaused = sql`${sources.fetchPriority} != 'paused'`;
  // Include sources that have a feed URL OR are GitHub type (GitHub sources
  // don't store a feedUrl — they use the GitHub releases API directly)
  const pollable = sql`(json_extract(${sources.metadata}, '$.feedUrl') IS NOT NULL OR ${sources.type} = 'github')`;

  // Build OR conditions for each tier using sql template to avoid enum type issues
  const tierConditions = (Object.keys(TIER_INTERVALS) as PollTier[]).map((tier) => {
    const hours = TIER_INTERVALS[tier];
    const cutoff = new Date(now.getTime() - hours * 3600_000).toISOString();
    return and(
      sql`${sources.fetchPriority} = ${tier}`,
      or(
        isNull(sources.lastPolledAt),
        sql`${sources.lastPolledAt} < ${cutoff}`,
      ),
    );
  });

  return db.select().from(sources).where(
    and(
      notDisabled,
      pollable,
      notPaused,
      or(...tierConditions),
    ),
  );
}

// ── Poll one source ──

interface PollResult {
  source: Source;
  changed: boolean;
}

async function pollOne(db: ReturnType<typeof drizzle>, source: Source, now: Date): Promise<PollResult> {
  const nowIso = now.toISOString();
  const meta = getSourceMeta(source);

  // GitHub sources don't have feeds to HEAD-check — mark as changed so
  // the fetch phase always runs (dedup happens at the DB insert level)
  if (source.type === "github") {
    await db.update(sources).set({ lastPolledAt: nowIso, changeDetectedAt: nowIso }).where(eq(sources.id, source.id));
    return { source, changed: true };
  }

  if (!meta.feedUrl) {
    await db.update(sources).set({ lastPolledAt: nowIso }).where(eq(sources.id, source.id));
    return { source, changed: false };
  }

  try {
    const result = await headCheckFeed(meta.feedUrl, {
      etag: meta.feedEtag,
      lastModified: meta.feedLastModified,
      contentLength: meta.feedContentLength,
    });

    // Update stored header values in metadata
    const metaUpdates: Partial<SourceMetadata> = {};
    if (result.etag) metaUpdates.feedEtag = result.etag;
    if (result.lastModified) metaUpdates.feedLastModified = result.lastModified;
    if (result.contentLength) metaUpdates.feedContentLength = result.contentLength;

    const updates: Record<string, unknown> = { lastPolledAt: nowIso };

    if (Object.keys(metaUpdates).length > 0) {
      const merged = { ...meta, ...metaUpdates };
      updates.metadata = JSON.stringify(merged);
    }

    const changed = result.status === "changed" || result.status === "unknown";
    if (changed) {
      updates.changeDetectedAt = nowIso;
    }

    await db.update(sources).set(updates).where(eq(sources.id, source.id));
    console.log(`[cron] Poll ${source.slug}: ${result.status} (${result.responseMs}ms)`);

    return { source, changed };
  } catch (err) {
    // Don't let one source failure stop the whole cron
    console.error(`[cron] Poll error for ${source.slug}: ${err}`);
    await db.update(sources).set({ lastPolledAt: nowIso }).where(eq(sources.id, source.id));
    return { source, changed: false };
  }
}

// ── Fetch one source ──

export interface FetchOneResult {
  releasesFound: number;
  releasesInserted: number;
  durationMs: number;
  status: "success" | "no_change" | "error";
  error?: string;
}

export async function fetchOne(
  db: ReturnType<typeof drizzle>,
  source: Source,
  env: { GITHUB_TOKEN?: string },
): Promise<FetchOneResult> {
  const start = Date.now();
  const meta = getSourceMeta(source);

  try {
    let rawReleases: RawRelease[];

    if (source.type === "github") {
      rawReleases = await fetchGitHub(source, env.GITHUB_TOKEN);
    } else {
      if (!meta.feedUrl || !meta.feedType) {
        console.warn(`[cron] Fetch ${source.slug}: missing feedUrl or feedType, skipping`);
        const dur = Date.now() - start;
        await db.insert(fetchLog).values({
          sourceId: source.id,
          releasesFound: 0,
          releasesInserted: 0,
          durationMs: dur,
          status: "error",
          error: "Missing feedUrl or feedType in source metadata",
        }).catch(() => {});
        return { releasesFound: 0, releasesInserted: 0, durationMs: dur, status: "error", error: "Missing feedUrl or feedType in source metadata" };
      }
      const conditionalHeaders: Record<string, string> = {};
      if (meta.feedEtag) conditionalHeaders["If-None-Match"] = meta.feedEtag;
      if (meta.feedLastModified) conditionalHeaders["If-Modified-Since"] = meta.feedLastModified;

      const result = await fetchAndParseFeed(
        meta.feedUrl,
        meta.feedType as "rss" | "atom" | "jsonfeed",
        { maxEntries: 200 },
        Object.keys(conditionalHeaders).length > 0 ? conditionalHeaders : undefined,
      );
      rawReleases = result.releases;

      // Update feed headers in metadata
      const metaUpdates: Partial<SourceMetadata> = {};
      if (result.etag) metaUpdates.feedEtag = result.etag;
      if (result.lastModified) metaUpdates.feedLastModified = result.lastModified;
      if (result.contentLength) metaUpdates.feedContentLength = result.contentLength;
      if (Object.keys(metaUpdates).length > 0) {
        const merged = { ...meta, ...metaUpdates };
        await db.update(sources).set({ metadata: JSON.stringify(merged) }).where(eq(sources.id, source.id));
      }
    }

    if (rawReleases.length === 0) {
      const newNoChange = (source.consecutiveNoChange ?? 0) + 1;
      const backoffHours = Math.min(Math.pow(2, newNoChange - 1), 48);
      const nextFetch = new Date(Date.now() + backoffHours * 3600_000).toISOString();
      await Promise.all([
        db.insert(fetchLog).values({
          sourceId: source.id,
          releasesFound: 0,
          releasesInserted: 0,
          durationMs: Date.now() - start,
          status: "no_change",
        }),
        db.update(sources).set({
          consecutiveNoChange: newNoChange,
          consecutiveErrors: 0,
          nextFetchAfter: nextFetch,
          changeDetectedAt: null,
        }).where(eq(sources.id, source.id)),
      ]);
      const dur = Date.now() - start;
      console.log(`[cron] Fetch ${source.slug}: no changes (${dur}ms)`);
      return { releasesFound: 0, releasesInserted: 0, durationMs: dur, status: "no_change" as const };
    }

    const rows = rawReleases.map((raw) => ({
      sourceId: source.id,
      version: raw.version ?? null,
      title: raw.title,
      content: raw.content,
      url: raw.url ?? null,
      contentHash: contentHash(raw),
      publishedAt: raw.publishedAt?.toISOString() ?? null,
      media: JSON.stringify(raw.media ?? []),
    }));

    let inserted = 0;
    for (let i = 0; i < rows.length; i += 5) {
      const chunk = rows.slice(i, i + 5);
      const result = await db.insert(releases).values(chunk)
        .onConflictDoNothing()
        .returning({ id: releases.id });
      inserted += result.length;
    }

    await Promise.all([
      db.insert(fetchLog).values({
        sourceId: source.id,
        releasesFound: rawReleases.length,
        releasesInserted: inserted,
        durationMs: Date.now() - start,
        status: inserted > 0 ? "success" : "no_change",
      }),
      db.update(sources).set({
        lastFetchedAt: new Date().toISOString(),
        consecutiveNoChange: 0,
        consecutiveErrors: 0,
        nextFetchAfter: null,
        changeDetectedAt: null,
      }).where(eq(sources.id, source.id)),
    ]);

    const dur = Date.now() - start;
    console.log(`[cron] Fetch ${source.slug}: ${inserted} new (${dur}ms)`);
    return { releasesFound: rawReleases.length, releasesInserted: inserted, durationMs: dur, status: inserted > 0 ? "success" as const : "no_change" as const };
  } catch (err) {
    console.error(`[cron] Fetch error for ${source.slug}: ${err}`);

    await db.insert(fetchLog).values({
      sourceId: source.id,
      releasesFound: 0,
      releasesInserted: 0,
      durationMs: Date.now() - start,
      status: "error",
      error: err instanceof Error ? err.message : String(err),
    }).catch(() => {});

    const newErrors = (source.consecutiveErrors ?? 0) + 1;
    const errorBackoffHours = Math.min(Math.pow(2, newErrors - 1), 72);
    const nextFetch = new Date(Date.now() + errorBackoffHours * 3600_000).toISOString();
    await db.update(sources).set({
      consecutiveErrors: newErrors,
      nextFetchAfter: nextFetch,
    }).where(eq(sources.id, source.id)).catch(() => {});

    return { releasesFound: 0, releasesInserted: 0, durationMs: Date.now() - start, status: "error" as const, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── GitHub fetch (Worker-side) ──

async function fetchGitHub(source: Source, token?: string): Promise<RawRelease[]> {
  const match = source.url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return [];
  const [, owner, rawRepo] = match;
  const repo = rawRepo.replace(/\.git$/, "");

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "released/0.1",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`,
    { headers },
  );

  if (!res.ok) {
    throw new Error(`GitHub API returned ${res.status} for ${owner}/${repo}`);
  }

  const data: Array<{
    tag_name: string;
    name: string | null;
    body: string | null;
    html_url: string;
    published_at: string | null;
  }> = await res.json();

  return data.slice(0, 200).map((rel) => ({
    version: rel.tag_name,
    title: rel.name || rel.tag_name,
    content: rel.body || "",
    url: rel.html_url,
    publishedAt: rel.published_at ? new Date(rel.published_at) : undefined,
  }));
}

// ── Concurrency helper ──

async function runWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      results.push(await fn(item));
    }
  });
  await Promise.all(workers);
  return results;
}
