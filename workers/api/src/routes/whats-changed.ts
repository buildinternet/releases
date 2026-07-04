/**
 * `GET /v1/whats-changed` — upgrade-intelligence Phase 1 (#1697). Given one
 * package and a `from`/`to` version, return the ordered changelog entries in the
 * half-open range `(from, to]`, their summaries, and (now that #1696 landed)
 * their breaking-change verdicts + migration notes. The wedge feature for the
 * agent-native channel: an agent can't visit N changelog pages to plan an
 * upgrade, but it can make one call here.
 *
 * Reads ALREADY-INGESTED releases only — no live fetch. Package resolution is
 * READ-ONLY (exact catalog slug match, then a non-materializing GitHub
 * coordinate match); an unresolvable package returns `status: "unknown"` with
 * HTTP 200 (a valid answer, not an error) — never a write side effect (the
 * confused-deputy guard the MCP auth model warns about).
 *
 * Phase 2 (`upgrade_plan` over a whole manifest) fans this out per dependency
 * and aggregates — design the response so a manifest result is a map of these.
 */
import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { z } from "zod";
import { and, asc, eq, gt, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { releases, sourcesActive, organizationsActive } from "@buildinternet/releases-core/schema";
import { releaseCoverage } from "@releases/db/schema-coverage.js";
import { resolveUpgradeRange } from "@buildinternet/releases-core/upgrade-range";
import { computeVersionSort } from "@buildinternet/releases-core/version-sort";
import { parseCoordinate } from "@buildinternet/releases-core/lookup-coordinate";
import { releaseWebUrl } from "@buildinternet/releases-core/release-slug";
import { estimateTokens } from "@buildinternet/releases-core/tokens";
import { CHANGELOG_TOKEN_BRACKETS } from "@buildinternet/releases-core/changelog-slice";
import { BREAKING_LEVELS } from "@buildinternet/releases-core/breaking";
import { errorEnvelopeSchema } from "@buildinternet/releases-api-types";
import { createDb } from "../db.js";
import { releaseWebBase } from "../queries/releases.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { ValidationError } from "@releases/lib/releases-error";

export const whatsChangedRoutes = new Hono<Env>();

/** Token budget for the summaries returned in one call — the largest changelog
 *  bracket. A range wider than this is truncated (newest entries kept). */
const TOKEN_BUDGET = CHANGELOG_TOKEN_BRACKETS[CHANGELOG_TOKEN_BRACKETS.length - 1];

/** Minimum token charge per entry so rows with empty summary/title still count
 *  toward the budget (estimateTokens("") === 0 otherwise). */
const MIN_ENTRY_TOKEN_COST = 64;
const MAX_ENTRIES = Math.floor(TOKEN_BUDGET / MIN_ENTRY_TOKEN_COST);

const EcosystemSchema = z.enum(["npm", "pypi", "github"]);

const WhatsChangedEntrySchema = z.object({
  version: z.string().nullable(),
  publishedAt: z.string().nullable(),
  /** Best display headline: AI title if present, else the raw release title. */
  title: z.string().nullable(),
  summary: z.string().nullable(),
  /** From #1696. `"unknown"` until classified (history) or for non-dev-facing kinds. */
  breaking: z.enum(BREAKING_LEVELS),
  migrationNotes: z.string().nullable(),
  url: z.string().nullable(),
  /** Slugged canonical web URL (#1906); distinct from the upstream `url`. */
  webUrl: z.string().nullable(),
});

const WhatsChangedResponseSchema = z.object({
  status: z.enum(["resolved", "unknown"]),
  package: z.string(),
  ecosystem: EcosystemSchema.nullable(),
  from: z.string(),
  to: z.string(),
  source: z
    .object({ sourceId: z.string(), sourceSlug: z.string(), orgSlug: z.string() })
    .nullable(),
  entries: z.array(WhatsChangedEntrySchema),
  count: z.number(),
  /** True when the range exceeded the token budget and oldest entries were dropped. */
  truncated: z.boolean(),
  truncatedAtTokens: z.number().optional(),
});

type ResolvedSource = { sourceId: string; sourceSlug: string; orgSlug: string };

/**
 * Resolve a package name (+ ecosystem) to a catalog source, READ-ONLY. Tries an
 * exact source-slug match first, then a non-materializing GitHub `owner/repo`
 * coordinate match (when the input looks like a coordinate or ecosystem=github).
 * Returns null on miss — the caller answers `status: "unknown"`, never writes.
 * npm/PyPI names not present as a catalog slug resolve to null until the
 * name→source map (#1345) lands.
 */
async function resolveSource(
  db: ReturnType<typeof createDb>,
  pkg: string,
  ecosystem: z.infer<typeof EcosystemSchema> | null,
): Promise<ResolvedSource | null> {
  // 1. Exact source-slug match (oldest by createdAt,id for stability).
  const [bySlug] = await db
    .select({
      sourceId: sourcesActive.id,
      sourceSlug: sourcesActive.slug,
      orgSlug: organizationsActive.slug,
    })
    .from(sourcesActive)
    .innerJoin(organizationsActive, eq(organizationsActive.id, sourcesActive.orgId))
    .where(and(eq(sourcesActive.slug, pkg), eq(sourcesActive.isHidden, false)))
    .orderBy(asc(sourcesActive.createdAt), asc(sourcesActive.id))
    .limit(1);
  if (bySlug) return bySlug;

  // 2. GitHub coordinate (read-only; mirrors GET /v1/lookups/source-by-coordinate
  //    — no probe, no materialize). Only attempted when it parses as owner/repo.
  if (ecosystem === "github" || pkg.includes("/")) {
    const parsed = parseCoordinate(pkg);
    if (parsed) {
      const url = `https://github.com/${parsed.org}/${parsed.repo}`;
      const [byCoord] = await db
        .select({
          sourceId: sourcesActive.id,
          sourceSlug: sourcesActive.slug,
          orgSlug: organizationsActive.slug,
        })
        .from(sourcesActive)
        .innerJoin(organizationsActive, eq(organizationsActive.id, sourcesActive.orgId))
        .where(
          and(
            sql`LOWER(${sourcesActive.url}) = ${url.toLowerCase()}`,
            eq(sourcesActive.isHidden, false),
          ),
        )
        .orderBy(
          sql`CASE WHEN ${sourcesActive.url} = ${url} THEN 0 ELSE 1 END`,
          asc(sourcesActive.createdAt),
          asc(sourcesActive.id),
        )
        .limit(1);
      if (byCoord) return byCoord;
    }
  }
  return null;
}

whatsChangedRoutes.get(
  "/whats-changed",
  describeRoute({
    tags: ["Releases"],
    summary: "Changelog entries between two versions of a package (upgrade intelligence)",
    description:
      'Given a `package` and a `from`/`to` version, returns the ordered release entries in the half-open range `(from, to]` — `from` exclusive (you have it), `to` inclusive — with summaries, breaking-change verdicts (#1696), and migration notes. One call instead of N changelog pages.\n\nReads already-ingested releases only (no live fetch). Resolution is read-only: an exact catalog source-slug match, then a non-materializing GitHub `owner/repo` coordinate match. An unresolvable package returns `status: "unknown"` with HTTP 200 — a valid answer, not an error; npm/PyPI names absent from the catalog resolve to `unknown` until the name→source map (#1345) lands. Wide ranges are truncated to a token budget (newest entries kept), flagged via `truncated`.',
    parameters: [
      {
        name: "package",
        in: "query",
        required: true,
        schema: { type: "string" },
        description:
          'Package identifier — a catalog source slug or a GitHub "owner/repo" coordinate.',
      },
      {
        name: "from",
        in: "query",
        required: true,
        schema: { type: "string" },
        description: "Version you're upgrading FROM (exclusive).",
      },
      {
        name: "to",
        in: "query",
        required: true,
        schema: { type: "string" },
        description: "Version you're upgrading TO (inclusive).",
      },
      {
        name: "ecosystem",
        in: "query",
        required: false,
        schema: { type: "string", enum: ["npm", "pypi", "github"] },
        description:
          "Optional resolution hint. `github` enables the coordinate match for a bare owner/repo.",
      },
    ],
    responses: {
      200: {
        description: "Upgrade range (resolved or unknown — both are 200)",
        content: { "application/json": { schema: resolver(WhatsChangedResponseSchema) } },
      },
      400: {
        description: "Missing/invalid query parameters",
        content: { "application/json": { schema: resolver(errorEnvelopeSchema) } },
      },
    },
  }),
  async (c) => {
    const pkg = c.req.query("package")?.trim();
    const from = c.req.query("from")?.trim();
    const to = c.req.query("to")?.trim();
    const ecosystemRaw = c.req.query("ecosystem")?.trim();

    if (!pkg || !from || !to) {
      return respondError(
        c,
        new ValidationError("package, from, and to query params are required", {
          code: "bad_request",
        }),
      );
    }
    const ecoParse = ecosystemRaw ? EcosystemSchema.safeParse(ecosystemRaw) : null;
    if (ecosystemRaw && !ecoParse?.success) {
      return respondError(
        c,
        new ValidationError("ecosystem must be one of: npm, pypi, github", { code: "bad_request" }),
      );
    }
    const ecosystem = ecoParse?.success ? ecoParse.data : null;

    const db = createDb(c.env.DB);
    const source = await resolveSource(db, pkg, ecosystem);

    if (!source) {
      return c.json({
        status: "unknown" as const,
        package: pkg,
        ecosystem,
        from,
        to,
        source: null,
        entries: [],
        count: 0,
        truncated: false,
      });
    }

    // Bound the version range in SQL when both ends parse to a versionSort key
    // (the common numeric-version path) so we use idx_releases_source_version_sort
    // instead of loading the source's entire history and filtering in JS — for
    // prolific sources (Node, Kubernetes) that was thousands of rows to return a
    // handful (#1800 finding 7). resolveUpgradeRange re-applies the identical
    // (fromSort, toSort] predicate below, so this only narrows the rows scanned,
    // never the result. The date-bounded fallback (a non-numeric bound like a
    // codename) still needs the full set to anchor on the from/to releases.
    const fromSort = computeVersionSort(from);
    const toSort = computeVersionSort(to);
    const versionBounded = fromSort !== null && toSort !== null;

    const conditions = [
      eq(releases.sourceId, source.sourceId),
      eq(releases.suppressed, false),
      isNull(releaseCoverage.coverageId),
    ];
    if (fromSort !== null && toSort !== null) {
      conditions.push(
        isNotNull(releases.versionSort),
        gt(releases.versionSort, fromSort),
        lte(releases.versionSort, toSort),
      );
    }

    const rowsQuery = db
      .select({
        id: releases.id,
        version: releases.version,
        versionSort: releases.versionSort,
        publishedAt: releases.publishedAt,
        title: releases.title,
        titleGenerated: releases.titleGenerated,
        titleShort: releases.titleShort,
        summary: releases.summary,
        breaking: releases.breaking,
        migrationNotes: releases.migrationNotes,
        url: releases.url,
      })
      .from(releases)
      .leftJoin(releaseCoverage, eq(releaseCoverage.coverageId, releases.id))
      .where(and(...conditions))
      .$dynamic();
    // The index provides ascending versionSort order on the bounded path.
    const rows = versionBounded
      ? await rowsQuery.orderBy(asc(releases.versionSort))
      : await rowsQuery;

    const inRange = resolveUpgradeRange(rows, { from, to });

    // Token-budget the summaries: keep newest entries (closest to `to`, the most
    // upgrade-relevant) while under budget; drop the oldest tail if it overflows.
    let spent = 0;
    let truncated = false;
    const kept: typeof inRange = [];
    for (let i = inRange.length - 1; i >= 0; i--) {
      const r = inRange[i];
      const text = r.summary ?? r.titleGenerated ?? r.title ?? "";
      const cost = Math.max(estimateTokens(text), MIN_ENTRY_TOKEN_COST);
      if ((spent + cost > TOKEN_BUDGET && kept.length > 0) || kept.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      spent += cost;
      kept.push(r);
    }
    kept.reverse(); // back to ascending (oldest→newest)

    const webBase = releaseWebBase(c.env);

    return c.json({
      status: "resolved" as const,
      package: pkg,
      ecosystem,
      from,
      to,
      source,
      entries: kept.map((r) => ({
        version: r.version,
        publishedAt: r.publishedAt,
        title: r.titleGenerated ?? r.title,
        summary: r.summary,
        breaking: r.breaking,
        migrationNotes: r.migrationNotes,
        url: r.url,
        webUrl: releaseWebUrl(webBase, r),
      })),
      count: kept.length,
      truncated,
      ...(truncated ? { truncatedAtTokens: TOKEN_BUDGET } : {}),
    });
  },
);
