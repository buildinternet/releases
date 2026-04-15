import { eq, and, or, sql, isNull, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import { sources, releases, fetchLog, sourceChangelogFiles, sourceChangelogChunks } from "@releases/db/schema.js";
import { countTokensSafe } from "@releases/lib/tokens.js";
import { notDisabled } from "../queries/shared.js";
import type { Source } from "@releases/db/schema.js";
import { headCheckFeed, fetchAndParseFeed, getSourceMeta } from "@releases/adapters/feed.js";
import type { SourceMetadata } from "@releases/adapters/feed.js";
import { contentHash } from "@releases/adapters/resolve.js";
import type { RawRelease } from "@releases/adapters/types.js";
import { normalizeMediaUrl } from "@releases/lib/media-url.js";
import { embedAndUpsertChangelogFile } from "@releases/lib/embed-changelog-pipeline.js";
import { buildEmbedConfig } from "../lib/embed-config.js";
import type { VectorizeIndex } from "@releases/lib/vector-search.js";
import { embedAndUpsertReleases } from "@releases/lib/embed-releases.js";

// ── Tier intervals (hours) ──

type PollTier = "normal" | "low";

const TIER_INTERVALS: Record<PollTier, number> = {
  normal: 4,
  low: 24,
};

const POLL_CONCURRENCY = 5;
const FETCH_CONCURRENCY = 3;

// ── Main entry point ──

export async function pollAndFetch(env: FetchOneEnv & { DB: D1Database; CRON_ENABLED?: string }): Promise<void> {
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
    console.log(`[cron] ${changedScrape.length} scrape/agent source(s) flagged for pickup`);
  }
}

// ── Query due sources ──

async function queryDueSources(db: ReturnType<typeof drizzle>, now: Date): Promise<Source[]> {
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

export interface FetchOneEnv {
  GITHUB_TOKEN?: string;
  /**
   * Optional Vectorize bindings for semantic-search side effects. Typed as
   * `unknown` because the workers-types `VectorizeIndex` declares a stricter
   * metadata value type than the runtime-agnostic interface in
   * `@releases/lib/vector-search.js`. Identical at runtime but the variance
   * prevents structural assignment; helpers below cast at the call site.
   */
  RELEASES_INDEX?: unknown;
  CHANGELOG_CHUNKS_INDEX?: unknown;
  EMBEDDING_PROVIDER?: string;
  VOYAGE_API_KEY?: { get(): Promise<string> };
  OPENAI_API_KEY?: { get(): Promise<string> };
}

export async function fetchOne(
  db: ReturnType<typeof drizzle>,
  source: Source,
  env: FetchOneEnv,
  opts?: { sessionId?: string },
): Promise<FetchOneResult> {
  const start = Date.now();
  const meta = getSourceMeta(source);
  const sessionId = opts?.sessionId ?? null;

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
          sessionId,
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
          sessionId,
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
      // Unwrap Next.js/Vercel image optimizer URLs so downstream R2 upload
      // and direct rendering both see the underlying CDN asset. Mirrors the
      // CLI-side filterJunkMedia normalize step in src/lib/media.ts.
      media: JSON.stringify(
        (raw.media ?? []).map((m) => ({ ...m, url: normalizeMediaUrl(m.url) })),
      ),
    }));

    let inserted = 0;
    const insertedIds: string[] = [];
    for (let i = 0; i < rows.length; i += 5) {
      const chunk = rows.slice(i, i + 5);
      const result = await db.insert(releases).values(chunk)
        .onConflictDoNothing()
        .returning({ id: releases.id });
      inserted += result.length;
      for (const r of result) insertedIds.push(r.id);
    }

    // Embed newly-inserted releases as a best-effort side effect. Failure
    // never aborts the fetch. Runs inline rather than in waitUntil because
    // fetchOne is already inside cron / a waitUntil boundary at the callers.
    if (insertedIds.length > 0 && env.RELEASES_INDEX) {
      try {
        await embedReleasesForSource(db, source, insertedIds, env);
      } catch (err) {
        console.warn(`[cron] release embed failed for ${source.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await Promise.all([
      db.insert(fetchLog).values({
        sourceId: source.id,
        sessionId,
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

    // Refresh canonical CHANGELOG file for GitHub sources (mirrors CLI fetch step
    // in src/cli/commands/fetch.ts). Never fail the outer fetch if this errors.
    if (source.type === "github") {
      try {
        await refreshChangelogFile(db, source, env.GITHUB_TOKEN, env);
      } catch (err) {
        console.warn(`[cron] Changelog refresh failed for ${source.slug}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const dur = Date.now() - start;
    console.log(`[cron] Fetch ${source.slug}: ${inserted} new (${dur}ms)`);
    return { releasesFound: rawReleases.length, releasesInserted: inserted, durationMs: dur, status: inserted > 0 ? "success" as const : "no_change" as const };
  } catch (err) {
    console.error(`[cron] Fetch error for ${source.slug}: ${err}`);

    await db.insert(fetchLog).values({
      sourceId: source.id,
      sessionId,
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

// Source of truth: src/adapters/github.ts#fetchChangelogFiles. Worker uses
// Web Crypto + Hono db binding, so the implementation is duplicated rather
// than imported to keep the worker bundle free of Node/Bun globals.

const CHANGELOG_FILENAMES = [
  "CHANGELOG.md",
  "CHANGELOG.rst",
  "CHANGELOG.txt",
  "CHANGELOG",
  "CHANGES.md",
  "CHANGES.rst",
  "HISTORY.md",
  "RELEASES.md",
  "NEWS.md",
];

const CHANGELOG_MAX_BYTES = 1024 * 1024;
const CHANGELOG_MAX_FILES = 20;

interface GitHubContentEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "submodule";
}

async function sha256HexWorker(input: string): Promise<string> {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function truncateToByteCap(content: string): { content: string; bytes: number; truncated: boolean } {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(content).length;
  if (bytes <= CHANGELOG_MAX_BYTES) return { content, bytes, truncated: false };
  let lo = 0;
  let hi = content.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (encoder.encode(content.slice(0, mid)).length <= CHANGELOG_MAX_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  const sliced = content.slice(0, lo);
  return { content: sliced, bytes: encoder.encode(sliced).length, truncated: true };
}

function parseWorkspaces(pkgJsonText: string): string[] {
  try {
    const parsed = JSON.parse(pkgJsonText) as { workspaces?: unknown };
    const ws = parsed.workspaces;
    if (!ws) return [];
    if (Array.isArray(ws)) return ws.filter((x): x is string => typeof x === "string");
    if (typeof ws === "object" && ws !== null && Array.isArray((ws as { packages?: unknown }).packages)) {
      return ((ws as { packages: unknown[] }).packages).filter((x): x is string => typeof x === "string");
    }
    return [];
  } catch {
    return [];
  }
}

async function listDirContents(
  owner: string,
  repo: string,
  dir: string,
  apiHeaders: Record<string, string>,
): Promise<GitHubContentEntry[] | null> {
  try {
    const url = dir
      ? `https://api.github.com/repos/${owner}/${repo}/contents/${dir}`
      : `https://api.github.com/repos/${owner}/${repo}/contents/`;
    const res = await fetch(url, { headers: apiHeaders });
    if (!res.ok) return null;
    return (await res.json()) as GitHubContentEntry[];
  } catch {
    return null;
  }
}

function pickChangelog(entries: GitHubContentEntry[]): string | null {
  const files = new Set(entries.filter((e) => e.type === "file").map((e) => e.name));
  return CHANGELOG_FILENAMES.find((name) => files.has(name)) ?? null;
}

interface WorkerFetchedFile {
  path: string;
  filename: string;
  url: string;
  rawUrl: string;
  content: string;
  contentHashHex: string;
  bytes: number;
  truncated: boolean;
}

async function fetchOneFile(
  owner: string,
  repo: string,
  dir: string,
  filename: string,
  rawHeaders: Record<string, string>,
  sourceSlug: string,
): Promise<WorkerFetchedFile | null> {
  const fullPath = dir ? `${dir}/${filename}` : filename;
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/${fullPath}`;
  let res: Response;
  try {
    res = await fetch(rawUrl, { headers: rawHeaders });
  } catch (err) {
    console.warn(`[cron] refreshChangelogFile(${sourceSlug}): raw fetch failed for ${fullPath}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  if (!res.ok) {
    console.warn(`[cron] refreshChangelogFile(${sourceSlug}): raw fetch ${res.status} for ${fullPath}`);
    return null;
  }
  const raw = await res.text();
  const { content, bytes, truncated } = truncateToByteCap(raw);
  if (truncated) {
    console.warn(`[cron] refreshChangelogFile(${sourceSlug}): ${fullPath} exceeds size cap, truncated to ${bytes} bytes`);
  }
  const contentHashHex = await sha256HexWorker(content);
  return {
    path: fullPath,
    filename,
    url: `https://github.com/${owner}/${repo}/blob/HEAD/${fullPath}`,
    rawUrl,
    content,
    contentHashHex,
    bytes,
    truncated,
  };
}

/**
 * Discover and refresh all tracked CHANGELOG files for a GitHub source —
 * root plus per-package files resolved from `package.json#workspaces`.
 * Capped at CHANGELOG_MAX_FILES. Emits one info log summarizing file/request
 * counts. Callers (cron) wrap this in a try/catch so the outer fetch never
 * fails on a changelog refresh error.
 */
async function refreshChangelogFile(
  db: ReturnType<typeof drizzle>,
  source: Source,
  token: string | undefined,
  env: FetchOneEnv,
): Promise<void> {
  const match = source.url.match(/github\.com\/([^/]+)\/([^/]+)/);
  if (!match) return;
  const [, owner, rawRepo] = match;
  const repo = rawRepo.replace(/\.git$/, "");

  const apiHeaders: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "releases/0.1",
  };
  if (token) apiHeaders.Authorization = `Bearer ${token}`;
  const rawHeaders: Record<string, string> = { "User-Agent": "releases/0.1" };
  if (token) rawHeaders.Authorization = `Bearer ${token}`;

  let requestCount = 0;
  const fetched: WorkerFetchedFile[] = [];

  // Override path via source.metadata.changelogPaths.
  let override: string[] | null = null;
  if (source.metadata) {
    try {
      const meta = JSON.parse(source.metadata) as { changelogPaths?: unknown };
      if (Array.isArray(meta.changelogPaths)) {
        override = (meta.changelogPaths as unknown[]).filter((x): x is string => typeof x === "string");
      }
    } catch {
      override = null;
    }
  }

  const rootListing = await listDirContents(owner, repo, "", apiHeaders);
  requestCount++;
  if (!rootListing) {
    console.log(`[cron] refreshChangelogFile(${source.slug}): 0 files, ${requestCount} requests`);
    return;
  }
  const rootFilename = pickChangelog(rootListing);
  if (rootFilename) {
    const f = await fetchOneFile(owner, repo, "", rootFilename, rawHeaders, source.slug);
    requestCount++;
    if (f) fetched.push(f);
  }

  if (override && override.length > 0) {
    const seen = new Set(fetched.map((f) => f.path));
    for (const entry of override) {
      if (fetched.length >= CHANGELOG_MAX_FILES) break;
      const normalized = entry.replace(/^\.?\//, "");
      if (seen.has(normalized)) continue;
      const lastSlash = normalized.lastIndexOf("/");
      const dir = lastSlash === -1 ? "" : normalized.slice(0, lastSlash);
      const filename = lastSlash === -1 ? normalized : normalized.slice(lastSlash + 1);
      const f = await fetchOneFile(owner, repo, dir, filename, rawHeaders, source.slug);
      requestCount++;
      if (f) {
        fetched.push(f);
        seen.add(f.path);
      }
    }
  } else {
    const hasPkg = rootListing.some((e) => e.type === "file" && e.name === "package.json");
    if (hasPkg) {
      let pkgText: string | null = null;
      try {
        const pr = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/HEAD/package.json`, { headers: rawHeaders });
        requestCount++;
        if (pr.ok) pkgText = await pr.text();
      } catch {
        pkgText = null;
      }
      const globs = pkgText ? parseWorkspaces(pkgText) : [];
      const packageDirs: string[] = [];
      for (const glob of globs) {
        if (packageDirs.length + fetched.length >= CHANGELOG_MAX_FILES) break;
        const trimmed = glob.replace(/\/$/, "");
        if (trimmed.startsWith("!") || trimmed.includes("**")) continue;
        if (trimmed.endsWith("/*")) {
          const parent = trimmed.slice(0, -2);
          if (!parent || parent.includes("*")) continue;
          const parentEntries = await listDirContents(owner, repo, parent, apiHeaders);
          requestCount++;
          if (!parentEntries) continue;
          for (const entry of parentEntries) {
            if (entry.type !== "dir") continue;
            packageDirs.push(`${parent}/${entry.name}`);
            if (packageDirs.length + fetched.length >= CHANGELOG_MAX_FILES) break;
          }
        } else if (!trimmed.includes("*")) {
          packageDirs.push(trimmed);
        }
      }
      for (const dir of packageDirs) {
        if (fetched.length >= CHANGELOG_MAX_FILES) break;
        const entries = await listDirContents(owner, repo, dir, apiHeaders);
        requestCount++;
        if (!entries) continue;
        const filename = pickChangelog(entries);
        if (!filename) continue;
        const f = await fetchOneFile(owner, repo, dir, filename, rawHeaders, source.slug);
        requestCount++;
        if (f) fetched.push(f);
      }
    }
  }

  console.log(`[cron] refreshChangelogFile(${source.slug}): ${fetched.length} files, ${requestCount} requests`);

  const now = new Date().toISOString();

  // Upsert each fetched file.
  const existing = await db
    .select()
    .from(sourceChangelogFiles)
    .where(eq(sourceChangelogFiles.sourceId, source.id));
  const existingByPath = new Map(existing.map((e) => [e.path, e]));

  // Track files whose content changed so we can embed them after DB writes.
  const changed: Array<{ fileId: string; content: string; contentHash: string }> = [];
  for (const file of fetched) {
    const prior = existingByPath.get(file.path);
    if (!prior) {
      const [row] = await db.insert(sourceChangelogFiles).values({
        sourceId: source.id,
        path: file.path,
        filename: file.filename,
        url: file.url,
        rawUrl: file.rawUrl,
        content: file.content,
        contentHash: file.contentHashHex,
        bytes: file.bytes,
        tokens: countTokensSafe(file.content),
        fetchedAt: now,
      }).returning({ id: sourceChangelogFiles.id });
      if (row) changed.push({ fileId: row.id, content: file.content, contentHash: file.contentHashHex });
      console.log(`[cron] Inserted ${file.path} for ${source.slug} (${file.bytes} bytes${file.truncated ? ", truncated" : ""})`);
    } else if (prior.contentHash === file.contentHashHex) {
      // Hash unchanged — short-circuit, no embed needed. Backfill tokens if the prior row predates that column.
      const touch: { fetchedAt: string; tokens?: number } = { fetchedAt: now };
      if (prior.tokens === null) touch.tokens = countTokensSafe(prior.content);
      await db
        .update(sourceChangelogFiles)
        .set(touch)
        .where(eq(sourceChangelogFiles.id, prior.id));
    } else {
      await db
        .update(sourceChangelogFiles)
        .set({
          filename: file.filename,
          url: file.url,
          rawUrl: file.rawUrl,
          content: file.content,
          contentHash: file.contentHashHex,
          bytes: file.bytes,
          tokens: countTokensSafe(file.content),
          fetchedAt: now,
        })
        .where(eq(sourceChangelogFiles.id, prior.id));
      changed.push({ fileId: prior.id, content: file.content, contentHash: file.contentHashHex });
      console.log(`[cron] Updated ${file.path} for ${source.slug} (${file.bytes} bytes${file.truncated ? ", truncated" : ""})`);
    }
  }

  // Embed changed changelog files into CHANGELOG_CHUNKS_INDEX. Runs inline
  // (the caller already wraps this function in try/catch) so failures just
  // log and move on. Skipped when the Vectorize binding is missing.
  if (changed.length > 0 && env.CHANGELOG_CHUNKS_INDEX) {
    for (const file of changed) {
      try {
        await embedChangelogFileForSource(db, source, file, env);
      } catch (err) {
        console.warn(`[cron] changelog embed failed for ${source.slug} (${file.fileId}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  // Prune any rows that are no longer in the discovered set.
  const keep = new Set(fetched.map((f) => f.path));
  const toDelete = existing.filter((row) => !keep.has(row.path));
  for (const row of toDelete) {
    await db.delete(sourceChangelogFiles).where(eq(sourceChangelogFiles.id, row.id));
    console.log(`[cron] Pruned ${row.path} for ${source.slug}`);
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
    "User-Agent": "releases/0.1",
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

// ── Embedding side effects ──
//
// These helpers hydrate DB rows, build the embed config from Worker secrets,
// push vectors to Vectorize, and mark the rows as embedded. All failures are
// swallowed by the shared helpers in src/lib/embed-*.ts so the callers never
// need to try/catch.

async function embedReleasesForSource(
  db: ReturnType<typeof drizzle>,
  source: Source,
  releaseIds: string[],
  env: FetchOneEnv,
): Promise<void> {
  const embedConfig = await buildEmbedConfig(env);
  if (!embedConfig || !env.RELEASES_INDEX) return;

  const rowsToEmbed = await db
    .select({
      id: releases.id,
      title: releases.title,
      content: releases.content,
      contentSummary: releases.contentSummary,
      version: releases.version,
      publishedAt: releases.publishedAt,
      sourceId: releases.sourceId,
      type: releases.type,
    })
    .from(releases)
    .where(inArray(releases.id, releaseIds));

  // Load org category for metadata filtering.
  let category: string | null = null;
  if (source.orgId) {
    const orgRow = await db.run(sql`SELECT category FROM organizations WHERE id = ${source.orgId} LIMIT 1`);
    const first = (orgRow.results as Array<{ category: string | null }> | undefined)?.[0];
    category = first?.category ?? null;
  }

  await embedAndUpsertReleases({
    releases: rowsToEmbed.map((r) => ({
      ...r,
      orgId: source.orgId,
      productId: source.productId,
      category,
    })),
    // See FetchOneEnv note: shared interface differs from workers-types only
    // in metadata variance. Cast is safe at runtime.
    vectorIndex: env.RELEASES_INDEX as VectorizeIndex,
    embedConfig,
    onPersisted: async (ids) => {
      if (ids.length === 0) return;
      const now = new Date().toISOString();
      for (let i = 0; i < ids.length; i += 100) {
        const slice = ids.slice(i, i + 100);
        await db.update(releases).set({ embeddedAt: now }).where(inArray(releases.id, slice));
      }
    },
  });
}

async function embedChangelogFileForSource(
  db: ReturnType<typeof drizzle>,
  source: Source,
  file: { fileId: string; content: string; contentHash: string },
  env: FetchOneEnv,
): Promise<void> {
  const embedConfig = await buildEmbedConfig(env);
  if (!embedConfig || !env.CHANGELOG_CHUNKS_INDEX) return;

  // Load existing chunks for this file so the diff can detect unchanged
  // sections and avoid re-embedding them.
  const existingRows = await db
    .select({
      id: sourceChangelogChunks.id,
      offset: sourceChangelogChunks.offset,
      contentHash: sourceChangelogChunks.contentHash,
      vectorId: sourceChangelogChunks.vectorId,
    })
    .from(sourceChangelogChunks)
    .where(eq(sourceChangelogChunks.sourceChangelogFileId, file.fileId));

  await embedAndUpsertChangelogFile({
    file: {
      id: file.fileId,
      sourceId: source.id,
      content: file.content,
      contentHash: file.contentHash,
    },
    existingChunks: existingRows.map((r) => ({
      id: r.id,
      offset: r.offset,
      contentHash: r.contentHash,
      vectorId: r.vectorId,
    })),
    vectorIndex: env.CHANGELOG_CHUNKS_INDEX as VectorizeIndex,
    embedConfig,
    onDiff: async ({ diff, embedded }) => {
      const now = new Date().toISOString();

      // 1. Delete stale rows.
      if (diff.toDelete.length > 0) {
        const ids = diff.toDelete.map((d) => d.id);
        for (let i = 0; i < ids.length; i += 100) {
          const slice = ids.slice(i, i + 100);
          await db.delete(sourceChangelogChunks).where(inArray(sourceChangelogChunks.id, slice));
        }
      }

      // 2. Update unchanged rows to reflect the new offset/heading/length.
      //    One-at-a-time is fine — the diff is usually small.
      for (const u of diff.unchanged) {
        await db
          .update(sourceChangelogChunks)
          .set({
            offset: u.chunk.offset,
            length: u.chunk.length,
            tokens: u.chunk.tokens,
            heading: u.chunk.heading,
          })
          .where(eq(sourceChangelogChunks.id, u.id));
      }

      // 3. Insert new rows. Rows whose embed succeeded get vectorId +
      //    embeddedAt; the rest land with vectorId = NULL so the backfill
      //    job can embed them later.
      const embeddedByHash = new Map(embedded.map((e) => [e.chunk.contentHash, e]));
      if (diff.toInsert.length > 0) {
        const values = diff.toInsert.map((chunk) => {
          const match = embeddedByHash.get(chunk.contentHash);
          return {
            sourceChangelogFileId: file.fileId,
            sourceId: source.id,
            offset: chunk.offset,
            length: chunk.length,
            tokens: chunk.tokens,
            contentHash: chunk.contentHash,
            heading: chunk.heading,
            vectorId: match?.vectorId ?? null,
            embeddedAt: match ? now : null,
          };
        });
        // D1 caps bound parameters per statement at ~100. This table has
        // 11 columns, so 9 rows per batch keeps us under the limit.
        for (let i = 0; i < values.length; i += 9) {
          await db.insert(sourceChangelogChunks).values(values.slice(i, i + 9));
        }
      }
    },
  });
}
