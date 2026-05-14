import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { releases, organizations, sources } from "@buildinternet/releases-core/schema";
import { SOURCE_TYPES } from "@buildinternet/releases-core/source-enums";
import { releaseCoverage } from "@releases/db/schema-coverage.js";
import type { Env } from "../index.js";
import { orgWhere, sourceMatchByIdOrSlug, parseBoolParam, parseReleaseMedia } from "../utils.js";
import { getLatestReleasesAcross } from "../queries/releases.js";
import { parseExcludeSourceTypes } from "../lib/source-types.js";
import {
  buildLatestCacheKey,
  isCacheableLatestRequest,
  withLatestCache,
  DEFAULT_LATEST_COUNT,
} from "../lib/latest-cache.js";
import {
  ReleaseLatestResponseSchema,
  ReleaseCoverageResponseSchema,
  LinkReleaseCoverageBodySchema,
  LinkReleaseCoverageResponseSchema,
  UnlinkReleaseCoverageResponseSchema,
  ReleasesWithMediaResponseSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";
import { validateJson } from "../lib/validate.js";

export const releaseRoutes = new Hono<Env>();

// ---------------------------------------------------------------------------
// GET /releases?hasMedia=true — returns releases with non-empty media JSON
// Used by the `media backfill` CLI command.
// ---------------------------------------------------------------------------

releaseRoutes.get(
  "/releases",
  describeRoute({
    hide: hideInProduction,
    tags: ["Releases"],
    summary: "List releases with media",
    description:
      "Internal/admin helper consumed by the `media backfill` CLI command. Only the `?hasMedia=true` shape is supported; any other query returns 400.",
    parameters: [
      {
        name: "hasMedia",
        in: "query",
        required: true,
        schema: { type: "string", enum: ["true"] },
        description: "Must be set to `true`. Any other value returns 400.",
      },
    ],
    responses: {
      200: {
        description: "Releases whose `media` JSON column is non-empty",
        content: { "application/json": { schema: resolver(ReleasesWithMediaResponseSchema) } },
      },
      400: {
        description: "Unsupported query — only `?hasMedia=true` is accepted",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const hasMedia = c.req.query("hasMedia");

    if (hasMedia === "true") {
      const db = createDb(c.env.DB);
      const rows = await db
        .select({
          id: releases.id,
          sourceId: releases.sourceId,
          media: releases.media,
        })
        .from(releases)
        .where(
          and(
            isNotNull(releases.media),
            sql`${releases.media} != '[]'`,
            sql`${releases.media} != ''`,
          ),
        );

      return c.json(rows.filter((r) => r.media !== null));
    }

    return c.json({ error: "unsupported query — use ?hasMedia=true" }, 400);
  },
);

// Cacheable "latest releases" feed. Shape documented in
// docs/architecture/remote-mode.md.

releaseRoutes.get(
  "/releases/latest",
  describeRoute({
    tags: ["Releases"],
    summary: "Latest releases (cross-source feed)",
    description:
      "Cacheable cross-source feed ordered by `(publishedAt DESC, fetchedAt DESC, id DESC)`. `?source=` and `?org=` are mutually exclusive scopes. `?exclude=` strips releases by source type — comma-separated values from `github,scrape,feed,agent`. By default, coverage-side rows (releases that roll up into a canonical release) are hidden; pass `?include_coverage=true` to include them. Prereleases (canaries / alphas / betas / RCs) are also hidden by default — pass `?include_prereleases=true` to surface them, matching the source-feed and MCP defaults. The unfiltered homepage shape is served through KV (`X-Cache: HIT|MISS`); filtered requests bypass cache (`X-Cache: BYPASS`).",
    parameters: [
      {
        name: "count",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 100, default: DEFAULT_LATEST_COUNT },
        description: "Number of releases to return. Clamped to `[1, 100]`.",
      },
      {
        name: "source",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Scope to a single source by typed ID (`src_…`) or slug. Mutually exclusive with `org`.",
      },
      {
        name: "org",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Scope to an org's sources by typed ID (`org_…`) or slug. Mutually exclusive with `source`.",
      },
      {
        name: "include_coverage",
        in: "query",
        required: false,
        schema: { type: "boolean" },
        description: "Include coverage-side rows that normally roll up into a canonical release.",
      },
      {
        name: "include_prereleases",
        in: "query",
        required: false,
        schema: { type: "boolean" },
        description:
          "Include prereleases (canaries / alphas / betas / RCs). Hidden by default to match the source-feed and MCP defaults.",
      },
      {
        name: "exclude",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Comma-separated source types to exclude. Allowed: `github`, `scrape`, `feed`, `agent`.",
      },
    ],
    responses: {
      200: {
        description: "Latest releases",
        content: { "application/json": { schema: resolver(ReleaseLatestResponseSchema) } },
      },
      400: {
        description: "Invalid `exclude` value, or `source` and `org` both supplied",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Source or org not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const rawCount = parseInt(c.req.query("count") ?? String(DEFAULT_LATEST_COUNT), 10);
    const count = isNaN(rawCount) || rawCount < 1 ? DEFAULT_LATEST_COUNT : Math.min(rawCount, 100);
    const sourceParam = c.req.query("source");
    const orgParam = c.req.query("org");
    const includeCoverage = parseBoolParam(c.req.query("include_coverage"));
    const includePrereleases = parseBoolParam(c.req.query("include_prereleases"));

    // Reject typos with a 400 — silent fallthrough would return unfiltered
    // releases AND cache-collide with the default homepage shape.
    const parsedExclude = parseExcludeSourceTypes(c.req.query("exclude"));
    if (!parsedExclude.ok) {
      return c.json(
        {
          error: "bad_request",
          message: `Invalid \`exclude\` source types: ${parsedExclude.invalid.join(", ")}. Allowed: ${SOURCE_TYPES.join(", ")}.`,
        },
        400,
      );
    }
    // Sort so any param ordering hits the same cache key.
    const excludeSourceTypes = [...parsedExclude.values].toSorted();

    if (sourceParam && orgParam) {
      return c.json(
        { error: "bad_request", message: "`source` and `org` are mutually exclusive" },
        400,
      );
    }

    const db = createDb(c.env.DB);

    let sourceId: string | undefined;
    let orgId: string | undefined;

    if (sourceParam) {
      const src = await db
        .select({ id: sources.id })
        .from(sources)
        .where(sourceMatchByIdOrSlug(sourceParam))
        .get();
      if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);
      sourceId = src.id;
    } else if (orgParam) {
      const org = await db
        .select({ id: organizations.id })
        .from(organizations)
        .where(orgWhere(orgParam))
        .get();
      if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);
      orgId = org.id;
    }

    const cacheKey = buildLatestCacheKey({
      count: String(count),
      source: sourceId,
      org: orgId,
      include_coverage: includeCoverage ? "true" : undefined,
      include_prereleases: includePrereleases ? "true" : undefined,
      exclude: excludeSourceTypes.length > 0 ? excludeSourceTypes.join(",") : undefined,
    });

    const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
    const waitUntil = c.executionCtx?.waitUntil.bind(c.executionCtx);

    const compute = async () => {
      const rows = await getLatestReleasesAcross(c.env.DB, {
        sourceId,
        orgId,
        includeCoverage,
        includePrereleases,
        excludeSourceTypes,
        limit: count,
      });
      return rows.map((r) => ({
        id: r.id,
        version: r.version,
        type: r.type,
        title: r.title,
        summary: r.summary,
        titleGenerated: r.title_generated,
        titleShort: r.title_short,
        publishedAt: r.published_at,
        url: r.url,
        media: parseReleaseMedia(r.media, mediaOrigin),
        source: {
          slug: r.source_slug,
          name: r.source_name,
          type: r.source_type,
          orgSlug: r.org_slug,
        },
        coverageCount: r.coverage_count,
      }));
    };

    // Only the unfiltered homepage/CLI shape (and any explicitly allowlisted
    // high-value filtered shapes) goes through KV. Everything else falls
    // through to D1 so filtered `tail -f` workloads can't inflate cardinality.
    const cacheable = isCacheableLatestRequest(cacheKey, {
      count,
      sourceId,
      orgId,
      includeCoverage,
      excludeSourceTypes,
    });

    if (!cacheable) {
      const data = await compute();
      c.header("X-Cache", "BYPASS");
      return c.json({ releases: data });
    }

    const { data, hit } = await withLatestCache(c.env.LATEST_CACHE, cacheKey, waitUntil, compute);

    c.header("X-Cache", hit ? "HIT" : "MISS");
    return c.json({ releases: data });
  },
);

// ---------------------------------------------------------------------------
// Release coverage
//
// Multiple releases can cover the same underlying launch (marketing post +
// platform changelog + app-version note). `release_coverage` records the
// canonical release plus every coverage row that rolls up into it.
//
// Auth note: these routes mount under /releases/* which is declared as a
// public-read group in index.ts, so GET is open and writes require the
// admin key. That policy lives in the mount, not in this file.
// ---------------------------------------------------------------------------

releaseRoutes.get(
  "/releases/:id/coverage",
  describeRoute({
    tags: ["Releases"],
    summary: "Get release coverage cluster",
    description:
      "Returns the role the given release plays in a coverage cluster. `standalone` means it is not in any cluster; `coverage` means it rolls up into `canonical`; `canonical` means it is the canonical row and `covers` enumerates the rollup-side releases.",
    responses: {
      200: {
        description: "Coverage cluster (discriminated by `role`)",
        content: { "application/json": { schema: resolver(ReleaseCoverageResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const id = c.req.param("id");

    const [asCoverage] = await db
      .select()
      .from(releaseCoverage)
      .where(eq(releaseCoverage.coverageId, id))
      .limit(1);
    if (asCoverage) {
      return c.json({ role: "coverage", canonical: asCoverage, covers: [] });
    }

    const covers = await db
      .select()
      .from(releaseCoverage)
      .where(eq(releaseCoverage.canonicalId, id));
    if (covers.length > 0) {
      return c.json({ role: "canonical", canonical: null, covers });
    }

    return c.json({ role: "standalone", canonical: null, covers: [] });
  },
);

releaseRoutes.post(
  "/releases/:id/coverage",
  describeRoute({
    hide: hideInProduction,
    tags: ["Releases"],
    summary: "Link releases as coverage of a canonical release",
    description:
      "Designates `coverageIds` as coverage rolling up to the canonical release at the path `:id`. `decidedBy` MUST be prefixed `human:` or `agent:` so the audit trail records who linked the rows. A release cannot be coverage of itself.",
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: "Coverage rows linked",
        content: { "application/json": { schema: resolver(LinkReleaseCoverageResponseSchema) } },
      },
      400: {
        description: "Missing/invalid body, self-coverage, or malformed `decidedBy`",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "One or more release IDs not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(LinkReleaseCoverageBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const canonicalId = c.req.param("id");
    const body = c.req.valid("json");

    // Dedupe: duplicate IDs in the request would otherwise redundantly upsert
    // the same row via ON CONFLICT DO UPDATE and inflate the `linked` count.
    const coverageIds = [...new Set(body.coverageIds)];
    if (coverageIds.includes(canonicalId)) {
      return c.json(
        { error: "bad_request", message: "a release cannot be coverage of itself" },
        400,
      );
    }

    const ids = [canonicalId, ...coverageIds];
    const found = await db
      .select({ id: releases.id })
      .from(releases)
      .where(inArray(releases.id, ids));
    const foundSet = new Set(found.map((r) => r.id));
    const missing = ids.filter((x) => !foundSet.has(x));
    if (missing.length > 0) {
      return c.json(
        { error: "not_found", message: `Release(s) not found: ${missing.join(", ")}` },
        404,
      );
    }

    const now = new Date().toISOString();
    const reason = body.reason ?? null;
    const decidedBy = body.decidedBy;
    const rows = coverageIds.map((coverageId) => ({
      canonicalId,
      coverageId,
      reason,
      decidedBy,
      decidedAt: now,
    }));
    await db
      .insert(releaseCoverage)
      .values(rows)
      .onConflictDoUpdate({
        target: releaseCoverage.coverageId,
        set: { canonicalId, reason, decidedBy, decidedAt: now },
      });

    return c.json({ canonicalId, coverageIds, linked: coverageIds.length }, 201);
  },
);

// DELETE is idempotent: returns { unlinked: false } when the release isn't in a
// cluster so the remote client can skip a brittle error-message sniff.
releaseRoutes.delete(
  "/releases/:id/coverage",
  describeRoute({
    hide: hideInProduction,
    tags: ["Releases"],
    summary: "Unlink a release from its coverage cluster",
    description:
      "Idempotent — returns `{ unlinked: false }` when the release isn't in a cluster so callers can skip a brittle error-message sniff.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Whether a coverage row was removed",
        content: { "application/json": { schema: resolver(UnlinkReleaseCoverageResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const coverageId = c.req.param("id");

    const deleted = await db
      .delete(releaseCoverage)
      .where(eq(releaseCoverage.coverageId, coverageId))
      .returning({ id: releaseCoverage.coverageId });

    return c.json({ unlinked: deleted.length > 0 });
  },
);
