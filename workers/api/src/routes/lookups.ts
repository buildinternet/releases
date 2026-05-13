import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { asc, desc, eq, sql } from "drizzle-orm";
import {
  domainAliases,
  organizations,
  organizationsActive,
  productsActive,
  sources,
  sourcesActive,
  releases,
} from "@buildinternet/releases-core/schema";
import { RELEASE_URL_UPSERT } from "@releases/core-internal/release-upsert";
import { probeRepo, ProbeRateLimitError, ProbeServerError } from "@releases/adapters/github-probe";
import { newOrgId, newSourceId, newReleaseId } from "@buildinternet/releases-core/id";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";
import { normalizeDomain } from "@buildinternet/releases-core/domain";
import { findOrgByDomain } from "../queries/search.js";
import { resolveRelatedOrg, type RelatedOrgResult } from "../lib/lookup-related-org.js";
import { readNegCache, writeNegCache } from "../lib/lookup-neg-cache.js";
import { createDb } from "../db.js";
import type { Env } from "../index.js";
import { RELEASES_BOT_UA } from "@releases/adapters/user-agent";
import { RELEASES_BATCH_CHUNK_SIZE } from "../lib/d1-limits.js";
import { isConflictError } from "../utils.js";
import { embedSourceSideEffect } from "./sources.js";
import { logEvent } from "@releases/lib/log-event";
import { getSecret } from "@releases/lib/secrets";
import {
  LookupResponseSchema,
  LookupSourceBySlugResponseSchema,
  LookupProductBySlugResponseSchema,
  DomainLookupResponseSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";

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
    prerelease: boolean;
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
    prerelease: boolean;
  }> = await res.json();

  return data.map((rel) => ({
    version: rel.tag_name,
    title: rel.name || rel.tag_name,
    content: rel.body || "",
    url: rel.html_url,
    publishedAt: rel.published_at ? new Date(rel.published_at) : undefined,
    prerelease: rel.prerelease === true,
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
  // GitHub paths are case-insensitive on redirect, so dedup existing rows
  // case-insensitively. (The neg-cache helpers already case-fold their
  // keys, so they take `coordinate` as-is.) `sources.url` is NOT unique,
  // so when multiple case-variant rows exist we pick deterministically:
  // exact-case match first, then oldest createdAt as a stable
  // tie-breaker.
  const urlLower = url.toLowerCase();
  const findExistingSource = () =>
    db
      .select()
      .from(sourcesActive)
      .where(sql`LOWER(${sourcesActive.url}) = ${urlLower}`)
      .orderBy(
        sql`CASE WHEN ${sourcesActive.url} = ${url} THEN 0 ELSE 1 END`,
        sourcesActive.createdAt,
      )
      .limit(1);
  const githubToken = (await getSecret(env.GITHUB_TOKEN)) ?? undefined;

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
  const existing = await findExistingSource();
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
    let orgSlug: string;
    if (relatedOrg) {
      orgId = relatedOrg.org.id;
      orgSlug = relatedOrg.org.slug;
    } else {
      // Org slug is always lowercased — keeps URLs canonical regardless of
      // the case the user typed in `org/repo`, and matches the convention
      // curated orgs already follow. The org *name* prefers the canonical
      // login from the GitHub probe (e.g. `Shopify`) over the typed case.
      orgSlug = parsed.org.toLowerCase();
      const orgName = probe.ownerLogin ?? parsed.org;
      // Upsert org to avoid TOCTOU race under concurrent requests.
      orgId = newOrgId();
      await db
        .insert(organizations)
        .values({
          id: orgId,
          name: orgName,
          slug: orgSlug,
          discovery: "on_demand",
        })
        .onConflictDoNothing();

      // Re-read to get the winner's id (could be ours or a concurrent inserter's).
      // The active view skips tombstones — soft-delete renames the slug to a
      // mangled form so a re-onboard at the original slug doesn't collide.
      const [winningOrg] = await db
        .select()
        .from(organizationsActive)
        .where(eq(organizationsActive.slug, orgSlug))
        .limit(1);
      orgId = winningOrg!.id;
    }

    sourceId = newSourceId();
    // Per-org slug uniqueness (#690 Phase C) means the bare repo segment is
    // safe to use directly — an org by definition can't have two repos with
    // the same name. The only remaining race is a concurrent request for the
    // same coordinate; on UNIQUE error we re-read by URL.
    const repoSlug = parsed.repo.toLowerCase();
    const repoName = probe.repoName ?? parsed.repo;
    try {
      const [row] = await db
        .insert(sources)
        .values({
          id: sourceId,
          name: repoName,
          slug: repoSlug,
          type: "github",
          url,
          orgId,
          discovery: "on_demand",
          isHidden: true,
          metadata: newMeta,
        })
        .returning();
      insertedSource = row;
    } catch (err) {
      if (!isConflictError(err)) throw err;
      // Concurrent insert won the (org_id, slug) UNIQUE — re-read and return
      // their row instead of bailing.
      const rows = await findExistingSource();
      if (rows.length > 0) {
        const existingReleases = await db
          .select()
          .from(releases)
          .where(eq(releases.sourceId, rows[0]!.id))
          .orderBy(desc(releases.publishedAt))
          .limit(20);
        return { status: "existing", source: rows[0]!, releases: existingReleases, relatedOrg };
      }
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
        prerelease: r.prerelease,
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
    logEvent("error", { component: "lookups", event: "ingest-failed", err });
    ingestStatus = "deferred";
  }

  return {
    status: ingestStatus,
    source: insertedSource,
    releases: ingestedReleases,
    relatedOrg,
  };
}

lookupRoutes.post(
  "/lookups",
  describeRoute({
    tags: ["Lookups"],
    summary: "On-demand GitHub source materialization",
    description:
      'Resolves a GitHub `org/repo` coordinate to a registry source. Idempotent — if the source already exists, returns it with `status: "existing"`; otherwise probes GitHub, inserts a hidden `on_demand` source row (and a new `on_demand` org when no curated org claims the segment), and ingests up to 100 releases.\n\nNegative results (`not_found`, `empty`) are cached in KV (24h and 6h respectively) so repeat probes don\'t re-hit GitHub. `deferred` outcomes (rate-limit, 5xx) are not cached and let the next cron pass retry.\n\nBody requires `provider: "github"` — other providers are explicitly rejected, not silently accepted. Coordinate must match `{org}/{repo}` (case-insensitive; URLs are deduped via `LOWER(sources.url)`).',
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Lookup result. Inspect `status` to disambiguate outcomes.",
        content: { "application/json": { schema: resolver(LookupResponseSchema) } },
      },
      400: {
        description: "Missing JSON body, unsupported provider, or malformed coordinate",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
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
  },
);

/**
 * Slug → canonical-home lookup for sources. Lets clients that hold a bare
 * slug (legacy bookmarks, the OSS CLI's `findSource(operatorInput)`) translate
 * it to the org-scoped form before the bare API path stops resolving slugs
 * (#698 final piece). Per-org slug uniqueness (#690) means a slug can match
 * multiple sources across orgs; this endpoint returns the oldest match by
 * createdAt for stability so repeated calls land on the same row.
 *
 * `Sunset` header is set so callers know this is a migration aid, not a
 * permanent shape — it'll be removed when the bookmark window elapses.
 *
 * Public read — pure resolution primitive. Auth on /v1/lookups is
 * gate-by-method (publicReadAuthMiddleware), so the POST below still
 * requires a Bearer.
 */
lookupRoutes.get(
  "/lookups/source-by-slug",
  describeRoute({
    tags: ["Lookups"],
    summary: "Resolve a bare source slug to its canonical org-scoped home",
    description:
      "Translation aid for clients holding a bare source slug. Returns the org-scoped tuple `{ sourceId, sourceSlug, orgSlug }` so callers can rewrite to the canonical `/v1/orgs/:orgSlug/sources/:sourceSlug` path before the bare API path stops resolving slugs (#698 final piece).\n\nReturns the **oldest** match by `(createdAt, id)` so repeated calls land on the same row. Carries `Sunset: Sun, 01 Nov 2026 00:00:00 GMT` on success.",
    parameters: [
      {
        name: "slug",
        in: "query",
        required: true,
        schema: { type: "string" },
        description: "Bare source slug to resolve.",
      },
    ],
    responses: {
      200: {
        description: "Canonical home for the slug",
        content: { "application/json": { schema: resolver(LookupSourceBySlugResponseSchema) } },
        headers: {
          Sunset: {
            description: "RFC 8594 sunset date for this resolution shape",
            schema: { type: "string" },
          },
        },
      },
      400: {
        description: "Missing `slug` query parameter",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "No source matches the slug",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const slug = c.req.query("slug")?.trim();
    if (!slug) {
      return c.json({ error: "bad_request", message: "slug query param is required" }, 400);
    }
    const db = createDb(c.env.DB);
    const [row] = await db
      .select({
        sourceId: sourcesActive.id,
        sourceSlug: sourcesActive.slug,
        orgSlug: organizationsActive.slug,
      })
      .from(sourcesActive)
      .innerJoin(organizationsActive, eq(organizationsActive.id, sourcesActive.orgId))
      .where(eq(sourcesActive.slug, slug))
      .orderBy(asc(sourcesActive.createdAt), asc(sourcesActive.id))
      .limit(1);
    if (!row) {
      return c.json({ error: "not_found", message: `No source matches slug "${slug}"` }, 404);
    }
    c.header("Sunset", "Sun, 01 Nov 2026 00:00:00 GMT");
    return c.json(row);
  },
);

/**
 * Slug → canonical-home lookup for products. Same semantics as
 * `/lookups/source-by-slug`. The OSS CLI's `findProduct(operatorInput)` is
 * the primary consumer.
 */
lookupRoutes.get(
  "/lookups/product-by-slug",
  describeRoute({
    tags: ["Lookups"],
    summary: "Resolve a bare product slug to its canonical org-scoped home",
    description:
      "Same semantics as `/v1/lookups/source-by-slug` but for products. Returns `{ productId, productSlug, orgSlug }` so callers can rewrite to `/v1/orgs/:orgSlug/products/:productSlug` before the bare path stops resolving slugs. Oldest match by `(createdAt, id)`. Carries `Sunset: Sun, 01 Nov 2026 00:00:00 GMT` on success.",
    parameters: [
      {
        name: "slug",
        in: "query",
        required: true,
        schema: { type: "string" },
        description: "Bare product slug to resolve.",
      },
    ],
    responses: {
      200: {
        description: "Canonical home for the slug",
        content: { "application/json": { schema: resolver(LookupProductBySlugResponseSchema) } },
        headers: {
          Sunset: {
            description: "RFC 8594 sunset date for this resolution shape",
            schema: { type: "string" },
          },
        },
      },
      400: {
        description: "Missing `slug` query parameter",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "No product matches the slug",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const slug = c.req.query("slug")?.trim();
    if (!slug) {
      return c.json({ error: "bad_request", message: "slug query param is required" }, 400);
    }
    const db = createDb(c.env.DB);
    const [row] = await db
      .select({
        productId: productsActive.id,
        productSlug: productsActive.slug,
        orgSlug: organizationsActive.slug,
      })
      .from(productsActive)
      .innerJoin(organizationsActive, eq(organizationsActive.id, productsActive.orgId))
      .where(eq(productsActive.slug, slug))
      .orderBy(asc(productsActive.createdAt), asc(productsActive.id))
      .limit(1);
    if (!row) {
      return c.json({ error: "not_found", message: `No product matches slug "${slug}"` }, 404);
    }
    c.header("Sunset", "Sun, 01 Nov 2026 00:00:00 GMT");
    return c.json(row);
  },
);

/**
 * Domain → canonical owner lookup. Pure resolution; unlike the GitHub
 * coordinate path (`POST /v1/lookups`), an unknown domain is just
 * `404 not_found` — never probed or materialized. The product list is
 * separate because a domain alias can target a product directly; we
 * return both shapes so the caller doesn't round-trip again.
 */
lookupRoutes.get(
  "/lookups/by-domain",
  describeRoute({
    tags: ["Lookups"],
    summary: "Resolve a domain to its owning org and any matching products",
    description:
      "Pure resolution: normalizes the input domain (lowercased, no scheme/path/www), exact-matches against `organizations.domain` (primary) and `domain_aliases.domain` (alias for either an org or a product), and returns whatever it finds. Unknown domains return 404 — there is no on-demand probing for domains, unlike the GitHub coordinate path on `POST /v1/lookups`.\n\nProducts can be populated even when `org` is null — a product alias may point at a domain its parent org doesn't claim as primary.",
    parameters: [
      {
        name: "domain",
        in: "query",
        required: true,
        schema: { type: "string" },
        description: "Hostname to resolve. Server normalizes (lowercases, strips scheme/path/www).",
      },
    ],
    responses: {
      200: {
        description: "Resolved org and/or product matches",
        content: { "application/json": { schema: resolver(DomainLookupResponseSchema) } },
      },
      400: {
        description: "Missing or invalid `domain` query parameter",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Domain doesn't match any registered org or product",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const domain = normalizeDomain(c.req.query("domain") ?? "");
    if (!domain) {
      return c.json(
        { error: "bad_request", message: "domain query param must be a valid hostname" },
        400,
      );
    }

    const db = createDb(c.env.DB);
    const [orgRow, productRows] = await Promise.all([
      findOrgByDomain(db, domain),
      db
        .select({
          id: productsActive.id,
          slug: productsActive.slug,
          name: productsActive.name,
          orgId: productsActive.orgId,
          orgSlug: organizationsActive.slug,
          orgName: organizationsActive.name,
          category: productsActive.category,
        })
        .from(productsActive)
        .innerJoin(domainAliases, eq(domainAliases.productId, productsActive.id))
        .innerJoin(organizationsActive, eq(organizationsActive.id, productsActive.orgId))
        .where(eq(domainAliases.domain, domain))
        .orderBy(asc(productsActive.name), asc(productsActive.id)),
    ]);

    if (!orgRow && productRows.length === 0) {
      return c.json(
        { error: "not_found", message: `No org or product owns domain "${domain}"` },
        404,
      );
    }

    return c.json({ domain, org: orgRow, products: productRows });
  },
);
