import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { RELEASE_URL_UPSERT } from "@releases/core-internal/release-upsert";
import { probeRepo, ProbeRateLimitError, ProbeServerError } from "@releases/adapters/github-probe";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";
import { resolveRelatedOrg, type RelatedOrgResult } from "../lib/lookup-related-org.js";
import { readNegCache, writeNegCache } from "../lib/lookup-neg-cache.js";
import { createDb } from "../db.js";
import type { Env } from "../index.js";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { RELEASES_BATCH_CHUNK_SIZE } from "../lib/d1-limits.js";
import { isConflictError } from "../utils.js";
import { embedSourceSideEffect } from "./sources.js";
import { logger } from "@buildinternet/releases-lib/logger";

export const lookupRoutes = new Hono<Env>();

type LookupStatus = "indexed" | "existing" | "empty" | "not_found" | "deferred";

export interface LookupResponse {
  status: LookupStatus;
  source?: typeof sources.$inferSelect;
  releases?: Array<typeof releases.$inferSelect>;
  relatedOrg: RelatedOrgResult | null;
}

/**
 * Fetch GitHub releases directly, accepting an explicit token so the lookup
 * path isn't coupled to process.env (unlike the packages/adapters/github.ts
 * adapter which reads config.githubToken() for the dev CLI path).
 */
async function fetchGitHubReleases(
  owner: string,
  repo: string,
  token?: string,
): Promise<
  Array<{
    version: string;
    title: string;
    content: string;
    url: string;
    publishedAt: Date | undefined;
  }>
> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": RELEASES_BOT_UA,
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=100`, {
    headers,
  });

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

  return data.map((rel) => ({
    version: rel.tag_name,
    title: rel.name || rel.tag_name,
    content: rel.body || "",
    url: rel.html_url,
    publishedAt: rel.published_at ? new Date(rel.published_at) : undefined,
  }));
}

/**
 * Core lookup orchestration. Takes a resolved coordinate — caller is responsible for validation.
 */
export async function runLookup(
  env: Env["Bindings"],
  db: ReturnType<typeof createDb>,
  parsed: { provider: "github"; org: string; repo: string },
): Promise<LookupResponse> {
  const coordinate = `${parsed.org}/${parsed.repo}`;
  const url = `https://github.com/${coordinate}`;
  const githubToken = await env.GITHUB_TOKEN?.get();

  // Check neg-cache before hitting DB or GitHub.
  const cached = env.LATEST_CACHE
    ? await readNegCache(env.LATEST_CACHE, "github", coordinate)
    : null;
  if (cached) {
    const relatedOrg = await resolveRelatedOrg(db, parsed.org);
    return { status: cached.status, relatedOrg };
  }

  // Source already indexed → return it (unless it's an empty stub, which
  // should be re-probed in case the repo has since gained releases).
  const existing = await db.select().from(sources).where(eq(sources.url, url)).limit(1);
  let existingStub: typeof sources.$inferSelect | undefined;
  if (existing.length > 0) {
    const source = existing[0]!;
    let isEmptyStub = false;
    try {
      const meta = JSON.parse(source.metadata ?? "{}") as { lookup?: { emptyResult?: boolean } };
      isEmptyStub = Boolean(meta?.lookup?.emptyResult);
    } catch {
      // Malformed metadata — treat as not-empty and use the existing fast path.
    }
    if (!isEmptyStub) {
      const relatedOrg = await resolveRelatedOrg(db, parsed.org);
      const existingReleases = await db
        .select()
        .from(releases)
        .where(eq(releases.sourceId, source.id))
        .orderBy(desc(releases.publishedAt))
        .limit(20);
      return { status: "existing", source, releases: existingReleases, relatedOrg };
    }
    // Empty stub — refresh in place. We re-probe and, if the repo now has
    // releases, ingest into this row instead of inserting a new source
    // (which would collide on UNIQUE(url) anyway).
    existingStub = source;
  }

  // Resolve related org for "did you mean" rail (needed for not_found/empty/deferred responses).
  const relatedOrg = await resolveRelatedOrg(db, parsed.org);

  // Probe the repo.
  let probe;
  try {
    probe = await probeRepo({ GITHUB_TOKEN: githubToken }, parsed.org, parsed.repo);
  } catch (err) {
    if (err instanceof ProbeRateLimitError || err instanceof ProbeServerError) {
      return { status: "deferred", relatedOrg };
    }
    throw err;
  }

  if (!probe.exists || probe.archived) {
    if (env.LATEST_CACHE) {
      await writeNegCache(env.LATEST_CACHE, "github", coordinate, "not_found");
    }
    return { status: "not_found", relatedOrg };
  }

  const fetchedAt = new Date().toISOString();
  const isEmpty = !probe.hasReleases && !probe.hasChangelog;
  const newMeta = JSON.stringify({
    lookup: {
      coordinate,
      fetchedAt,
      lastRefreshedAt: fetchedAt,
      emptyResult: isEmpty,
    },
  });

  let insertedSource: typeof sources.$inferSelect | undefined;
  let sourceId: string;

  if (existingStub) {
    // Refresh in place: keep id/orgId/slug, update metadata to reflect the
    // fresh probe result. emptyResult flips false here when the repo now
    // has content, which is what unsticks the stub on the next read.
    sourceId = existingStub.id;
    const [updated] = await db
      .update(sources)
      .set({ metadata: newMeta })
      .where(eq(sources.id, sourceId))
      .returning();
    insertedSource = updated ?? { ...existingStub, metadata: newMeta };
  } else {
    // Org reuse: attach to an existing curated/agent org if relatedOrg matched.
    // Otherwise insert a hidden on-demand org, falling back on slug collision.
    let orgId: string;
    if (relatedOrg) {
      orgId = relatedOrg.org.id;
    } else {
      // Upsert org to avoid TOCTOU race under concurrent requests.
      orgId = newOrgId();
      await db
        .insert(organizations)
        .values({
          id: orgId,
          name: parsed.org,
          slug: parsed.org,
          discovery: "on_demand",
        })
        .onConflictDoNothing();

      // Re-read to get the winner's id (could be ours or a concurrent inserter's).
      const [winningOrg] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.slug, parsed.org))
        .limit(1);
      orgId = winningOrg!.id;
    }

    sourceId = newSourceId();
    const baseSlug = `${parsed.org}-${parsed.repo}`.toLowerCase();

    // Handle slug collision on source insert (try base, then base-2 … base-5).
    // Between retries we re-check by URL so a concurrent request that won the
    // first slug can't cause us to insert a second row at the same URL.
    // (sources.slug is UNIQUE; sources.url is not — without this re-check
    //  two concurrent calls could both succeed with different slug suffixes.)
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        // oxlint-disable-next-line no-await-in-loop -- race re-check before next slug
        const concurrent = await db.select().from(sources).where(eq(sources.url, url)).limit(1);
        if (concurrent.length > 0) {
          insertedSource = concurrent[0]!;
          sourceId = insertedSource.id;
          break;
        }
      }
      const slug = attempt === 0 ? baseSlug : `${baseSlug}-${attempt + 1}`;
      try {
        // oxlint-disable-next-line no-await-in-loop -- sequential retry on slug collision
        const [row] = await db
          .insert(sources)
          .values({
            id: sourceId,
            name: coordinate,
            slug,
            type: "github",
            url,
            orgId,
            discovery: "on_demand",
            isHidden: true,
            metadata: newMeta,
          })
          .returning();
        insertedSource = row;
        break;
      } catch (err) {
        if (isConflictError(err)) continue;
        throw err;
      }
    }

    // If all slug attempts collided, fall back to reading the existing row.
    if (!insertedSource) {
      const rows = await db.select().from(sources).where(eq(sources.url, url)).limit(1);
      if (rows.length > 0) {
        const existingReleases = await db
          .select()
          .from(releases)
          .where(eq(releases.sourceId, rows[0]!.id))
          .orderBy(desc(releases.publishedAt))
          .limit(20);
        return { status: "existing", source: rows[0]!, releases: existingReleases, relatedOrg };
      }
      // Truly unrecoverable — surface deferred so the client can retry.
      return { status: "deferred", relatedOrg };
    }
  }

  if (isEmpty) {
    if (env.LATEST_CACHE) {
      await writeNegCache(env.LATEST_CACHE, "github", coordinate, "empty");
    }
    return { status: "empty", source: insertedSource, relatedOrg };
  }

  // Full ingest: fetch releases from GitHub and persist them.
  // per_page=100 is an intentional v1 cap — older releases beyond 100 will be
  // backfilled by cron via the full github adapter on the next scheduled fetch.
  let ingestStatus: "indexed" | "deferred" = "indexed";
  let ingestedReleases: Array<typeof releases.$inferSelect> = [];
  try {
    const rawReleases = await fetchGitHubReleases(parsed.org, parsed.repo, githubToken);

    // If the probe indicated a CHANGELOG but the releases API returned nothing,
    // defer so cron can run the full adapter (which fetches CHANGELOG files).
    if (rawReleases.length === 0 && probe.hasChangelog) {
      ingestStatus = "deferred";
    } else if (rawReleases.length > 0) {
      const rows = rawReleases.map((r) => ({
        id: newReleaseId(),
        sourceId,
        version: r.version,
        title: r.title,
        content: r.content,
        url: r.url,
        // publishedAt is text (ISO string) in the schema; RawRelease carries Date | undefined
        publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
      }));
      for (let i = 0; i < rows.length; i += RELEASES_BATCH_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + RELEASES_BATCH_CHUNK_SIZE);
        // oxlint-disable-next-line no-await-in-loop -- D1 chunked insert
        await db.insert(releases).values(chunk).onConflictDoUpdate(RELEASE_URL_UPSERT);
      }
      ingestedReleases = await db
        .select()
        .from(releases)
        .where(eq(releases.sourceId, sourceId))
        .orderBy(desc(releases.publishedAt))
        .limit(20);
    }
  } catch (err) {
    // Source row stays; cron picks it up later.
    logger.error("[lookups] ingest failed", err);
    ingestStatus = "deferred";
  }

  return {
    status: ingestStatus,
    source: insertedSource,
    releases: ingestedReleases,
    relatedOrg,
  };
}

lookupRoutes.post("/lookups", async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    provider?: string;
    coordinate?: string;
  } | null;

  if (!body) {
    return c.json({ error: "E_LOOKUP_BAD_REQUEST", message: "JSON body required" }, 400);
  }

  if (body.provider !== "github") {
    return c.json(
      {
        error: "E_LOOKUP_UNSUPPORTED_PROVIDER",
        message: `provider must be "github" (v1)`,
      },
      400,
    );
  }

  const parsed = parseCoordinate(body.coordinate ?? "");
  if (!parsed) {
    return c.json(
      { error: "E_LOOKUP_BAD_COORDINATE", message: "coordinate must match {org}/{repo}" },
      400,
    );
  }

  const db = createDb(c.env.DB);
  const result = await runLookup(c.env, db, parsed);
  // Embed any materialized source row (indexed, empty, existing-stub-refreshed).
  // embedSourceSideEffect itself short-circuits when bindings are missing or the
  // row is already embedded, so re-firing on the existing path is cheap.
  if (result.source) {
    try {
      c.executionCtx.waitUntil(embedSourceSideEffect(c.env, db, result.source.id));
    } catch {
      // No ExecutionContext in test environments — embedding is best-effort.
    }
  }
  return c.json(result);
});
